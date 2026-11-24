/**
 * Slice 5.6: statutory remittances (docs/PHASE_5.md 5.6, open question 13) against the real
 * database.
 * - Approval makes one remittance per kind and authority with an amount above 0, summed from the
 *   payslip lines; pension is due 7 working days after the pay date, skipping weekends and the
 *   company's public holidays; PAYE, NHF, NSITF and ITF only when the company set its own day.
 * - Who reads (owner, hr, finance) and who records (the same, in a trusted session); line
 *   managers, admins, workers and other companies see and do nothing.
 * - Insert-only (rule 4): remittances, receipts and payments refuse updates, deletes and truncate
 *   for signed-in roles, the secret key and the database owner, even in replica mode; an insert
 *   that isn't what the payslips owe is refused (MLSR7).
 * - A payment is recorded once (MLSR1), with a receipt the recorder checked themselves (MLSR2);
 *   a wrong one is voided with a reason (once, MLSR4), and then a new one may be recorded.
 * - Receipts: recorded only with the secret key, only for an object in the private bucket at the
 *   receipt's own path with the size checked (MLSR5). Signed-in users can't read, list or write
 *   either payroll bucket, their own company's paths included.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptPiiForDb } from "@/server/crypto/pii";
import { MutationError, runMutation } from "@/server/identity/mutate";
import {
  recordPaymentSpec,
  scheduleFileSpec,
  startReceiptSpec,
} from "@/server/payroll/remittances";
import type { Database } from "@/types/db";

import { OCT_START } from "./helpers/payroll";
import {
  EVIDENCE_BUCKET,
  FILES_BUCKET,
  RECEIPT_PDF,
  approveRun,
  seedReceipt,
  seedSubmittedRun,
} from "./helpers/statutory";
import {
  adminClient,
  createTenantUser,
  createTestUser,
  loadLocalEnv,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const DENIED = "42501";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let finance: TestUser;
let adminRole: TestUser;
let lineManager: TestUser;
let workerUser: TestUser;
let runId: string;
const rem: Record<string, string> = {};

async function addMember(user: TestUser, role: Role, orgId: string, workerId?: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId ?? null });
  expect(error).toBeNull();
}

const record = (
  by: TestUser,
  remittanceId: string,
  receiptId: string,
  over: { paidOn?: string; amount?: string; reference?: string; differs?: boolean } = {},
) =>
  by.client.rpc("record_statutory_payment", {
    p_organisation_id: owner.orgId,
    p_remittance_id: remittanceId,
    p_receipt_id: receiptId,
    p_paid_on: over.paidOn ?? "2026-10-30",
    p_paid_amount_kobo: over.amount ?? "2160000",
    p_reference: over.reference ?? "PFA-REF-1",
    p_amount_differs: over.differs ?? false,
  });

const RSA_PIN = "PEN100012345678";

const ctxOf = (user: TestUser, role: Role) => ({
  supabase: user.client,
  userId: user.id,
  organisationId: owner.orgId,
  role,
});

beforeAll(async () => {
  // The server modules read these (the admin client and the RSA PIN's decryption).
  const env = loadLocalEnv();
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.publishableKey;
  process.env.SUPABASE_SECRET_KEY = env.secretKey;
  process.env.PII_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("stat-owner", "Statutory Org");
  other = await createTenantUser("stat-other", "Other Statutory Org");
  hr = await createTestUser("stat-hr", "Oluwaseun Adeyemi");
  finance = await createTestUser("stat-fin", "Adaeze Okafor");
  adminRole = await createTestUser("stat-admin");
  lineManager = await createTestUser("stat-lm");
  workerUser = await createTestUser("stat-worker");
  await addMember(hr, "hr", owner.orgId);
  await addMember(finance, "finance", owner.orgId);
  await addMember(adminRole, "admin", owner.orgId);
  await addMember(lineManager, "line_manager", owner.orgId);

  // The company's own holiday falls in pension's 7 working days; HR sets PAYE's due day.
  const holiday = await admin.from("public_holidays").insert({
    organisation_id: owner.orgId,
    holiday_date: "2026-10-28",
    name: "Company day",
  });
  expect(holiday.error).toBeNull();
  const days = await hr.client.rpc("set_remittance_due_days", {
    p_organisation_id: owner.orgId,
    p_paye: 10,
  });
  expect(days.error).toBeNull();

  // The worker's RSA PIN, sealed for its own row (the id is chosen first), and a TIN.
  const workerId = randomUUID();
  const seeded = await seedSubmittedRun(admin, owner, {
    workerExtra: {
      id: workerId,
      tin: "12345678-0001",
      rsa_pin_enc: encryptPiiForDb(RSA_PIN, {
        organisationId: owner.orgId,
        table: "workers",
        column: "rsa_pin_enc",
        rowId: workerId,
      }),
      rsa_pin_last4: "5678",
    },
  });
  runId = seeded.runId;
  await addMember(workerUser, "worker", owner.orgId, seeded.workerId);
  await approveRun(admin, owner.orgId, runId, finance);
  const { data } = await admin.from("statutory_remittances").select("id, kind").eq("run_id", runId);
  for (const r of data ?? []) rem[r.kind] = r.id;
});

afterAll(async () => {
  await db?.end();
});

describe("made at approval", () => {
  it("owes one remittance per kind and authority, summed from the payslip lines", async () => {
    const { data, error } = await admin
      .from("statutory_remittances")
      .select(
        "kind, authority_key, authority_name, authority_variants, amount_kobo::text, worker_count, currency, due_date",
      )
      .eq("run_id", runId)
      .order("kind");
    expect(error).toBeNull();
    expect(data).toEqual([
      // Pension: Sunday 25 Oct rolls back to Friday 23 Oct, day 1 of 7; Wednesday 28 Oct is a
      // company holiday, so the 7th working day is Tuesday 3 Nov (money review M3).
      {
        kind: "nsitf",
        authority_key: null,
        authority_name: null,
        authority_variants: [],
        amount_kobo: "120000",
        worker_count: 1,
        currency: "NGN",
        due_date: null,
      },
      {
        kind: "paye",
        authority_key: "lagos",
        authority_name: "Lagos",
        authority_variants: ["Lagos"],
        amount_kobo: "100000",
        worker_count: 1,
        currency: "NGN",
        due_date: "2026-11-10",
      },
      {
        kind: "pension",
        authority_key: "stanbic ibtc pensions",
        authority_name: "Stanbic IBTC Pensions",
        authority_variants: ["Stanbic IBTC Pensions"],
        amount_kobo: "2160000",
        worker_count: 1,
        currency: "NGN",
        due_date: "2026-11-03",
      },
    ]);
  });

  it("makes nothing for a run that isn't approved", async () => {
    const o = await createTenantUser("stat-draft", "Statutory Draft Org");
    const { runId: draft } = await seedSubmittedRun(admin, o);
    const { count } = await admin
      .from("statutory_remittances")
      .select("id", { count: "exact", head: true })
      .eq("run_id", draft);
    expect(count).toBe(0);
    // Not even the database owner can add one for a run in review.
    await expect(
      db.query(
        `insert into public.statutory_remittances (organisation_id, run_id, kind, amount_kobo, worker_count)
         values ($1, $2, 'nsitf', 120000, 1)`,
        [o.orgId, draft],
      ),
    ).rejects.toMatchObject({ code: "MLSR7" });
  });

  it("refuses the database owner an amount the payslips don't owe", async () => {
    await expect(
      db.query(
        `insert into public.statutory_remittances (organisation_id, run_id, kind, amount_kobo, worker_count)
         values ($1, $2, 'itf', 1, 1)`,
        [owner.orgId, runId],
      ),
    ).rejects.toMatchObject({ code: "MLSR7" });
  });
});

describe("who reads", () => {
  it("lets owner, hr and finance read, and nobody else", async () => {
    for (const by of [owner, hr, finance]) {
      const { data } = await by.client
        .from("statutory_remittances")
        .select("id")
        .eq("run_id", runId);
      expect(data, by.email).toHaveLength(3);
    }
    for (const by of [adminRole, lineManager, workerUser, other]) {
      for (const table of [
        "statutory_remittances",
        "statutory_receipts",
        "statutory_payments",
      ] as const) {
        const { data } = await by.client
          .from(table)
          .select("id")
          .eq("organisation_id", owner.orgId);
        expect(data ?? [], `${by.email} ${table}`).toEqual([]);
      }
    }
  });
});

describe("due days (open question 13)", () => {
  it("lets owner and hr set them, within 1 to 28", async () => {
    const set = (by: TestUser, paye: number) =>
      by.client.rpc("set_remittance_due_days", { p_organisation_id: owner.orgId, p_paye: paye });
    expect((await set(finance, 10)).error?.code).toBe(DENIED);
    expect((await set(lineManager, 10)).error?.code).toBe(DENIED);
    expect((await set(adminRole, 10)).error?.code).toBe(DENIED);
    expect((await set(other, 10)).error?.code).toBe(DENIED);
    expect((await set(hr, 29)).error?.code).toBe("22023");
    expect((await set(hr, 0)).error?.code).toBe("22023");
    expect((await set(owner, 10)).error).toBeNull();
    const { data } = await admin
      .from("organisations")
      .select("paye_remit_day, nhf_remit_day, nsitf_remit_day, itf_remit_day")
      .eq("id", owner.orgId)
      .single();
    expect(data).toEqual({
      paye_remit_day: 10,
      nhf_remit_day: null,
      nsitf_remit_day: null,
      itf_remit_day: null,
    });
  });
});

describe("receipts", () => {
  it("are recorded only with the secret key, for an object really in the bucket", async () => {
    const args = {
      p_organisation_id: owner.orgId,
      p_remittance_id: rem.pension!,
      p_receipt_id: randomUUID(),
      p_actor: hr.id,
      p_file_ext: "pdf",
      p_size_bytes: RECEIPT_PDF.length,
      p_sha256: "a".repeat(64),
    };
    // Signed-in users can't call it, whoever they name.
    expect((await hr.client.rpc("record_statutory_receipt", args)).error?.code).toBe(DENIED);
    // Nothing uploaded at that path.
    expect((await admin.rpc("record_statutory_receipt", args)).error?.code).toBe("MLSR5");
    // An actor who isn't owner, hr or finance.
    const lm = await seedReceipt(admin, owner.orgId, rem.pension!, lineManager.id);
    expect(lm.error?.code).toBe(DENIED);
    // A size that doesn't match the object.
    const path = `${owner.orgId}/${rem.pension}/${args.p_receipt_id}.pdf`;
    expect(
      (
        await admin.storage
          .from(EVIDENCE_BUCKET)
          .upload(path, RECEIPT_PDF, { contentType: "application/pdf" })
      ).error,
    ).toBeNull();
    expect(
      (await admin.rpc("record_statutory_receipt", { ...args, p_size_bytes: 3 })).error?.code,
    ).toBe("MLSR5");
    // Another company's remittance.
    const theirs = await seedReceipt(admin, other.orgId, rem.pension!, hr.id);
    expect(theirs.error?.code).toBe(DENIED);
  });
});

describe("payments: once, with a receipt, voided with a reason", () => {
  let paymentId: string;

  it("records hr's payment with hr's own receipt, once", async () => {
    const mine = await seedReceipt(admin, owner.orgId, rem.pension!, hr.id);
    expect(mine.error).toBeNull();
    // Finance can't use a receipt hr checked.
    expect((await record(finance, rem.pension!, mine.receiptId)).error?.code).toBe("MLSR2");
    // A date in the future, or before the period, and a 0 amount, are refused.
    expect(
      (await record(hr, rem.pension!, mine.receiptId, { paidOn: "2099-01-01" })).error?.code,
    ).toBe("MLSR3");
    expect(
      (await record(hr, rem.pension!, mine.receiptId, { paidOn: "2026-09-01" })).error?.code,
    ).toBe("MLSR3");
    expect((await record(hr, rem.pension!, mine.receiptId, { amount: "0" })).error?.code).toBe(
      "MLSR3",
    );
    // A receipt of another remittance.
    expect((await record(hr, rem.paye!, mine.receiptId)).error?.code).toBe("MLSR2");
    // Roles that don't record.
    for (const by of [lineManager, adminRole, workerUser]) {
      expect((await record(by, rem.pension!, mine.receiptId)).error?.code, by.email).toBe(DENIED);
    }

    const done = await record(hr, rem.pension!, mine.receiptId, { paidOn: OCT_START });
    expect(done.error).toBeNull();
    paymentId = done.data!;

    // The same receipt again, and a second payment with a fresh receipt.
    expect((await record(hr, rem.pension!, mine.receiptId)).error?.code).toBe("MLSR2");
    const again = await seedReceipt(admin, owner.orgId, rem.pension!, hr.id);
    expect((await record(hr, rem.pension!, again.receiptId)).error?.code).toBe("MLSR1");

    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, after")
      .eq("organisation_id", owner.orgId)
      .eq("action", "payroll.remittance_paid");
    expect(audit).toHaveLength(1);
    expect(audit![0]!.actor_id).toBe(hr.id);
    expect(audit![0]!.after).toMatchObject({ payment_id: paymentId, paid_amount_kobo: "2160000" });
  });

  it("voids it once with a reason, then takes the right one", async () => {
    const voidIt = (by: TestUser, reason: string) =>
      by.client.rpc("void_statutory_payment", {
        p_organisation_id: owner.orgId,
        p_payment_id: paymentId,
        p_reason: reason,
      });
    expect((await voidIt(lineManager, "Wrong amount")).error?.code).toBe(DENIED);
    expect((await voidIt(finance, "  ")).error?.code).toBe("22023");
    expect((await voidIt(finance, "Wrong amount: the bank took ₦21,500")).error).toBeNull();
    expect((await voidIt(finance, "Again")).error?.code).toBe("MLSR4");

    // A short or over payment needs the person to confirm it differs (money review H1).
    const fresh = await seedReceipt(admin, owner.orgId, rem.pension!, finance.id);
    const short = await record(finance, rem.pension!, fresh.receiptId, { amount: "2150000" });
    expect(short.error?.code).toBe("MLSR8");
    const over = await record(finance, rem.pension!, fresh.receiptId, { amount: "2170000" });
    expect(over.error?.code).toBe("MLSR8");
    const right = await record(finance, rem.pension!, fresh.receiptId, {
      amount: "2150000",
      differs: true,
    });
    expect(right.error).toBeNull();
    const { data: audit } = await admin
      .from("audit_log")
      .select("after")
      .eq("organisation_id", owner.orgId)
      .eq("action", "payroll.remittance_paid")
      .eq("actor_id", finance.id);
    expect(audit![0]!.after).toMatchObject({
      payment_id: right.data,
      amount_differs: true,
      difference_kobo: "-10000",
    });

    const { data: rows } = await finance.client
      .from("statutory_payments")
      .select("entry, voids_payment_id, reason, paid_amount_kobo")
      .eq("remittance_id", rem.pension!)
      .order("created_at");
    expect(rows).toEqual([
      { entry: "payment", voids_payment_id: null, reason: null, paid_amount_kobo: 2160000 },
      {
        entry: "void",
        voids_payment_id: paymentId,
        reason: "Wrong amount: the bank took ₦21,500",
        paid_amount_kobo: null,
      },
      { entry: "payment", voids_payment_id: null, reason: null, paid_amount_kobo: 2150000 },
    ]);
  });
});

describe("insert-only (rule 4)", () => {
  it("refuses signed-in roles and the secret key any direct write", async () => {
    for (const by of [owner.client, hr.client, finance.client, admin]) {
      for (const table of [
        "statutory_remittances",
        "statutory_receipts",
        "statutory_payments",
      ] as const) {
        const upd = await by
          .from(table)
          .update({ created_at: new Date().toISOString() })
          .eq("organisation_id", owner.orgId);
        expect(upd.error?.code, table).toBe(DENIED);
        const del = await by.from(table).delete().eq("organisation_id", owner.orgId);
        expect(del.error?.code, table).toBe(DENIED);
      }
    }
  });

  it("refuses the database owner too, in replica mode, and truncate", async () => {
    const statements: [string, unknown[]][] = [
      ["update public.statutory_remittances set amount_kobo = 1 where run_id = $1", [runId]],
      ["update public.statutory_remittances set due_date = null where run_id = $1", [runId]],
      ["delete from public.statutory_remittances where run_id = $1", [runId]],
      [
        "update public.statutory_receipts set sha256 = repeat('b', 64) where organisation_id = $1",
        [owner.orgId],
      ],
      ["delete from public.statutory_receipts where organisation_id = $1", [owner.orgId]],
      [
        "update public.statutory_payments set paid_amount_kobo = 1 where organisation_id = $1",
        [owner.orgId],
      ],
      ["delete from public.statutory_payments where organisation_id = $1", [owner.orgId]],
    ];
    for (const [sql, params] of statements) {
      await expect(db.query(sql, params), sql).rejects.toMatchObject({ code: "MLSR6" });
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await expect(db.query(sql, params), `replica: ${sql}`).rejects.toMatchObject({
          code: "MLSR6",
        });
      } finally {
        await db.query("rollback");
      }
    }
    for (const table of ["statutory_payments", "statutory_receipts", "statutory_remittances"]) {
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await expect(db.query(`truncate public.${table} cascade`)).rejects.toMatchObject({
          code: "MLSR6",
        });
      } finally {
        await db.query("rollback");
      }
    }
    // A second payment as the database owner still meets the guard.
    await expect(
      db.query(
        `insert into public.statutory_payments (organisation_id, remittance_id, entry, paid_on,
           paid_amount_kobo, receipt_id, recorded_by)
         select organisation_id, remittance_id, 'payment', current_date, 1, id, checked_by
         from public.statutory_receipts where remittance_id = $1 limit 1`,
        [rem.pension],
      ),
    ).rejects.toMatchObject({ code: "MLSR1" });
  });
});

describe("through the server (src/server/payroll/remittances.ts)", () => {
  it("makes the pension schedule with the RSA PIN decrypted, behind a link, audited by id", async () => {
    await expect(
      runMutation(ctxOf(lineManager, "line_manager"), scheduleFileSpec, {
        remittanceId: rem.pension,
      }),
    ).rejects.toBeInstanceOf(MutationError);

    const file = await runMutation(ctxOf(finance, "finance"), scheduleFileSpec, {
      remittanceId: rem.pension,
    });
    expect(file.fileName).toBe("pension-to-stanbic-ibtc-pensions-2026-10.csv");
    const res = new Response(file.bytes as BodyInit);
    const text = (await res.text()).replace(/^﻿/, "");
    const lines = text.split(/\r\n/);
    expect(lines[0]).toBe("Staff ID,Name,RSA PIN,Employee (NGN),Employer (NGN),Total (NGN)");
    expect(lines[1]).toMatch(
      new RegExp(`^PR-[0-9a-f]{8},Musa Ibrahim,${RSA_PIN},9600.00,12000.00,21600.00$`),
    );
    expect(lines[2]).toBe("Total,1 worker,,9600.00,12000.00,21600.00");

    // The PAYE schedule names the TIN.
    const paye = await runMutation(ctxOf(hr, "hr"), scheduleFileSpec, { remittanceId: rem.paye });
    expect(new TextDecoder().decode(paye.bytes)).toContain(
      ",Musa Ibrahim,12345678-0001,120000.00,",
    );

    // Audited by id only: no PIN, no link, no file contents.
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, entity, entity_id, before, after")
      .eq("organisation_id", owner.orgId)
      .eq("action", "payroll.schedule_downloaded")
      .eq("entity_id", rem.pension!);
    expect(audit).toHaveLength(1);
    expect(audit![0]).toMatchObject({ actor_id: finance.id, entity: "statutory_remittances" });
    expect(JSON.stringify(audit)).not.toContain(RSA_PIN);
    expect(JSON.stringify(audit)).not.toContain("token");

    // Nothing is stored (security review M1): payroll-files holds nothing of this company's.
    const { rows: stored } = await db.query(
      "select count(*)::int as n from storage.objects where bucket_id = 'payroll-files' and name like $1",
      [`${owner.orgId}/%`],
    );
    expect(stored[0]!.n).toBe(0);
  });

  it("records a payment: the receipt goes to its signed path and is checked by its bytes", async () => {
    // A file named .pdf that isn't one is refused and deleted.
    const payment = {
      remittanceId: rem.nsitf,
      paidOn: "2026-10-30",
      amount: "1,200",
      reference: "NSITF-OCT",
      amountDiffers: false,
    };
    // The details are checked before any upload starts (money review L5).
    await expect(
      runMutation(ctxOf(hr, "hr"), startReceiptSpec, {
        ...payment,
        amount: "1,000",
        fileName: "receipt.pdf",
        size: 5,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runMutation(ctxOf(hr, "hr"), startReceiptSpec, {
        ...payment,
        paidOn: "2099-01-01",
        fileName: "receipt.pdf",
        size: 5,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    const fake = await runMutation(ctxOf(hr, "hr"), startReceiptSpec, {
      ...payment,
      fileName: "receipt.pdf",
      size: 5,
    });
    expect(fake.path).toBe(`${owner.orgId}/${rem.nsitf}/${fake.receiptId}.pdf`);
    expect(
      (
        await hr.client.storage
          .from(EVIDENCE_BUCKET)
          .uploadToSignedUrl(fake.path, fake.token, Buffer.from("hello"), {
            contentType: "application/pdf",
          })
      ).error,
    ).toBeNull();
    await expect(
      runMutation(ctxOf(hr, "hr"), recordPaymentSpec, {
        ...payment,
        fileExt: "pdf",
        receiptId: fake.receiptId,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect((await admin.storage.from(EVIDENCE_BUCKET).download(fake.path)).data).toBeNull();

    // A real PDF is checked, recorded with the secret key naming hr, then paid as hr.
    const real = await runMutation(ctxOf(hr, "hr"), startReceiptSpec, {
      ...payment,
      fileName: "NSITF receipt.PDF",
      size: RECEIPT_PDF.length,
    });
    expect(
      (
        await hr.client.storage
          .from(EVIDENCE_BUCKET)
          .uploadToSignedUrl(real.path, real.token, RECEIPT_PDF, { contentType: "application/pdf" })
      ).error,
    ).toBeNull();
    const paid = await runMutation(ctxOf(hr, "hr"), recordPaymentSpec, {
      ...payment,
      fileExt: "pdf",
      receiptId: real.receiptId,
    });
    const { data: row } = await admin
      .from("statutory_payments")
      .select("paid_amount_kobo, reference, recorded_by, receipt_id")
      .eq("id", paid.paymentId)
      .single();
    expect(row).toEqual({
      paid_amount_kobo: 120000,
      reference: "NSITF-OCT",
      recorded_by: hr.id,
      receipt_id: real.receiptId,
    });
    const { data: receipt } = await admin
      .from("statutory_receipts")
      .select("checked_by, size_bytes, mime_type")
      .eq("id", real.receiptId)
      .single();
    expect(receipt).toEqual({
      checked_by: hr.id,
      size_bytes: RECEIPT_PDF.length,
      mime_type: "application/pdf",
    });
    // Paid now: no second upload is even started.
    await expect(
      runMutation(ctxOf(finance, "finance"), startReceiptSpec, {
        ...payment,
        fileName: "again.pdf",
        size: 10,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("the private buckets", () => {
  it("refuse signed-in users reads, lists and writes, their own company's paths included", async () => {
    const { data: receipt } = await admin
      .from("statutory_receipts")
      .select("storage_path")
      .eq("organisation_id", owner.orgId)
      .limit(1)
      .single();
    const path = receipt!.storage_path;
    // The secret key reads it (the server's path).
    expect((await admin.storage.from(EVIDENCE_BUCKET).download(path)).error).toBeNull();
    for (const by of [owner, hr, finance, lineManager, other]) {
      const bucket = by.client.storage.from(EVIDENCE_BUCKET);
      expect((await bucket.download(path)).data, by.email).toBeNull();
      expect((await bucket.createSignedUrl(path, 60)).data, by.email).toBeNull();
      const { data: listed } = await bucket.list(owner.orgId);
      expect(listed ?? [], by.email).toEqual([]);
      const write = await bucket.upload(
        `${owner.orgId}/${rem.paye}/${randomUUID()}.pdf`,
        RECEIPT_PDF,
        {
          contentType: "application/pdf",
        },
      );
      expect(write.error, by.email).not.toBeNull();
      const csv = await by.client.storage
        .from(FILES_BUCKET)
        .upload(`${owner.orgId}/${runId}/schedules/${rem.paye}.csv`, Buffer.from("a,b\r\n"), {
          contentType: "text/csv",
        });
      expect(csv.error, by.email).not.toBeNull();
    }
  });

  it("are private and have no storage policy at all (security review M1, L1)", async () => {
    const { rows: buckets } = await db.query<{ id: string; public: boolean }>(
      "select id, public from storage.buckets where id in ('payroll-files', 'payroll-evidence') order by id",
    );
    expect(buckets).toEqual([
      { id: "payroll-evidence", public: false },
      { id: "payroll-files", public: false },
    ]);
    const { rows: policies } = await db.query<{ policyname: string }>(
      `select policyname from pg_policies
       where schemaname = 'storage'
         and (coalesce(qual, '') ilike any (array['%payroll-files%', '%payroll-evidence%'])
           or coalesce(with_check, '') ilike any (array['%payroll-files%', '%payroll-evidence%']))`,
    );
    expect(policies).toEqual([]);
  });

  it("sweeps uploads with no receipt after two hours, through the secret key only (L2)", async () => {
    const args = { p_older_than_minutes: 120, p_limit: 500 };
    expect((await owner.client.rpc("orphan_statutory_receipt_objects", args)).error?.code).toBe(
      DENIED,
    );
    expect(
      (await admin.rpc("orphan_statutory_receipt_objects", { ...args, p_older_than_minutes: 5 }))
        .error?.code,
    ).toBe("22023");
    // An upload nobody recorded, made to look three hours old; and a recorded receipt as old.
    const orphan = `${owner.orgId}/${rem.paye}/${randomUUID()}.pdf`;
    expect(
      (
        await admin.storage
          .from(EVIDENCE_BUCKET)
          .upload(orphan, RECEIPT_PDF, { contentType: "application/pdf" })
      ).error,
    ).toBeNull();
    const { data: kept } = await admin
      .from("statutory_receipts")
      .select("storage_path")
      .eq("organisation_id", owner.orgId)
      .limit(1)
      .single();
    await db.query(
      "update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'payroll-evidence' and name = any($1)",
      [[orphan, kept!.storage_path]],
    );
    const { data: due, error } = await admin.rpc("orphan_statutory_receipt_objects", args);
    expect(error).toBeNull();
    expect(due).toContain(orphan);
    expect(due).not.toContain(kept!.storage_path);
  });

  it("audits receipts once, with the person (security review L3)", async () => {
    const { data } = await admin
      .from("audit_log")
      .select("action, actor_id")
      .eq("organisation_id", owner.orgId)
      .in("action", ["statutory_receipts.insert", "payroll.remittance_receipt_checked"]);
    expect(data!.some((a) => a.action === "statutory_receipts.insert")).toBe(false);
    expect(data!.every((a) => a.actor_id !== null)).toBe(true);
    expect(data!.length).toBeGreaterThan(0);
  });
});
