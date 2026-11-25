/**
 * Slice 5.9a: 5.7c's case (D) under NTA 2025 v2 (coordinator, 25 Nov 2026). Leave approved after
 * its period posted is recovered BEFORE tax in the same tax year (the tax adviser), cut to what
 * the month's pay can bear, with the rest carried AFTER tax (coordinator decision M2). When the
 * leave is then cancelled, the worker must net ₦0 for those days across the runs: the refund pays
 * back the pre-tax part before tax and the carried rest after tax, and the carried balance is
 * still collected.
 *
 * Femi Ade earns ₦120,000 until 19 Oct and ₦60,000 from 20 Oct. His unpaid leave 23 Sep to 19
 * Oct is approved after October posted (priced at ₦120,000, more than November's ₦60,000 can
 * bear), then cancelled after November posted. Two colleagues keep the company at 3 employees, so
 * pension applies.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMutation } from "@/server/identity/mutate";
import { approveRunSpec, createRunSpec } from "@/server/payroll/runs";
import type { Database } from "@/types/db";

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

const OCT_START = "2026-09-20";
const NOV_START = "2026-10-20";
const DEC_START = "2026-11-20";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let finance: TestUser;
let femi: string;
let leaveD: string;
let novRun: string;
let decRun: string;

const ctxOf = (user: TestUser, role: Role) => ({
  supabase: user.client,
  userId: user.id,
  organisationId: owner.orgId,
  role,
});

async function asOwnerWithTriggersOff(sql: string, params: unknown[]) {
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    const out = await db.query(sql, params);
    await db.query("commit");
    return out;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

async function addWorker(first: string, last: string): Promise<string> {
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `AV-${randomUUID().slice(0, 6)}`,
      first_name: first,
      last_name: last,
      employment_type: "permanent",
      start_date: "2025-01-06",
      tax_state: "Lagos",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const rate = await admin.from("pay_rates").insert({
    organisation_id: owner.orgId,
    worker_id: data.id,
    pay_type: "monthly",
    basic_kobo: 6_000_000,
    housing_kobo: 3_600_000,
    transport_kobo: 2_400_000,
    other_allowances_kobo: 0,
    effective_from: "2025-01-06",
  });
  if (rate.error) throw new Error(rate.error.message);
  return data.id;
}

async function submitAndApprove(runId: string) {
  const { data: anomalies } = await admin
    .from("payroll_anomalies")
    .select("id, severity")
    .eq("run_id", runId);
  expect(anomalies!.filter((a) => a.severity === "blocking")).toEqual([]);
  if (anomalies!.length > 0) {
    const ack = await hr.client.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_anomaly_ids: anomalies!.map((a) => a.id),
    });
    expect(ack.error).toBeNull();
  }
  const sub = await hr.client.rpc("submit_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
  });
  expect(sub.error).toBeNull();
  await runMutation(ctxOf(finance, "finance"), approveRunSpec, { runId });
}

async function linesOf(runId: string, workerId: string) {
  const { data: slip } = await admin
    .from("payslips")
    .select("id, carried_forward_kobo::text, net_kobo::text")
    .eq("run_id", runId)
    .eq("worker_id", workerId)
    .single();
  const { data } = await admin
    .from("payslip_lines")
    .select("code, amount_kobo::text, taxable, pensionable")
    .eq("payslip_id", slip!.id)
    .order("position");
  return { slip: slip!, lines: data ?? [] };
}

const sum = (lines: { amount_kobo: string }[]) =>
  lines.reduce((n, l) => n + BigInt(l.amount_kobo), 0n);

beforeAll(async () => {
  const env = loadLocalEnv();
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.publishableKey;
  process.env.SUPABASE_SECRET_KEY = env.secretKey;
  admin = adminClient();
  db = await pgClient();
  // The company's starting rule set: NTA 2025 v2 (no pinning).
  owner = await createTenantUser("parv2-owner", "Arrears v2 Payroll Org");
  hr = await createTestUser("parv2-hr", "Oluwaseun Adeyemi");
  finance = await createTestUser("parv2-finance", "Adaeze Okafor");
  for (const [user, role] of [
    [hr, "hr"],
    [finance, "finance"],
  ] as const) {
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: user.id, role });
    expect(error).toBeNull();
  }
  femi = await addWorker("Femi", "Ade");
  await addWorker("Kemi", "Lawal");
  await addWorker("Tobi", "Okon");
  const typeId = randomUUID();
  await asOwnerWithTriggersOff(
    `insert into public.leave_types (id, organisation_id, code, name, counting, paid)
     values ($1, $2, 'unpaid', 'Unpaid', 'working_days', false)`,
    [typeId, owner.orgId],
  );
  leaveD = randomUUID();
  await asOwnerWithTriggersOff(
    `insert into public.leave_requests (id, organisation_id, worker_id, leave_type_id, leave_year,
       start_date, end_date, days, status)
     values ($1, $2, $3, $4, 2026, '2026-09-23', '2026-10-19', 19, 'pending_hr')`,
    [leaveD, owner.orgId, femi, typeId],
  );
});

afterAll(async () => {
  await db?.end();
});

describe("case (D) under NTA 2025 v2: pre-tax arrears partly carried, then cancelled", () => {
  it("posts October, then Femi's pay drops and his leave is approved after posting", async () => {
    const oct = await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: OCT_START });
    await submitAndApprove(oct.runId);
    const rate = await hr.client.rpc("add_pay_rate", {
      p_organisation_id: owner.orgId,
      p_worker_id: femi,
      p_rate: {
        pay_type: "monthly",
        basic_kobo: "3000000",
        housing_kobo: "1800000",
        transport_kobo: "1200000",
        other_allowances_kobo: "0",
        daily_rate_kobo: null,
        hourly_rate_kobo: null,
        effective_from: NOV_START,
      },
    });
    expect(rate.error).toBeNull();
    const approved = await hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: leaveD,
      p_decision: "approved",
      p_note: "Checked",
    });
    expect(approved.error).toBeNull();
  });

  it("November recovers what fits before tax and carries the rest after tax", async () => {
    novRun = (await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: NOV_START })).runId;
    const { slip, lines } = await linesOf(novRun, femi);
    const pre = lines.filter((l) => l.code === "leave_deduction");
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.every((l) => l.taxable)).toBe(true);
    expect(lines.some((l) => l.code === "leave_arrears")).toBe(false);
    expect(BigInt(slip.carried_forward_kobo) > 0n).toBe(true);
    const { data: flags } = await admin
      .from("payroll_anomalies")
      .select("code")
      .eq("run_id", novRun)
      .eq("worker_id", femi);
    expect(flags!.map((f) => f.code)).toContain("recovery_carried");
    await submitAndApprove(novRun);
  });

  it("December refunds the pre-tax part before tax and the carried rest after tax: ₦0 net", async () => {
    const cancelled = await hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: leaveD,
      p_reason: "Was at work after all",
    });
    expect(cancelled.error).toBeNull();
    decRun = (await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: DEC_START })).runId;

    const nov = await linesOf(novRun, femi);
    const preTaxTaken = -sum(nov.lines.filter((l) => l.code === "leave_deduction"));
    const carriedOn = BigInt(nov.slip.carried_forward_kobo);

    const dec = await linesOf(decRun, femi);
    const refunds = dec.lines.filter((l) => l.code === "leave_refund");
    const refundBefore = sum(refunds.filter((l) => l.taxable));
    const refundAfter = sum(refunds.filter((l) => !l.taxable));
    // Each part refunded the way it was recovered.
    expect(refundBefore).toBe(preTaxTaken);
    expect(refundAfter).toBe(carriedOn);
    expect(refunds.filter((l) => !l.taxable).every((l) => !l.pensionable)).toBe(true);
    // The carried balance is still collected (December takes what fits, the rest carries on), so
    // over the runs: taken before tax + carried taken − refund = ₦0.
    const carriedTaken = sum(dec.lines.filter((l) => l.code === "carried_deduction"));
    const stillCarried = BigInt(dec.slip.carried_forward_kobo);
    expect(carriedTaken + stillCarried).toBe(carriedOn);
    expect(preTaxTaken + (carriedTaken + stillCarried) - (refundBefore + refundAfter)).toBe(0n);
    // 5.8's warning: the refund includes the carried rest not yet recovered when worked out.
    const { data: flags } = await admin
      .from("payroll_anomalies")
      .select("code")
      .eq("run_id", decRun)
      .eq("worker_id", femi);
    expect(flags!.map((f) => f.code)).toContain("refund_uncollected_carry");
  });
});
