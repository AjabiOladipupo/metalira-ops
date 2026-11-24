/**
 * Slice 5.7c: supplementary payout files (carried from 5.4) against the real database.
 * - A released run's bank file left a worker out (no bank details, acknowledged by HR); the
 *   worker is outstanding in `payout_supplement_plan` (owner or finance; hr 42501), not ready
 *   until their details are in force; a file with nobody ready is refused (MLAR3).
 * - Once ready, the server's two steps make the supplementary file: stored at
 *   {org}/{run}/supplementary/{id}.csv with the secret key, then `make_payout_supplement` as the
 *   user, whose items must be exactly the ready rows (MLAR3), stored at that size (MLAR4).
 * - A second file needs a reason (MLAR5) and, once the first was downloaded, the not-uploaded
 *   statement (MLAR6); it voids the first and its items.
 * - Confirmation names the file by id and SHA-256 (MLAR7), never by its maker (MLAR8) or anyone who
 *   prepared the run (MLAR9), and only after a download (MLARA); a retry returns the id. A paid
 *   payslip is then out of the plan: paid once across the original and supplementary files.
 * - Supplementary files and items are insert-only but the moves the functions make, for the
 *   secret key and the database owner too (replica mode included); a confirmed file's download
 *   needs a reason (MLARB); the sweep finds an orphan at the supplementary path.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database, Json } from "@/types/db";

import {
  approveRun,
  BUCKET,
  download,
  giveBankDetails,
  makeBatch,
  NET,
  payAll,
  release,
  seedSubmittedRun,
  type PlanRow,
  type SeededPayrollRun,
} from "./helpers/payout";
import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const DENIED = "42501";
const SHA = "d".repeat(64);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let finance: TestUser;
let finance2: TestUser;
let run: SeededPayrollRun;
let ada: SeededPayrollRun["workers"][number];
let musa: SeededPayrollRun["workers"][number];

async function addMember(user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function asDbOwner(sql: string, params: unknown[], replica = false) {
  await db.query("begin");
  try {
    if (replica) await db.query("set local session_replication_role = replica");
    const result = await db.query(sql, params);
    await db.query("commit");
    return { error: null as null | { code?: string; message: string }, result };
  } catch (error) {
    await db.query("rollback");
    return { error: error as { code?: string; message: string }, result: null };
  }
}

interface SupplementPlanRow {
  payslip_id: string;
  net_kobo: string;
  bank_name: string | null;
  bank_code: string | null;
  account_name: string | null;
  bank_account_last4: string | null;
  bank_detail_change_id: string | null;
  ready: boolean;
  original_item_id: string;
}

const readPlan = (client: Client) =>
  client.rpc("payout_supplement_plan", {
    p_organisation_id: owner.orgId,
    p_run_id: run.runId,
    p_with_ciphertext: false,
  });

const itemsOf = (rows: SupplementPlanRow[]) =>
  rows
    .filter((r) => r.ready)
    .map((r, i) => ({
      payslip_id: r.payslip_id,
      position: i + 1,
      bank_name: r.bank_name,
      bank_code: r.bank_code,
      account_name: r.account_name,
      bank_account_last4: r.bank_account_last4,
      bank_detail_change_id: r.bank_detail_change_id,
      amount_kobo: r.net_kobo,
    }));

/** The server's two steps: store the file (secret key), then record it as `by`. */
async function makeSupplement(
  by: Client,
  options: {
    items?: (rows: SupplementPlanRow[]) => unknown[];
    voidReason?: string;
    notUploaded?: boolean;
    store?: boolean;
    bytes?: number;
  } = {},
) {
  const id = randomUUID();
  const plan = await readPlan(owner.client);
  expect(plan.error).toBeNull();
  const rows = (plan.data ?? []) as unknown as SupplementPlanRow[];
  const path = `${owner.orgId}/${run.runId}/supplementary/${id}.csv`;
  const body = Buffer.from("Beneficiary name,Account number\r\nADA OBI,0123456789\r\n", "utf8");
  if (options.store !== false) {
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, body, { contentType: "text/csv", upsert: false });
    expect(error).toBeNull();
  }
  const result = await by.rpc("make_payout_supplement", {
    p_organisation_id: owner.orgId,
    p_run_id: run.runId,
    p_supplement_id: id,
    p_bank_format: "generic-csv",
    p_file_sha256: SHA,
    p_file_bytes: options.bytes ?? body.byteLength,
    p_items: (options.items ? options.items(rows) : itemsOf(rows)) as Json,
    ...(options.voidReason ? { p_void_reason: options.voidReason } : {}),
    ...(options.notUploaded ? { p_not_uploaded: true } : {}),
  });
  return { ...result, id, path };
}

const confirm = (by: Client, id: string, sha = SHA) =>
  by.rpc("confirm_payout_supplement", {
    p_organisation_id: owner.orgId,
    p_supplement_id: id,
    p_file_sha256: sha,
  });

