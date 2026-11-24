/**
 * Slice 5.7c end to end (docs/PHASE_5.md 5.7, decision 10): corrections for things decided after
 * a period was posted are paid in the next run, once, through the real functions (createRunSpec
 * runs the server engine as HR, approveRunSpec re-gathers the inputs as Finance).
 *
 * Two workers on ₦120,000 a month (₦60,000 / ₦36,000 / ₦24,000), Monday-to-Friday days, no
 * shifts, so October 2026 (20 Sep to 19 Oct) has 21 rostered days.
 * - Ngozi Eze's unpaid leave on Mon 12 and Tue 13 Oct is approved before October's run, which
 *   deducts ₦11,428.57 (₦120,000 x 2 ÷ 21). After posting HR cancels it (no MLTA5): November
 *   refunds exactly that, line by line, once; December refunds nothing.
 * - Bayo Adewale's unpaid leave on Thu 15 and Fri 16 Oct waits for HR at October's run. After
 *   posting HR approves it (no MLTA5): November recovers it as arrears after tax (RULES_NIGERIA
 *   open point 5's default), on October's 21 days, at October's rate, once.
 * - Money review H1, each saved through the real functions:
 *   (A) Chika Obi's unpaid leave 16 to 21 Oct, approved after October posted: November recovers
 *       16 to 19 Oct as arrears and deducts 20 and 21 Oct as its own leave, one request backing
 *       both on one payslip;
 *   (B) Dayo Bello's unpaid leave 15 to 21 Oct, approved after November posted too: December
 *       recovers 15 to 19 Oct and 20 to 21 Oct as two arrears, one per posted period;
 *   (C) Emeka Nwosu's unpaid leave 16 to 21 Oct, deducted by October and by November, then
 *       cancelled: December refunds both deductions.
 * - Bayo's Saturday 10 Oct waits for his manager at October's run and is approved after posting;
 *   his pay rises to ₦150,000 from 20 Oct. November pays the Saturday as arrears at the rate in
 *   force that day (8 hours at ₦750, not ₦937.50), once; December doesn't pay it again.
 * - A one-off off-cycle run for Ngozi in between (slice 5.7b) takes none of these corrections:
 *   only the next regular run pays them, once.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { roundHalfUp } from "@/lib/money";
import { runMutation } from "@/server/identity/mutate";
import {
  addAdjustmentSpec,
  approveRunSpec,
  createOffCycleRunSpec,
  createRunSpec,
  recalculateRunSpec,
} from "@/server/payroll/runs";
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
const OCT_END = "2026-10-19";
const NOV_START = "2026-10-20";
const DEC_START = "2026-11-20";
const TWO_DAYS = roundHalfUp(12_000_000n * 2n, 21n); // ₦11,428.57

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let finance: TestUser;
let lineManager: TestUser;
let ngozi: string;
let bayo: string;
let typeId: string;
let cancelled: string;
let late: string;
let saturday: string;
let octRun: string;
let novRun: string;
let decRun: string;
let chika: string;
let dayo: string;
let emeka: string;
let leaveA: string;
let leaveB: string;
let leaveC: string;
let femi: string;
let leaveD: string;

async function addMember(user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

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

const ctxOf = (user: TestUser, role: Role) => ({
  supabase: user.client,
  userId: user.id,
  organisationId: owner.orgId,
  role,
});

async function addWorker(first: string, last: string): Promise<string> {
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `AR-${randomUUID().slice(0, 6)}`,
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

async function leave(workerId: string, start: string, end: string, status: string) {
  const id = randomUUID();
  await asOwnerWithTriggersOff(
    `insert into public.leave_requests (id, organisation_id, worker_id, leave_type_id, leave_year,
       start_date, end_date, days, status, decided_at)
     values ($1, $2, $3, $4, 2026, $5, $6, 2, $7, case when $7 = 'approved' then now() end)`,
    [id, owner.orgId, workerId, typeId, start, end, status],
  );
  if (status === "approved") {
    await asOwnerWithTriggersOff(
      `insert into public.leave_request_pay (request_id, organisation_id, pay_percent, pay_below_service)
       values ($1, $2, 0, false)`,
      [id, owner.orgId],
    );
  }
  return id;
}

/** Acknowledges the run's warnings, submits it as HR and approves it as Finance (the server path). */
async function submitAndApprove(runId: string) {
  const { data: anomalies } = await admin
    .from("payroll_anomalies")
    .select("id, severity, code")
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

async function linesOf(runId: string, workerId: string, code: string) {
  const { data: slip } = await admin
    .from("payslips")
    .select("id")
    .eq("run_id", runId)
    .eq("worker_id", workerId)
    .single();
  const { data } = await admin
    .from("payslip_lines")
    .select("label, amount_kobo::text, pensionable")
    .eq("payslip_id", slip!.id)
    .eq("code", code)
    .order("position");
  return { payslipId: slip!.id, lines: data ?? [] };
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
  owner = await createTenantUser("parr-owner", "Arrears Payroll Org");
  hr = await createTestUser("parr-hr", "Oluwaseun Adeyemi");
  finance = await createTestUser("parr-finance", "Adaeze Okafor");
  lineManager = await createTestUser("parr-lm");
  await addMember(hr, "hr");
  await addMember(finance, "finance");
  await addMember(lineManager, "line_manager");
  ngozi = await addWorker("Ngozi", "Eze");
  bayo = await addWorker("Bayo", "Adewale");

  typeId = randomUUID();
  await asOwnerWithTriggersOff(
    `insert into public.leave_types (id, organisation_id, code, name, counting, paid)
     values ($1, $2, 'unpaid', 'Unpaid', 'working_days', false)`,
    [typeId, owner.orgId],
  );
  cancelled = await leave(ngozi, "2026-10-12", "2026-10-13", "approved");
  late = await leave(bayo, "2026-10-15", "2026-10-16", "pending_hr");
  chika = await addWorker("Chika", "Obi");
  dayo = await addWorker("Dayo", "Bello");
  emeka = await addWorker("Emeka", "Nwosu");
  leaveA = await leave(chika, "2026-10-16", "2026-10-21", "pending_hr");
  leaveB = await leave(dayo, "2026-10-15", "2026-10-21", "pending_hr");
  leaveC = await leave(emeka, "2026-10-16", "2026-10-21", "approved");
  // (D) Femi Ade's unpaid leave 23 Sep to 19 Oct, approved after October posted: more than
  // November's net pay, so part is taken and the rest carried; then cancelled.
  femi = await addWorker("Femi", "Ade");
  leaveD = await leave(femi, "2026-09-23", "2026-10-19", "pending_hr");

  // Bayo's Saturday, still waiting for his manager when October is prepared.
  await asOwnerWithTriggersOff(
    `insert into public.timesheets (organisation_id, worker_id, period_start, period_end)
     values ($1, $2, $3::date, $4::date)`,
    [owner.orgId, bayo, OCT_START, OCT_END],
  );
  saturday = randomUUID();
  await asOwnerWithTriggersOff(
    `insert into public.timesheet_lines (id, organisation_id, timesheet_id, worker_id, work_date,
       no_shift_punch_id, scheduled_minutes, worked_minutes, ot_minutes, status, exceptions)
     select $1, $2, t.id, $3, '2026-10-10', gen_random_uuid(), 0, 480, 0, 'pending', '{}'
     from public.timesheets t where t.organisation_id = $2 and t.worker_id = $3`,
    [saturday, owner.orgId, bayo],
  );
});

