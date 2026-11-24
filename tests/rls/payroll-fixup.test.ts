/**
 * Slice 5.8 (Phase 5 review fix-up) against the real database.
 * - Audit log: admins see no row of a Phase 5 payroll or statutory entity and no payroll.* or
 *   statutory.* event; the owner sees them all; hr and finance read no audit log (unchanged:
 *   they never had it). Stricter than 5.1's rule, which hid only pay_rates.
 * - Reversal order (MLFX1, "Reverse the later run first: <run>"), for the request and the
 *   approval: (a) a later run paid arrears dated in the run's period; (b) a later-period run holds
 *   one of its workers; (c) a run approved after it counted its payslip in the month's PAYE. Once
 *   the later run is reversed, the earlier one can be.
 * - Approval and month-aggregate PAYE: an off-cycle approval is refused (MLPRF) when another run
 *   for the worker in the pay date's month was approved after its read, or when the month's
 *   standing payslips aren't the ones its PAYE counted.
 * - Guards ENABLE ALWAYS: the tax rule set guards and pay_rates_guard fire in replica mode; the
 *   old session setting no longer lets anyone close a version.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import {
  addPayrollWorker,
  OCT_END,
  OCT_START,
  resultsFor,
  saveResults,
  SHA,
} from "./helpers/payroll";
import { approveRun, periodEnd, submitRunFor } from "./helpers/payslips";
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

const NOV_START = "2026-10-20";

let admin: Client;
let db: pg.Client;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

interface Company {
  owner: TenantUser;
  hr: TestUser;
  finance: TestUser;
  finance2: TestUser;
  adminUser: TestUser;
}

async function company(label: string): Promise<Company> {
  const owner = await createTenantUser(`pfx-${label}-owner`, `Fix-up ${label} Org`);
  const add = async (suffix: string, role: Role) => {
    const user = await createTestUser(`pfx-${label}-${suffix}`);
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: user.id, role });
    expect(error).toBeNull();
    return user;
  };
  return {
    owner,
    hr: await add("hr", "hr"),
    finance: await add("fin", "finance"),
    finance2: await add("fin2", "finance"),
    adminUser: await add("admin", "admin"),
  };
}

/** As the database owner, optionally in replica mode, in its own transaction. */
async function asDbOwner(sql: string, params: unknown[], replica = false, before: string[] = []) {
  await db.query("begin");
  try {
    if (replica) await db.query("set local session_replication_role = replica");
    for (const s of before) await db.query(s);
    const result = await db.query(sql, params);
    await db.query("commit");
    return { error: null as null | { code?: string; message: string }, result };
  } catch (error) {
    await db.query("rollback");
    return { error: error as { code?: string; message: string }, result: null };
  }
}

/** An approved timesheet day, seeded before its period is posted (as 5.7a's tests do). */
async function addLine(orgId: string, workerId: string, workDate: string): Promise<string> {
  await asDbOwner(
    `insert into public.timesheets (organisation_id, worker_id, period_start, period_end)
     values ($1, $2, private.timesheet_period_start($3::date, 20),
             private.timesheet_period_end(private.timesheet_period_start($3::date, 20)))
     on conflict (organisation_id, worker_id, period_start) do nothing`,
    [orgId, workerId, workDate],
    true,
  );
  const id = randomUUID();
  const { error } = await asDbOwner(
    `insert into public.timesheet_lines (id, organisation_id, timesheet_id, worker_id, work_date,
       shift_assignment_id, shift_id, post_id, scheduled_minutes, worked_minutes, ot_minutes,
       status, exceptions)
     select $1, $2, t.id, $3, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 480,
            480, 0, 'approved', '{}'
     from public.timesheets t
     where t.organisation_id = $2 and t.worker_id = $3
       and t.period_start = private.timesheet_period_start($4::date, 20)`,
    [id, orgId, workerId, workDate],
    true,
  );
  expect(error).toBeNull();
  return id;
}