const downloadSupplement = (by: Client, id: string, reason?: string) =>
  by.rpc("payout_supplement_download", {
    p_organisation_id: owner.orgId,
    p_supplement_id: id,
    ...(reason ? { p_reason: reason } : {}),
  });

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("psupp-owner", "Supplementary Payout Org");
  hr = await createTestUser("psupp-hr");
  finance = await createTestUser("psupp-fin");
  finance2 = await createTestUser("psupp-fin2");
  await addMember(hr, "hr");
  await addMember(finance, "finance");
  await addMember(finance2, "finance");
  // October: Musa paid by the bank file; Ada left out (no bank details, acknowledged by HR).
  run = await seedSubmittedRun(admin, owner, {
    count: 2,
    names: ["Musa Ibrahim", "Ada Obi"],
    anomalies: (ids) => [
      { worker_id: ids[1], code: "bank_missing", severity: "warning", detail: {} },
    ],
  });
  musa = run.workers[0]!;
  ada = run.workers[1]!;
  await giveBankDetails(admin, owner.orgId, ada.workerId, {
    bank_name: null,
    account_name: null,
    bank_account_enc: null,
    bank_account_last4: null,
    bank_code: null,
  });
  await approveRun(admin, owner.orgId, run.runId, finance);
  const items = (plan: PlanRow[]) => {
    const paid = plan.filter((r) => r.payslip_id !== ada.payslipId);
    return [
      ...payAll(paid),
      {
        payslip_id: ada.payslipId,
        position: paid.length + 1,
        status: "left_out",
        left_out_reason: "no_bank_details",
        amount_kobo: "0",
      },
    ];
  };
  const made = await makeBatch(admin, owner.client, owner.orgId, run.runId, { items });
  expect(made.error).toBeNull();
  expect((await download(owner.client, owner.orgId, made.batchId)).error).toBeNull();
  expect((await release(finance.client, owner.orgId, run.runId, made.batchId)).error).toBeNull();
});

afterAll(async () => {
  await db?.end();
});

describe("outstanding workers of a released run", () => {
  it("lists the left-out worker, not ready without details; hr can't read the plan", async () => {
    const plan = await readPlan(finance.client);
    expect(plan.error).toBeNull();
    const rows = (plan.data ?? []) as unknown as SupplementPlanRow[];
    expect(rows.map((r) => [r.payslip_id, r.net_kobo, r.ready])).toEqual([
      [ada.payslipId, String(NET), false],
    ]);
    expect(rows.some((r) => r.payslip_id === musa.payslipId)).toBe(false);
    expect((await readPlan(hr.client)).error?.code).toBe(DENIED);
    const cipher = await finance.client.rpc("payout_supplement_plan", {
      p_organisation_id: owner.orgId,
      p_run_id: run.runId,
      p_with_ciphertext: true,
    });
    expect(cipher.error?.code).toBe(DENIED);
  });

  it("refuses a supplementary file while nobody is ready", async () => {
    const made = await makeSupplement(finance.client, { items: () => [] });
    expect(made.error?.code).toBe("MLAR3");
  });
});