afterAll(async () => {
  await db?.end();
});

describe("October posts with the leave approved before it", () => {
  it("deducts Ngozi's two unpaid days and nothing for Bayo's leave still waiting", async () => {
    const oct = await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: OCT_START });
    expect(oct.calculated).toBe(true);
    octRun = oct.runId;
    const n = await linesOf(octRun, ngozi, "leave_deduction");
    expect(sum(n.lines)).toBe(-TWO_DAYS);
    expect((await linesOf(octRun, bayo, "leave_deduction")).lines).toEqual([]);
    await submitAndApprove(octRun);
    const { data } = await admin.from("payroll_runs").select("status").eq("id", octRun).single();
    expect(data).toEqual({ status: "approved" });
  });
});

describe("after posting: corrections, not MLTA5", () => {
  it("lets HR cancel Ngozi's deducted leave and approve Bayo's waiting leave", async () => {
    // October (a regular run) paid Ngozi's leave, so 5.7b's paid-leave freeze lets the
    // cancellation through: the next regular run refunds it (below). Leave an off-cycle run paid
    // stays frozen (tests/rls/payroll-off-cycle.test.ts, security M3).
    const { data: paidBy } = await admin
      .from("payslip_sources")
      .select("run_id")
      .eq("source_kind", "leave_request")
      .eq("source_id", cancelled)
      .eq("stands", true);
    expect(paidBy).toEqual([{ run_id: octRun }]);
    const c = await hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: cancelled,
      p_reason: "Came to work after all",
    });
    expect(c.error).toBeNull();
    const a = await hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: late,
      p_decision: "approved",
      p_note: "Form found",
    });
    expect(a.error).toBeNull();
    // (A) Chika's leave runs across the posted boundary into November.
    const aa = await hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: leaveA,
      p_decision: "approved",
      p_note: "Form found",
    });
    expect(aa.error).toBeNull();
    const dd = await hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: leaveD,
      p_decision: "approved",
      p_note: "Form found",
    });
    expect(dd.error).toBeNull();
    // Bayo's Saturday is approved too (as the database owner, with its decision), and his pay
    // rises from 20 Oct.
    await asOwnerWithTriggersOff(
      `insert into public.timesheet_decisions (organisation_id, line_id, worker_id, decision,
         actor_id, scheduled_minutes, worked_minutes, late_minutes, early_minutes, ot_minutes,
         exceptions, needs_review)
       select organisation_id, id, worker_id, 'approved', $2, scheduled_minutes, worked_minutes,
              late_minutes, early_minutes, ot_minutes, exceptions, needs_review
       from public.timesheet_lines where id = $1`,
      [saturday, owner.id],
    );
    await asOwnerWithTriggersOff(
      "update public.timesheet_lines set status = 'approved', decided_at = now() where id = $1",
      [saturday],
    );
    const raise = await hr.client.rpc("add_pay_rate", {
      p_organisation_id: owner.orgId,
      p_worker_id: bayo,
      p_rate: {
        pay_type: "monthly",
        basic_kobo: "7500000",
        housing_kobo: "4500000",
        transport_kobo: "3000000",
        other_allowances_kobo: "0",
        daily_rate_kobo: null,
        hourly_rate_kobo: null,
        effective_from: NOV_START,
      },
    });
    expect(raise.error).toBeNull();
  });

  it("shows the corrections to payroll readers only", async () => {
    const read = (client: Client) =>
      client.rpc("payroll_leave_corrections", {
        p_organisation_id: owner.orgId,
        p_period_start: NOV_START,
        p_worker_ids: [ngozi, bayo],
      });
    const { data, error } = await read(finance.client);
    expect(error).toBeNull();
    const workers = (data as { workers: { worker_id: string }[] }).workers;
    expect(workers.map((w) => w.worker_id).sort()).toEqual([ngozi, bayo].sort());
    expect((await read(lineManager.client)).error?.code).toBe("42501");
  });
});