async function clock(): Promise<string> {
  const { data, error } = await admin.rpc("payroll_clock");
  expect(error).toBeNull();
  return data!;
}

async function check(orgId: string, runId: string, actor: string, readStartedAt?: string) {
  const { error } = await admin.rpc("record_payroll_approval_check", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: actor,
    p_inputs_sha256: SHA,
    p_read_started_at: readStartedAt ?? (await clock()),
  });
  expect(error).toBeNull();
}

const approve = (by: Client, orgId: string, runId: string) =>
  by.rpc("approve_payroll_run", { p_organisation_id: orgId, p_run_id: runId });

const reverse = (by: Client, orgId: string, runId: string) =>
  by.rpc("reverse_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_reason: "Wrong pay rate",
  });

const approveReversal = (by: Client, orgId: string, runId: string) =>
  by.rpc("approve_payroll_reversal", { p_organisation_id: orgId, p_run_id: runId });

async function acknowledgeAndSubmit(owner: TenantUser, runId: string) {
  const { data: anomalies } = await admin
    .from("payroll_anomalies")
    .select("id")
    .eq("run_id", runId);
  if ((anomalies ?? []).length > 0) {
    const ack = await owner.client.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_anomaly_ids: (anomalies ?? []).map((a) => a.id),
    });
    expect(ack.error).toBeNull();
  }
  const submitted = await owner.client.rpc("submit_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
  });
  expect(submitted.error).toBeNull();
}

// ---------------------------------------------------------------------------
// 1. The audit log
// ---------------------------------------------------------------------------

const PAY_ENTITIES = [
  "pay_rates",
  "tax_rule_sets",
  "payroll_runs",
  "payroll_adjustments",
  "payroll_anomalies",
  "payroll_approval_checks",
  "payroll_run_decisions",
  "payroll_run_workers",
  "payslips",
  "payslip_lines",
  "payslip_sources",
  "payslip_documents",
  "payslip_snapshots",
  "payout_batches",
  "payout_items",
  "payout_supplements",
  "payout_supplement_items",
  "statutory_remittances",
  "statutory_payments",
  "statutory_receipts",
  "statutory_remittance_voids",
  "statutory_payment_resolutions",
];
const PAY_ACTIONS = ["payroll.adjustments_moved", "payroll.run_approved", "statutory.anything"];