describe("making, downloading and confirming a supplementary file", () => {
  let first: string;
  let second: string;

  it("makes a file for exactly the ready worker, once their details are in force", async () => {
    await giveBankDetails(admin, owner.orgId, ada.workerId, { account_name: "ADA OBI" });
    const plan = await readPlan(finance.client);
    expect(((plan.data ?? []) as unknown as SupplementPlanRow[])[0]!.ready).toBe(true);

    // Musa, already paid by the run's file, can't be slipped in; nor a wrong amount.
    const extra = await makeSupplement(finance.client, {
      items: (rows) => [
        ...itemsOf(rows),
        { ...itemsOf(rows)[0], payslip_id: musa.payslipId, position: 2 },
      ],
    });
    expect(extra.error?.code).toBe("MLAR3");
    const wrong = await makeSupplement(finance.client, {
      items: (rows) => itemsOf(rows).map((i) => ({ ...i, amount_kobo: "1" })),
    });
    expect(wrong.error?.code).toBe("MLAR3");
    const unstored = await makeSupplement(finance.client, { store: false });
    expect(unstored.error?.code).toBe("MLAR4");
    // hr never makes one.
    expect((await makeSupplement(hr.client)).error?.code).toBe(DENIED);

    const made = await makeSupplement(finance.client);
    expect(made.error).toBeNull();
    expect(made.data).toMatchObject({ item_count: 1, total_kobo: String(NET) });
    first = made.id;
    const { data: items } = await hr.client
      .from("payout_supplement_items")
      .select("payslip_id, status, amount_kobo, bank_account_last4")
      .eq("supplement_id", first);
    expect(items).toEqual([
      {
        payslip_id: ada.payslipId,
        status: "pending",
        amount_kobo: NET,
        bank_account_last4: "6789",
      },
    ]);
    const { data: audit } = await admin
      .from("audit_log")
      .select("action")
      .eq("entity_id", first)
      .eq("action", "payroll.supplementary_file_made");
    expect(audit).toHaveLength(1);
  });

  it("replaces a waiting file only with a reason, and once downloaded only if it wasn't uploaded", async () => {
    expect((await makeSupplement(finance.client)).error?.code).toBe("MLAR5");
    expect((await downloadSupplement(finance.client, first)).error).toBeNull();
    const notStated = await makeSupplement(finance.client, { voidReason: "Wrong format chosen" });
    expect(notStated.error?.code).toBe("MLAR6");
    const replaced = await makeSupplement(finance.client, {
      voidReason: "Wrong format chosen",
      notUploaded: true,
    });
    expect(replaced.error).toBeNull();
    second = replaced.id;
    const { data: old } = await admin
      .from("payout_supplements")
      .select("status, void_reason")
      .eq("id", first)
      .single();
    expect(old!.status).toBe("voided");
    expect(old!.void_reason).toContain("not uploaded to the bank");
    const { data: oldItems } = await admin
      .from("payout_supplement_items")
      .select("status")
      .eq("supplement_id", first);
    expect(oldItems).toEqual([{ status: "voided" }]);
    expect((await downloadSupplement(finance.client, first)).error?.code).toBe("MLAR2");
  });

  it("confirms by a second person who didn't make it or prepare the run, after a download", async () => {
    // finance made it; the owner prepared the run; nobody downloaded the new file yet.
    expect((await confirm(finance.client, second)).error?.code).toBe("MLAR8");
    expect((await confirm(owner.client, second)).error?.code).toBe("MLAR9");
    expect((await confirm(finance2.client, second)).error?.code).toBe("MLARA");
    expect((await confirm(hr.client, second)).error?.code).toBe(DENIED);
    expect((await downloadSupplement(finance.client, second)).error).toBeNull();
    expect((await confirm(finance2.client, second, "e".repeat(64))).error?.code).toBe("MLAR7");
    const done = await confirm(finance2.client, second);
    expect(done.error).toBeNull();
    expect(done.data).toBe(second);
    // A retry returns the same file.
    expect((await confirm(finance2.client, second)).data).toBe(second);
    const { data: file } = await admin
      .from("payout_supplements")
      .select("status, confirmed_by")
      .eq("id", second)
      .single();
    expect(file).toEqual({ status: "confirmed", confirmed_by: finance2.id });
  });

  it("pays a payslip once: the paid worker leaves the plan and no further file can pay them", async () => {
    const plan = await readPlan(finance.client);
    expect(plan.data).toEqual([]);
    const again = await makeSupplement(finance.client, {
      items: () => [
        {
          payslip_id: ada.payslipId,
          position: 1,
          bank_name: "GTBank",
          bank_code: "058",
          account_name: "ADA OBI",
          bank_account_last4: "6789",
          bank_detail_change_id: null,
          amount_kobo: String(NET),
        },
      ],
    });
    expect(again.error?.code).toBe("MLAR3");
  });

  it("needs a reason to download a confirmed file again", async () => {
    expect((await downloadSupplement(finance.client, second)).error?.code).toBe("MLARB");
    expect(
      (await downloadSupplement(finance.client, second, "The bank asked for a copy")).error,
    ).toBeNull();
  });
});

describe("supplementary files are kept as written", () => {
  it("refuses changes and deletes for the secret key and the database owner, replica mode too", async () => {
    const { data: file } = await admin
      .from("payout_supplements")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("status", "confirmed")
      .single();
    const upd = await admin.from("payout_supplements").update({ total_kobo: 1 }).eq("id", file!.id);
    expect(upd.error).not.toBeNull();
    for (const sql of [
      "update public.payout_supplements set total_kobo = 1 where id = $1",
      "delete from public.payout_supplements where id = $1",
      "update public.payout_supplement_items set amount_kobo = 1 where supplement_id = $1",
      "delete from public.payout_supplement_items where supplement_id = $1",
    ]) {
      for (const replica of [false, true]) {
        const r = await asDbOwner(sql, [file!.id], replica);
        expect(r.error?.code, `${sql} replica=${replica}`).toBe("MLAR2");
      }
    }
    expect((await asDbOwner("truncate public.payout_supplement_items", [])).error).not.toBeNull();
    // Signed-in roles have no write grants at all.
    const direct = await finance.client
      .from("payout_supplements")
      .update({ void_reason: "x" })
      .eq("id", file!.id);
    expect(direct.error?.code).toBe(DENIED);
  });

  it("sweeps an orphan at the supplementary path after 15 minutes", async () => {
    const path = `${owner.orgId}/${run.runId}/supplementary/${randomUUID()}.csv`;
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, Buffer.from("x"), { contentType: "text/csv" });
    expect(error).toBeNull();
    await db.query(
      "update storage.objects set created_at = now() - interval '1 hour' where bucket_id = $1 and name = $2",
      [BUCKET, path],
    );
    const { data: due, error: dueError } = await admin.rpc("payroll_files_due", {
      p_organisation_id: owner.orgId,
    });
    expect(dueError).toBeNull();
    expect(due).toContainEqual({ organisation_id: owner.orgId, path, reason: "orphan" });
  });
});