describe("an off-cycle run in between (slice 5.7b)", () => {
  it("takes no leave correction or arrears: a one-off run pays its own item only", async () => {
    const off = await runMutation(ctxOf(hr, "hr"), createOffCycleRunSpec, {
      periodStart: NOV_START,
      payDate: "2026-10-30",
      reason: "one_off",
      note: "Long-service bonus",
      workerIds: [ngozi],
    });
    await runMutation(ctxOf(hr, "hr"), addAdjustmentSpec, {
      runId: off.runId,
      workerId: ngozi,
      kind: "earning",
      label: "Long-service bonus",
      amount: "5000",
      instalments: "1",
      reason: "Ten years with the company",
    });
    await runMutation(ctxOf(hr, "hr"), recalculateRunSpec, { runId: off.runId });
    const { data: lines } = await admin
      .from("payslip_lines")
      .select("code")
      .eq("run_id", off.runId)
      .eq("kind", "earning");
    expect(lines!.map((l) => l.code)).toEqual(["adjustment_earning"]);
    await submitAndApprove(off.runId);
    const { data: run } = await admin
      .from("payroll_runs")
      .select("status")
      .eq("id", off.runId)
      .single();
    expect(run).toEqual({ status: "approved" });
  });
});

describe("November pays each correction once", () => {
  it("refunds Ngozi exactly what October took, naming the deduction's days", async () => {
    const nov = await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: NOV_START });
    expect(nov.calculated).toBe(true);
    novRun = nov.runId;
    const octLines = (await linesOf(octRun, ngozi, "leave_deduction")).lines;
    const refund = await linesOf(novRun, ngozi, "leave_refund");
    expect(refund.lines.map((l) => BigInt(l.amount_kobo))).toEqual(
      octLines.map((l) => -BigInt(l.amount_kobo)),
    );
    expect(sum(refund.lines)).toBe(TWO_DAYS);
    expect(refund.lines[0]!.label).toBe(
      "Leave refund in 20 Sep to 19 Oct, cancelled after posting (12 to 13 Oct), basic",
    );
    const { data: sources } = await admin
      .from("payslip_sources")
      .select("source_kind, source_id, from_date, to_date")
      .eq("payslip_id", refund.payslipId)
      .eq("source_kind", "leave_refund");
    expect(sources).toEqual([
      {
        source_kind: "leave_refund",
        source_id: cancelled,
        from_date: "2026-10-12",
        to_date: "2026-10-13",
      },
    ]);
  });

  it("recovers Bayo's late leave after tax, on October's 21 days at October's rate", async () => {
    expect((await linesOf(novRun, bayo, "leave_deduction")).lines).toEqual([]);
    const arrears = await linesOf(novRun, bayo, "leave_arrears");
    expect(arrears.lines).toEqual([
      {
        label: "Unpaid leave in 20 Sep to 19 Oct, approved after posting (15 to 16 Oct, 2 days)",
        amount_kobo: TWO_DAYS.toString(),
        pensionable: false,
      },
    ]);
    const { data: sources } = await admin
      .from("payslip_sources")
      .select("from_date, to_date")
      .eq("payslip_id", arrears.payslipId)
      .eq("source_kind", "leave_request")
      .eq("source_id", late);
    expect(sources).toEqual([{ from_date: "2026-10-15", to_date: "2026-10-16" }]);
  });

  it("(A) recovers Chika's posted days as arrears and deducts November's days, on one payslip", async () => {
    const arrears = await linesOf(novRun, chika, "leave_arrears");
    // Thu 16 and Mon 19 Oct... Fri 16, Mon 19: 2 of October's 21 days.
    expect(sum(arrears.lines)).toBe(TWO_DAYS);
    const own = await linesOf(novRun, chika, "leave_deduction");
    expect(sum(own.lines) < 0n).toBe(true);
    const { data: sources } = await admin
      .from("payslip_sources")
      .select("from_date, to_date")
      .eq("payslip_id", arrears.payslipId)
      .eq("source_kind", "leave_request")
      .eq("source_id", leaveA)
      .order("from_date");
    expect(sources).toEqual([
      { from_date: "2026-10-16", to_date: "2026-10-19" },
      { from_date: "2026-10-20", to_date: "2026-10-21" },
    ]);
  });

  it("pays Bayo's Saturday at the rate in force that day, not his new rate", async () => {
    const pay = await linesOf(novRun, bayo, "arrears");
    // An off day: 8 hours at ₦120,000 ÷ 160 = ₦750 an hour (₦150,000 would give ₦937.50).
    expect(pay.lines.map((l) => BigInt(l.amount_kobo))).toEqual([600_000n]);
    // November's salary is the new rate in full.
    expect(sum((await linesOf(novRun, bayo, "basic")).lines)).toBe(7_500_000n);
  });

  it("refuses paying a correction twice: a second refund of the same days is a paid source", async () => {
    const { data: src } = await admin
      .from("payslip_sources")
      .select("id")
      .eq("run_id", novRun)
      .eq("source_kind", "leave_refund")
      .single();
    // The exclusion constraint holds for the database owner too.
    await expect(
      asOwnerWithTriggersOff(
        `insert into public.payslip_sources (organisation_id, payslip_id, run_id, worker_id,
           source_kind, source_id, from_date, to_date, line_positions)
         select organisation_id, payslip_id, run_id, worker_id, source_kind, source_id, from_date,
                to_date, line_positions
         from public.payslip_sources s
         where s.id = $1`,
        [src!.id],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("approves November, and December pays none of them again", async () => {
    await submitAndApprove(novRun);
    // After November posts: (B) Dayo's leave is approved, (C) Emeka's is cancelled.
    const b = await hr.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: leaveB,
      p_decision: "approved",
      p_note: "Form found",
    });
    expect(b.error).toBeNull();
    const c = await hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: leaveC,
      p_reason: "Came to work after all",
    });
    expect(c.error).toBeNull();
    const d = await hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: leaveD,
      p_reason: "Entered against the wrong worker",
    });
    expect(d.error).toBeNull();
    const dec = await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: DEC_START });
    expect(dec.calculated).toBe(true);
    decRun = dec.runId;
    for (const code of ["leave_refund", "leave_deduction", "leave_arrears", "arrears"]) {
      const { data } = await admin
        .from("payslip_lines")
        .select("id, payslip_id")
        .eq("run_id", dec.runId)
        .eq("code", code)
        .in("payslip_id", [
          (await linesOf(dec.runId, ngozi, code)).payslipId,
          (await linesOf(dec.runId, bayo, code)).payslipId,
          (await linesOf(dec.runId, chika, code)).payslipId,
        ]);
      expect(data, code).toEqual([]);
    }
    const { data: paid } = await admin
      .from("payslip_sources")
      .select("run_id, source_kind")
      .in("source_id", [cancelled, late, saturday])
      .eq("stands", true)
      .neq("run_id", octRun);
    expect(paid!.every((p) => p.run_id === novRun)).toBe(true);
    expect(paid).toHaveLength(3);
  });
});