describe("the audit log hides every payroll and statutory row from admins", () => {
  let c: Company;

  beforeAll(async () => {
    c = await company("audit");
    // Real payroll activity: pay rates, a run made, worked out, submitted and approved
    // (payroll_runs, decisions, approval checks, remittances, payroll.* events).
    const worker = await addPayrollWorker(admin, c.owner.orgId);
    const run = await submitRunFor(admin, c.owner, worker, OCT_START);
    await approveRun(admin, c.owner.orgId, run, c.finance);
    // One row per entity and per event, as the triggers and functions write them (amounts in
    // before and after), so every name is checked whether or not a flow above wrote it.
    for (const entity of PAY_ENTITIES) {
      const { error } = await asDbOwner(
        `insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
         values ($1, $2, 'insert', $3, gen_random_uuid(), '{"net_kobo": "10474000"}')`,
        [c.owner.orgId, c.owner.id, entity],
      );
      expect(error).toBeNull();
    }
    for (const action of PAY_ACTIONS) {
      const { error } = await asDbOwner(
        `insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
         values ($1, $2, $3, 'workers', gen_random_uuid(), '{"amount_kobo": "1500000"}')`,
        [c.owner.orgId, c.owner.id, action],
      );
      expect(error).toBeNull();
    }
  });

  it("shows the owner every payroll entity and event", async () => {
    for (const entity of PAY_ENTITIES) {
      const { data, error } = await c.owner.client
        .from("audit_log")
        .select("id")
        .eq("organisation_id", c.owner.orgId)
        .eq("entity", entity);
      expect(error).toBeNull();
      expect((data ?? []).length, entity).toBeGreaterThan(0);
    }
    for (const action of PAY_ACTIONS) {
      const { data } = await c.owner.client.from("audit_log").select("id").eq("action", action);
      expect((data ?? []).length, action).toBeGreaterThan(0);
    }
    // The real flow wrote payroll events too.
    const { data: events } = await c.owner.client
      .from("audit_log")
      .select("id")
      .eq("organisation_id", c.owner.orgId)
      .like("action", "payroll.%");
    expect((events ?? []).length).toBeGreaterThan(2);
  });

  it("shows an admin no payroll or statutory row, entity by entity and event by event", async () => {
    for (const entity of PAY_ENTITIES) {
      const { data, error } = await c.adminUser.client
        .from("audit_log")
        .select("id, before, after")
        .eq("entity", entity);
      expect(error).toBeNull();
      expect(data, entity).toEqual([]);
    }
    for (const action of PAY_ACTIONS) {
      const { data } = await c.adminUser.client.from("audit_log").select("id").eq("action", action);
      expect(data, action).toEqual([]);
    }
    // Whatever the admin does see holds no payroll row, and they keep the rest of the log.
    const { data: all } = await c.adminUser.client
      .from("audit_log")
      .select("action, entity")
      .eq("organisation_id", c.owner.orgId)
      .limit(1000);
    expect((all ?? []).length).toBeGreaterThan(0);
    for (const row of all ?? []) {
      expect(row.action).not.toMatch(/^(payroll|statutory)\./);
      expect(row.entity).not.toMatch(
        /^(pay_rates|tax_rule_sets|payroll_|payslip|payout_|statutory_)/,
      );
    }
  });

  it("leaves hr and finance with no audit log (they never had it)", async () => {
    for (const user of [c.hr, c.finance]) {
      const { data } = await user.client.from("audit_log").select("id").limit(5);
      expect(data).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Reverse the later run first
// ---------------------------------------------------------------------------

/** A run for one worker with extra lines (arrears), acknowledged and submitted. */
async function submitWith(
  owner: TenantUser,
  worker: { workerId: string; payRateId: string },
  periodStart: string,
  extra: { code: string; label: string; amount: number; sources: unknown[] }[],
): Promise<string> {
  const created = await owner.client.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: periodStart,
  });
  expect(created.error).toBeNull();
  const runId = created.data!;
  const saved = await saveResults(
    admin,
    owner,
    runId,
    resultsFor(
      { ...worker, adjustmentId: null },
      { period: { start: periodStart, end: periodEnd(periodStart) }, extra },
    ),
  );
  expect(saved.error).toBeNull();
  await acknowledgeAndSubmit(owner, runId);
  return runId;
}

describe("a reversal waits for the later runs that depend on it (MLFX1)", () => {
  it("(a) refuses while a later run pays arrears dated in the run's period", async () => {
    const c = await company("rev-a");
    const paid = await addPayrollWorker(admin, c.owner.orgId);
    const late = await addPayrollWorker(admin, c.owner.orgId);
    // A day of `late`'s in October that the October run (for `paid` only) doesn't pay.
    const day = await addLine(c.owner.orgId, late.workerId, "2026-10-05");
    const oct = await submitRunFor(admin, c.owner, paid, OCT_START);
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    await submitWith(c.owner, late, NOV_START, [
      {
        code: "arrears",
        label: "20 Sep to 19 Oct, approved after posting",
        amount: 400_000,
        sources: [{ kind: "timesheet_line", id: day, from: "2026-10-05", to: "2026-10-05" }],
      },
    ]);
    const { error } = await reverse(c.finance.client, c.owner.orgId, oct);
    expect(error?.code).toBe("MLFX1");
    expect(error?.message).toBe("Reverse the later run first: November 2026");
    const blocker = await c.finance.client.rpc("payroll_reversal_blocker", {
      p_organisation_id: c.owner.orgId,
      p_run_id: oct,
    });
    expect(blocker.data).toBe("November 2026");
    // Only payroll readers ask.
    const asAdmin = await c.adminUser.client.rpc("payroll_reversal_blocker", {
      p_organisation_id: c.owner.orgId,
      p_run_id: oct,
    });
    expect(asAdmin.error?.code).toBe("42501");
  });

  it("(b) refuses while a later-period run holds one of the run's workers", async () => {
    const c = await company("rev-b");
    const worker = await addPayrollWorker(admin, c.owner.orgId);
    const oct = await submitRunFor(admin, c.owner, worker, OCT_START);
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    await submitRunFor(admin, c.owner, worker, NOV_START);
    const { error } = await reverse(c.finance.client, c.owner.orgId, oct);
    expect(error?.code).toBe("MLFX1");
    expect(error?.message).toBe("Reverse the later run first: November 2026");
  });

  it("(c) refuses while a run approved after it counted its payslip in the month's PAYE", async () => {
    const c = await company("rev-c");
    const worker = await addPayrollWorker(admin, c.owner.orgId);
    const oct = await submitRunFor(admin, c.owner, worker, OCT_START);
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    // September's run, paid on 2 October (the same pay month as October's 25 Oct), approved after.
    const sep = await submitRunFor(admin, c.owner, worker, "2026-08-20", "2026-10-02");
    await approveRun(admin, c.owner.orgId, sep, c.finance);
    const { error } = await reverse(c.finance.client, c.owner.orgId, oct);
    expect(error?.code).toBe("MLFX1");
    expect(error?.message).toBe("Reverse the later run first: September 2026");
  });

  it("refuses the approval too, and allows it once the later run is reversed first", async () => {
    const c = await company("rev-order");
    const worker = await addPayrollWorker(admin, c.owner.orgId);
    const oct = await submitRunFor(admin, c.owner, worker, OCT_START);
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    // The reversal is asked for while nothing depends on October...
    const asked = await reverse(c.finance.client, c.owner.orgId, oct);
    expect(asked.error).toBeNull();
    // ...then November is made and approved for the same worker.
    const nov = await submitRunFor(admin, c.owner, worker, NOV_START);
    await approveRun(admin, c.owner.orgId, nov, c.finance);
    const refused = await approveReversal(c.finance2.client, c.owner.orgId, asked.data!);
    expect(refused.error?.code).toBe("MLFX1");
    expect(refused.error?.message).toBe("Reverse the later run first: November 2026");
    const { data: still } = await admin
      .from("payroll_runs")
      .select("status")
      .eq("id", oct)
      .single();
    expect(still).toEqual({ status: "approved" });

    // November reversed first (asked by one person, approved by another)...
    const novAsked = await reverse(c.finance.client, c.owner.orgId, nov);
    expect(novAsked.error).toBeNull();
    expect(
      (await approveReversal(c.finance2.client, c.owner.orgId, novAsked.data!)).error,
    ).toBeNull();
    // ...then October's waiting reversal goes through.
    expect((await approveReversal(c.finance2.client, c.owner.orgId, asked.data!)).error).toBeNull();
    const { data: runs } = await admin
      .from("payroll_runs")
      .select("id, status")
      .in("id", [oct, nov]);
    expect(runs!.map((r) => r.status).sort()).toEqual(["reversed", "reversed"]);
  });

  it("runs in replica mode too (ENABLE ALWAYS)", async () => {
    const { rows } = await db.query<{ tgenabled: string }>(
      `select tgenabled from pg_trigger
       where tgrelid = 'public.payroll_runs'::regclass and tgname = 'payroll_runs_reversal_order'`,
    );
    expect(rows).toEqual([{ tgenabled: "A" }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Approval and month-aggregate PAYE
// ---------------------------------------------------------------------------

describe("approving with month-aggregate PAYE (5.7b) checks the month again", () => {
  let c: Company;
  let worker: { workerId: string; payRateId: string };
  let oct: string;

  /** A one-off run for the worker paid 16 Oct: a ₦15,000 award, its trace's PAYE steps given. */
  async function oneOff(monthToDate: number | null): Promise<string> {
    const run = await c.owner.client.rpc("create_off_cycle_run", {
      p_organisation_id: c.owner.orgId,
      p_period_start: OCT_START,
      p_pay_date: "2026-10-16",
      p_reason: "one_off",
      p_note: "Long-service award",
      p_worker_ids: [worker.workerId],
    });
    expect(run.error).toBeNull();
    const runId = run.data!;
    const bonus = await c.owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: c.owner.orgId,
      p_run_id: runId,
      p_worker_id: worker.workerId,
      p_kind: "earning",
      p_label: "Long-service award",
      p_amount_kobo: "1500000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Ten years with the company",
    });
    expect(bonus.error).toBeNull();
    const steps: Record<string, unknown>[] = [
      {
        step: "annual_gross",
        label: "Taxable pay (₦15,000 × 12)",
        formula: "₦15,000 × 12",
        inputs: { monthly_kobo: "1500000" },
        value_kobo: "18000000",
        rule_ref: "paye",
      },
    ];
    if (monthToDate !== null) {
      steps.push({
        step: "month_to_date",
        label: "Plus this month's other payslip",
        formula: "Taxable pay less pension and NHF already paid this month",
        inputs: { payslips: monthToDate, monthly_kobo: "11040000" },
        value_kobo: "132480000",
        rule_ref: "paye.month_aggregate",
      });
    }
    const doc = resultsFor(
      { ...worker, adjustmentId: null },
      {
        anomalies: [],
        mutate: (d) => {
          const slip = (d.payslips as Record<string, unknown>[])[0]!;
          slip.pay_rate_ids = [];
          slip.trace = { trace_version: 1, steps };
          slip.lines = [
            {
              code: "adjustment_earning",
              kind: "earning",
              label: "Long-service award",
              amount_kobo: "1500000",
              pensionable: false,
              taxable: true,
              sources: [{ kind: "adjustment", id: bonus.data!, from: OCT_START, to: OCT_END }],
            },
            {
              code: "nsitf",
              kind: "employer",
              label: "NSITF 1%",
              amount_kobo: "15000",
              pensionable: false,
              taxable: false,
              sources: [],
            },
          ];
          Object.assign(slip, {
            gross_kobo: "1500000",
            paye_kobo: "0",
            pension_employee_kobo: "0",
            net_kobo: "1500000",
            pension_employer_kobo: "0",
            nsitf_kobo: "15000",
            employer_cost_kobo: "1515000",
          });
          d.totals = {
            gross_kobo: "1500000",
            paye_kobo: "0",
            pension_employee_kobo: "0",
            pension_employer_kobo: "0",
            nhf_kobo: "0",
            other_deductions_kobo: "0",
            net_kobo: "1500000",
            nsitf_kobo: "15000",
            itf_kobo: "0",
            employer_cost_kobo: "1515000",
            carried_forward_kobo: "0",
            worker_count: 1,
          };
        },
      },
    );
    const saved = await saveResults(admin, c.owner, runId, doc);
    expect(saved.error).toBeNull();
    await acknowledgeAndSubmit(c.owner, runId);
    return runId;
  }

  beforeAll(async () => {
    c = await company("month");
    worker = await addPayrollWorker(admin, c.owner.orgId);
    oct = await submitRunFor(admin, c.owner, worker, OCT_START);
  });

  it("refuses when another run for the worker in the month was approved after the read", async () => {
    // Worked out before October posted, so its PAYE counted no other payslip.
    const award = await oneOff(null);
    const read = await clock();
    await check(c.owner.orgId, award, c.finance2.id, read);
    // October (pay date 25 Oct) is approved after the award's read began.
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    const { error } = await approve(c.finance2.client, c.owner.orgId, award);
    expect(error?.code).toBe("MLPRF");

    // A fresh read doesn't help: the award's PAYE didn't count October's payslip.
    await check(c.owner.orgId, award, c.finance2.id);
    const again = await approve(c.finance2.client, c.owner.orgId, award);
    expect(again.error?.code).toBe("MLPRF");
    const { data } = await admin.from("payroll_runs").select("status").eq("id", award).single();
    expect(data).toEqual({ status: "review" });
  });

  it("approves a run whose PAYE counted the month's standing payslips", async () => {
    const award = await oneOff(1);
    await check(c.owner.orgId, award, c.finance2.id);
    const { error } = await approve(c.finance2.client, c.owner.orgId, award);
    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Guards replica mode doesn't skip; no session setting
// ---------------------------------------------------------------------------

describe("the rule set and pay rate guards are ENABLE ALWAYS", () => {
  let c: Company;
  let payRateId: string;
  let ruleSetId: string;

  beforeAll(async () => {
    c = await company("guards");
    const worker = await addPayrollWorker(admin, c.owner.orgId);
    payRateId = worker.payRateId;
    const oct = await submitRunFor(admin, c.owner, worker, OCT_START);
    await approveRun(admin, c.owner.orgId, oct, c.finance);
    const { data } = await admin.from("payroll_runs").select("rule_set_id").eq("id", oct).single();
    ruleSetId = data!.rule_set_id!;
    expect(ruleSetId).toBeTruthy();
  });

  it("marks each trigger as firing always", async () => {
    const { rows } = await db.query<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger
       where tgname in ('tax_rule_sets_guard', 'tax_rule_sets_no_truncate',
                        'tax_rule_sets_used_by_run', 'pay_rates_guard')
       order by tgname`,
    );
    expect(rows).toEqual([
      { tgname: "pay_rates_guard", tgenabled: "A" },
      { tgname: "tax_rule_sets_guard", tgenabled: "A" },
      { tgname: "tax_rule_sets_no_truncate", tgenabled: "A" },
      { tgname: "tax_rule_sets_used_by_run", tgenabled: "A" },
    ]);
  });

  it("refuses rule set changes, deletes and truncation in replica mode", async () => {
    for (const sql of [
      "update public.tax_rule_sets set name = 'Renamed' where id = $1",
      "delete from public.tax_rule_sets where id = $1",
    ]) {
      const { error } = await asDbOwner(sql, [ruleSetId], true);
      expect(error?.code, sql).toBe("MLPR8");
    }
    const truncated = await asDbOwner("truncate public.tax_rule_sets cascade", [], true);
    expect(truncated.error?.code).toBe("MLPR8");
  });

  it("refuses a change to a pay rate posted payroll used, in replica mode", async () => {
    const { error } = await asDbOwner(
      "update public.pay_rates set basic_kobo = 1 where id = $1",
      [payRateId],
      true,
    );
    expect(error?.code).toBe("MLPRG");
  });

  it("no longer lets the session setting close a version", async () => {
    const { error } = await asDbOwner(
      "update public.tax_rule_sets set effective_to = current_date + 5 where id = $1",
      [ruleSetId],
      false,
      ["select set_config('metalira.tax_rule_set_closing', 'on', true)"],
    );
    expect(error?.code).toBe("MLPR8");
    const { data } = await admin
      .from("tax_rule_sets")
      .select("effective_to")
      .eq("id", ruleSetId)
      .single();
    expect(data).toEqual({ effective_to: null });
  });

  it("keeps the closing record out of every API role's reach", async () => {
    const { rows } = await db.query<{ role: string; can: boolean }>(
      `select r as role, has_table_privilege(r, 'private.tax_rule_set_closings', 'insert') as can
       from unnest(array['anon', 'authenticated', 'service_role']) r order by r`,
    );
    expect(rows).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: false },
    ]);
  });
});
