/**
 * Slice 5.7c: refunds and offsets of a payment made against a remittance 5.7a's reversal voided,
 * against the real database. October's PAYE (₦1,000 to Lagos) is paid with its receipt, then
 * October is reversed (two people); November owes Lagos PAYE ₦1,000 too.
 * - Only a standing payment on a voided remittance is resolved (MLARC); refunds need a receipt
 *   the recorder checked for that remittance (MLARG); refunds and offsets never exceed the payment
 *   (MLARD); an offset goes only to a later standing remittance to the same authority (MLARE) and
 *   never beyond what it still owes (MLARF).
 * - An offset lowers what November owes: paying the rest records as paid, with no "differs" tick.
 * - Insert-only (MLARI) for the secret key and the database owner, replica mode included; signed-in
 *   roles have no writes; the resolved payment can't be voided (5.7a's MLRVB holds).
 * - owner, hr and finance record; a line manager can't (42501).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import { addPayrollWorker } from "./helpers/payroll";
import { approveRun, submitRunFor } from "./helpers/payslips";
import { seedReceipt } from "./helpers/statutory";
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

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let finance: TestUser;
let finance2: TestUser;
let lineManager: TestUser;
let octPaye: string;
let octPension: string;
let novPaye: string;
let novPension: string;
let paymentId: string;
let novRun: string;

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

async function remittance(runId: string, kind: string): Promise<string> {
  const { data, error } = await admin
    .from("statutory_remittances")
    .select("id")
    .eq("run_id", runId)
    .eq("kind", kind)
    .single();
  expect(error).toBeNull();
  return data!.id;
}

const refund = async (by: TestUser, amount: string, receiptFor = octPaye) => {
  const receipt = await seedReceipt(admin, owner.orgId, receiptFor, by.id);
  expect(receipt.error).toBeNull();
  return by.client.rpc("record_remittance_refund", {
    p_organisation_id: owner.orgId,
    p_payment_id: paymentId,
    p_receipt_id: receipt.receiptId,
    p_received_on: new Date().toISOString().slice(0, 10),
    p_amount_kobo: amount,
    p_reference: "LIRS-REFUND-1",
  });
};

const offset = (by: TestUser, target: string, amount: string, payment = paymentId) =>
  by.client.rpc("record_remittance_offset", {
    p_organisation_id: owner.orgId,
    p_payment_id: payment,
    p_target_remittance_id: target,
    p_amount_kobo: amount,
    p_note: "Lagos IRS agreed to set it against November by letter",
  });

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("pres-owner", "Remittance Offsets Org");
  hr = await createTestUser("pres-hr");
  finance = await createTestUser("pres-fin");
  finance2 = await createTestUser("pres-fin2");
  lineManager = await createTestUser("pres-lm");
  await addMember(hr, "hr");
  await addMember(finance, "finance");
  await addMember(finance2, "finance");
  await addMember(lineManager, "line_manager");
  const worker = await addPayrollWorker(admin, owner.orgId);

  // October: approved, its PAYE paid with a receipt, then reversed by two people.
  const oct = await submitRunFor(admin, owner, worker, "2026-09-20");
  await approveRun(admin, owner.orgId, oct, finance);
  octPaye = await remittance(oct, "paye");
  octPension = await remittance(oct, "pension");
  const receipt = await seedReceipt(admin, owner.orgId, octPaye, finance.id);
  expect(receipt.error).toBeNull();
  const paid = await finance.client.rpc("record_statutory_payment", {
    p_organisation_id: owner.orgId,
    p_remittance_id: octPaye,
    p_receipt_id: receipt.receiptId,
    p_paid_on: "2026-10-26",
    p_paid_amount_kobo: "100000",
    p_reference: "LIRS-OCT",
  });
  expect(paid.error).toBeNull();
  paymentId = paid.data!;
  const reversal = await finance.client.rpc("reverse_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: oct,
    p_reason: "Wrong pay rate for October",
  });
  expect(reversal.error).toBeNull();
  const approved = await finance2.client.rpc("approve_payroll_reversal", {
    p_organisation_id: owner.orgId,
    p_run_id: reversal.data!,
  });
  expect(approved.error).toBeNull();

  // November: approved, owing Lagos PAYE ₦1,000 and pension.
  const nov = await submitRunFor(admin, owner, worker, "2026-10-20");
  novRun = nov;
  await approveRun(admin, owner.orgId, nov, finance);
  novPaye = await remittance(nov, "paye");
  novPension = await remittance(nov, "pension");
});

afterAll(async () => {
  await db?.end();
});

describe("what can be refunded or offset", () => {
  it("only a standing payment on a voided remittance", async () => {
    const { data: voids } = await admin
      .from("statutory_remittance_voids")
      .select("remittance_id")
      .eq("remittance_id", octPaye);
    expect(voids).toHaveLength(1);
    // A November payment (its remittance stands) is never refunded or offset.
    const receipt = await seedReceipt(admin, owner.orgId, novPension, finance.id);
    const novPaid = await finance.client.rpc("record_statutory_payment", {
      p_organisation_id: owner.orgId,
      p_remittance_id: novPension,
      p_receipt_id: receipt.receiptId,
      p_paid_on: "2026-11-20",
      p_paid_amount_kobo: "2160000",
      p_reference: "PFA-NOV",
      p_amount_differs: true,
    });
    expect(novPaid.error).toBeNull();
    const wrong = await offset(finance, novPaye, "100", novPaid.data!);
    expect(wrong.error?.code).toBe("MLARC");
  });

  it("offsets only against a later standing remittance to the same authority", async () => {
    expect((await offset(finance, novPension, "1000")).error?.code).toBe("MLARE");
    expect((await offset(finance, octPension, "1000")).error?.code).toBe("MLARE");
    expect((await offset(finance, octPaye, "1000")).error?.code).toBe("MLARE");
  });

  it("refuses roles that don't record remittances", async () => {
    expect((await offset(lineManager, novPaye, "1000")).error?.code).toBe(DENIED);
  });
});

describe("offsets and refunds, to the kobo", () => {
  it("offsets ₦600 against November, which then owes ₦400 and is paid by ₦400 alone", async () => {
    const done = await offset(hr, novPaye, "60000");
    expect(done.error).toBeNull();
    const receipt = await seedReceipt(admin, owner.orgId, novPaye, finance.id);
    const paid = await finance.client.rpc("record_statutory_payment", {
      p_organisation_id: owner.orgId,
      p_remittance_id: novPaye,
      p_receipt_id: receipt.receiptId,
      p_paid_on: "2026-11-20",
      p_paid_amount_kobo: "40000",
      p_reference: "LIRS-NOV",
    });
    expect(paid.error).toBeNull();
    // November owes nothing more: a further offset is beyond what it owes.
    expect((await offset(finance, novPaye, "1")).error?.code).toBe("MLARF");
  });

  it("refunds part with its receipt, and never more than is left", async () => {
    // A receipt nobody checked for this remittance.
    const noReceipt = await finance.client.rpc("record_remittance_refund", {
      p_organisation_id: owner.orgId,
      p_payment_id: paymentId,
      p_receipt_id: randomUUID(),
      p_received_on: new Date().toISOString().slice(0, 10),
      p_amount_kobo: "1000",
    });
    expect(noReceipt.error?.code).toBe("MLARG");
    // A receipt checked for another remittance.
    expect((await refund(finance, "1000", novPaye)).error?.code).toBe("MLARG");
    expect((await refund(finance, "40001")).error?.code).toBe("MLARD");
    const ok = await refund(finance, "40000");
    expect(ok.error).toBeNull();
    expect((await refund(owner, "1")).error?.code).toBe("MLARD");
    const { data } = await admin
      .from("statutory_payment_resolutions")
      .select("kind, amount_kobo, target_remittance_id")
      .eq("payment_id", paymentId)
      .order("created_at");
    expect(data).toEqual([
      { kind: "offset", amount_kobo: 60000, target_remittance_id: novPaye },
      { kind: "refund", amount_kobo: 40000, target_remittance_id: null },
    ]);
    const { data: audit } = await admin
      .from("audit_log")
      .select("action")
      .eq("organisation_id", owner.orgId)
      .in("action", ["payroll.remittance_refund_recorded", "payroll.remittance_offset_recorded"]);
    expect(audit).toHaveLength(2);
  });

  it("keeps a resolved payment standing: it can't be voided as wrong", async () => {
    const { error } = await finance.client.rpc("void_statutory_payment", {
      p_organisation_id: owner.orgId,
      p_payment_id: paymentId,
      p_reason: "Entered twice",
    });
    expect(error?.code).toBe("MLRVB");
  });
});

describe("refunds and offsets are kept as written", () => {
  it("refuses changes and deletes for everyone, and gives signed-in roles no writes", async () => {
    for (const sql of [
      "update public.statutory_payment_resolutions set amount_kobo = 1 where payment_id = $1",
      "delete from public.statutory_payment_resolutions where payment_id = $1",
    ]) {
      for (const replica of [false, true]) {
        const r = await asDbOwner(sql, [paymentId], replica);
        expect(r.error?.code, `${sql} replica=${replica}`).toBe("MLARI");
      }
    }
    expect(
      (await asDbOwner("truncate public.statutory_payment_resolutions", [])).error,
    ).not.toBeNull();
    const ins = await finance.client.from("statutory_payment_resolutions").insert({
      organisation_id: owner.orgId,
      payment_id: paymentId,
      remittance_id: octPaye,
      kind: "offset",
      amount_kobo: 1,
      target_remittance_id: novPaye,
      recorded_by: finance.id,
    });
    expect(ins.error?.code).toBe(DENIED);
  });
});

describe("an offset whose target is reversed stops counting (money review M3)", () => {
  it("frees the offset amount to be refunded again once November is reversed", async () => {
    const reversal = await finance.client.rpc("reverse_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: novRun,
      p_reason: "Wrong pay rate for November",
    });
    expect(reversal.error).toBeNull();
    expect(
      (
        await finance2.client.rpc("approve_payroll_reversal", {
          p_organisation_id: owner.orgId,
          p_run_id: reversal.data!,
        })
      ).error,
    ).toBeNull();
    // The ₦600 offset against November no longer resolves October's payment: ₦600 is open again.
    expect((await refund(finance, "60001")).error?.code).toBe("MLARD");
    expect((await refund(finance, "60000")).error).toBeNull();
  });
});