describe("December saves the two-period corrections (money review H1)", () => {
  it("(B) recovers Dayo's leave as two arrears, one per posted period", async () => {
    const arrears = await linesOf(decRun, dayo, "leave_arrears");
    expect(arrears.lines).toHaveLength(2);
    const { data: sources } = await admin
      .from("payslip_sources")
      .select("from_date, to_date")
      .eq("payslip_id", arrears.payslipId)
      .eq("source_kind", "leave_request")
      .eq("source_id", leaveB)
      .order("from_date");
    expect(sources).toEqual([
      { from_date: "2026-10-15", to_date: "2026-10-19" },
      { from_date: "2026-10-20", to_date: "2026-10-21" },
    ]);
    // 15, 16 and 19 Oct: 3 of October's 21 days.
    expect(BigInt(arrears.lines[0]!.amount_kobo)).toBe(roundHalfUp(12_000_000n * 3n, 21n));
  });

  it("(C) refunds both of Emeka's deductions, October's and November's", async () => {
    const octTook = sum((await linesOf(octRun, emeka, "leave_deduction")).lines);
    const novTook = sum((await linesOf(novRun, emeka, "leave_deduction")).lines);
    expect(octTook < 0n && novTook < 0n).toBe(true);
    const refund = await linesOf(decRun, emeka, "leave_refund");
    expect(sum(refund.lines)).toBe(-(octTook + novTook));
    const { data: sources } = await admin
      .from("payslip_sources")
      .select("from_date, to_date")
      .eq("payslip_id", refund.payslipId)
      .eq("source_kind", "leave_refund")
      .eq("source_id", leaveC)
      .order("from_date");
    expect(sources).toEqual([
      { from_date: "2026-10-16", to_date: "2026-10-19" },
      { from_date: "2026-10-20", to_date: "2026-10-21" },
    ]);
  });
});

describe("partly recovered arrears, then cancelled (coordinator, 24 Nov 2026)", () => {
  it("(D) nets to ₦0 for the cancelled days: the full amount refunded, the carried rest taken", async () => {
    const { data: novSlip } = await admin
      .from("payslips")
      .select("id, net_kobo::text, carried_forward_kobo::text, trace")
      .eq("run_id", novRun)
      .eq("worker_id", femi)
      .single();
    const taken = sum((await linesOf(novRun, femi, "leave_arrears")).lines);
    const carriedOn = BigInt(novSlip!.carried_forward_kobo);
    // November could take only part (net pay ₦0), carrying the rest.
    expect(BigInt(novSlip!.net_kobo)).toBe(0n);
    expect(carriedOn > 0n).toBe(true);
    const owed = taken + carriedOn;
    // December refunds the full amount owed and takes the carried rest: ₦0 net for those days.
    const refunded = sum((await linesOf(decRun, femi, "leave_refund")).lines);
    const carriedTaken = sum((await linesOf(decRun, femi, "carried_deduction")).lines);
    expect(refunded).toBe(owed);
    expect(carriedTaken).toBe(carriedOn);
    expect(taken + carriedTaken - refunded).toBe(0n);
    // Slice 5.8 (owner decision): December says the refund includes the carried rest, not yet
    // recovered when it was worked out (whole naira in thousands groups, and kobo).
    const { data: flags } = await admin
      .from("payroll_anomalies")
      .select("severity, detail")
      .eq("run_id", decRun)
      .eq("worker_id", femi)
      .eq("code", "refund_uncollected_carry");
    expect(flags).toEqual([
      {
        severity: "warning",
        detail: {
          naira: (carriedOn / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","),
          kobo: Number(carriedOn % 100n),
        },
      },
    ]);
  });
});
