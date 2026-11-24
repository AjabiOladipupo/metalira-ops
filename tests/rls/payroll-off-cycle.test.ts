/**
 * Slice 5.7b: off-cycle payroll runs (docs/PHASE_5.md "As built in 5.7b") against the real
 * database.
 * - One regular run per company and period (5.2's partial unique index); several off-cycle runs
 *   share a period with it and with each other.
 * - No double payment: an off-cycle run can't pay a source a standing payslip already pays
 *   (5.2's exclusion constraint, MLPRC), before and after the regular run is approved; a full-pay
 *   off-cycle run is refused for a worker a posted run already paid (MLOC3) or who is on another
 *   one for the period (MLOC4); a correction or one-off run pays adjustments only (MLOC6).
 * - Two people (rule 10): the same approval as a regular run (MLPRE for whoever prepared it, hr
 *   never approves); approval posts it and makes its own remittances (5.6) without locking the
 *   period for the regular run (5.3's lock counts regular runs only); a timesheet day it pays is
 *   held for everyone, the database owner included (MLTA5).
 * - Its workers and reason are fixed (MLOC8); its adjustments are one-off and for its workers
 *   (MLOC5); its payslips are for its workers (MLOC6); a draft is discarded with a reason and then
 *   never changes (MLOC7).
 *
 * Results are saved with the secret key and the hash `SHA` (helpers/payroll.ts), as the server does
 * after running the engine; the SQL checks identities and sources, not tax.
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
  seedPayrollRun,
  SHA,
} from "./helpers/payroll";
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

async function addMember(user: TestUser, role: Role, orgId: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

const createOffCycle = (
  client: Client,
  orgId: string,
  workerIds: string[],
  reason: "final_pay" | "missed_worker" | "correction" | "one_off",
  over: { periodStart?: string; payDate?: string; note?: string } = {},
) =>
  client.rpc("create_off_cycle_run", {
    p_organisation_id: orgId,
    p_period_start: over.periodStart ?? OCT_START,
    p_pay_date: over.payDate ?? "2026-10-16",
    p_reason: reason,
    p_note: over.note ?? "Resigned, last day 5 October",
    p_worker_ids: workerIds,
  });

async function clock(): Promise<string> {
  const { data, error } = await admin.rpc("payroll_clock");
  expect(error).toBeNull();
  return data!;
}

const check = async (orgId: string, runId: string, actor: string) =>
  admin.rpc("record_payroll_approval_check", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: actor,
    p_inputs_sha256: SHA,
    p_read_started_at: await clock(),
  });

const approve = (client: Client, orgId: string, runId: string) =>
  client.rpc("approve_payroll_run", { p_organisation_id: orgId, p_run_id: runId });

/** Acknowledges every warning as `who`, then submits as `who`. */
async function submit(who: Client, orgId: string, runId: string) {
  const { data: anomalies } = await admin
    .from("payroll_anomalies")
    .select("id")
    .eq("run_id", runId);
  if ((anomalies ?? []).length > 0) {
    const ack = await who.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: orgId,
      p_run_id: runId,
      p_anomaly_ids: (anomalies ?? []).map((a) => a.id),
    });
    expect(ack.error).toBeNull();
  }
  const submitted = await who.rpc("submit_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
  });
  expect(submitted.error).toBeNull();
}

/** Rows as the database owner with triggers off for the transaction. */
async function seedRaw(sql: string, params: unknown[]) {
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(sql, params);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

/** An approved timesheet day for the worker, with a shift. */
async function addLine(orgId: string, workerId: string, workDate: string) {
  await seedRaw(
    `insert into public.timesheets (organisation_id, worker_id, period_start, period_end)
     values ($1, $2, private.timesheet_period_start($3::date, 20),
             private.timesheet_period_end(private.timesheet_period_start($3::date, 20)))
     on conflict (organisation_id, worker_id, period_start) do nothing`,
    [orgId, workerId, workDate],
  );
  const id = randomUUID();
  await seedRaw(
    `insert into public.timesheet_lines (id, organisation_id, timesheet_id, worker_id, work_date,
       shift_assignment_id, shift_id, post_id, scheduled_minutes, worked_minutes, ot_minutes,
       status, exceptions)
     select $1, $2, t.id, $3, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 480,
            480, 60, 'approved', '{}'
     from public.timesheets t
     where t.organisation_id = $2 and t.worker_id = $3
       and t.period_start = private.timesheet_period_start($4::date, 20)`,
    [id, orgId, workerId, workDate],
  );
  return id;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("one regular run per period, any number of off-cycle runs", () => {
  it("refuses a second regular run but lets off-cycle runs share the period", async () => {
    const owner = await createTenantUser("poff-share", "Off-cycle Share Org");
    const regular = await seedPayrollRun(admin, owner);
    const again = await owner.client.rpc("create_payroll_run", {
      p_organisation_id: owner.orgId,
      p_period_start: OCT_START,
    });
    expect(again.error?.code).toBe("MLPRA");

    const first = await createOffCycle(owner.client, owner.orgId, [regular.workerId], "one_off");
    expect(first.error).toBeNull();
    const second = await createOffCycle(
      owner.client,
      owner.orgId,
      [regular.workerId],
      "correction",
    );
    expect(second.error).toBeNull();

    const { data: runs } = await admin
      .from("payroll_runs")
      .select("kind, off_cycle_reason, period_start, status")
      .eq("organisation_id", owner.orgId)
      .order("created_at");
    expect(runs).toEqual([
      { kind: "regular", off_cycle_reason: null, period_start: OCT_START, status: "draft" },
      { kind: "off_cycle", off_cycle_reason: "one_off", period_start: OCT_START, status: "draft" },
      {
        kind: "off_cycle",
        off_cycle_reason: "correction",
        period_start: OCT_START,
        status: "draft",
      },
    ]);
    const { data: chosen } = await admin
      .from("payroll_run_workers")
      .select("worker_id")
      .eq("run_id", first.data!);
    expect(chosen).toEqual([{ worker_id: regular.workerId }]);

    // The kind and reason go together, and a regular run never carries an off-cycle reason.
    await expect(
      db.query(
        "update public.payroll_runs set off_cycle_reason = 'one_off', off_cycle_note = 'x' where id = $1",
        [regular.runId],
      ),
    ).rejects.toMatchObject({ code: "MLOC8" });
  });

  it("checks who creates it and for whom", async () => {
    const owner = await createTenantUser("poff-who", "Off-cycle Who Org");
    const finance = await createTestUser("poff-who-fin");
    await addMember(finance, "finance", owner.orgId);
    const { workerId } = await addPayrollWorker(admin, owner.orgId);
    const { workerId: gone } = await addPayrollWorker(admin, owner.orgId, {
      start_date: "2025-01-06",
      end_date: "2026-08-31",
    });
    const other = await createTenantUser("poff-who-other", "Off-cycle Who Other Org");
    const { workerId: theirs } = await addPayrollWorker(admin, other.orgId);

    expect(
      (await createOffCycle(finance.client, owner.orgId, [workerId], "one_off")).error?.code,
    ).toBe(DENIED);
    expect((await createOffCycle(owner.client, owner.orgId, [theirs], "one_off")).error?.code).toBe(
      "MLOC1",
    );
    expect((await createOffCycle(owner.client, owner.orgId, [gone], "one_off")).error?.code).toBe(
      "MLOC1",
    );
    // A final pay needs the worker's last day inside the period.
    expect(
      (await createOffCycle(owner.client, owner.orgId, [workerId], "final_pay")).error?.code,
    ).toBe("MLOC2");
    expect(
      (
        await createOffCycle(owner.client, owner.orgId, [workerId], "missed_worker", {
          payDate: "2026-12-31",
        })
      ).error?.code,
    ).toBe("22023");
    expect(
      (await createOffCycle(owner.client, owner.orgId, [workerId], "one_off", { note: "  " })).error
        ?.code,
    ).toBe("22023");
    expect((await createOffCycle(owner.client, owner.orgId, [], "one_off")).error?.code).toBe(
      "22023",
    );
  });
});

describe("no double payment", () => {
  it("refuses an off-cycle run paying a source the regular run pays, before and after approval", async () => {
    const owner = await createTenantUser("poff-double", "Off-cycle Double Org");
    const finance = await createTestUser("poff-double-fin");
    await addMember(finance, "finance", owner.orgId);
    // October's regular run pays the worker's salary for the whole period (a draft, with an
    // allowance for the worker).
    const regular = await seedPayrollRun(admin, owner);

    // A missed-worker run for the same worker can still be created while the regular run isn't
    // posted (the server then leaves the worker out of the regular run on recalculation); it takes
    // the worker's allowance over from the regular draft (money review M1)...
    const missed = await createOffCycle(
      owner.client,
      owner.orgId,
      [regular.workerId],
      "missed_worker",
      {
        note: "Missed from October",
      },
    );
    expect(missed.error).toBeNull();
    const { data: moved } = await admin
      .from("payroll_adjustments")
      .select("run_id")
      .eq("id", regular.adjustmentId)
      .single();
    expect(moved).toEqual({ run_id: missed.data! });
    const { data: regularRun } = await admin
      .from("payroll_runs")
      .select("needs_recalculation")
      .eq("id", regular.runId)
      .single();
    expect(regularRun).toEqual({ needs_recalculation: true });
    const doc = resultsFor({
      workerId: regular.workerId,
      payRateId: regular.payRateId,
      adjustmentId: null,
    });
    // ...but it can't pay the same pay version's days while the regular payslip stands.
    const whileDraft = await saveResults(admin, owner, missed.data!, doc);
    expect(whileDraft.error?.code).toBe("MLPRC");

    // The regular run worked out again without the allowance, submitted and approved: still
    // refused, and a new full-pay run for the worker is refused up front.
    expect(
      (
        await saveResults(
          admin,
          owner,
          regular.runId,
          resultsFor({
            workerId: regular.workerId,
            payRateId: regular.payRateId,
            adjustmentId: null,
          }),
        )
      ).error,
    ).toBeNull();
    await submit(owner.client, owner.orgId, regular.runId);
    expect((await check(owner.orgId, regular.runId, finance.id)).error).toBeNull();
    expect((await approve(finance.client, owner.orgId, regular.runId)).error).toBeNull();
    const afterApproval = await saveResults(admin, owner, missed.data!, doc);
    expect(afterApproval.error?.code).toBe("MLPRC");
    const refused = await createOffCycle(
      owner.client,
      owner.orgId,
      [regular.workerId],
      "missed_worker",
    );
    expect(refused.error?.code).toBe("MLOC3");

    // Nothing of the off-cycle run was saved.
    const { count } = await admin
      .from("payslips")
      .select("id", { count: "exact", head: true })
      .eq("run_id", missed.data!);
    expect(count).toBe(0);
  });

  it("refuses a second full-pay run for the same worker and period", async () => {
    const owner = await createTenantUser("poff-twice", "Off-cycle Twice Org");
    const { workerId } = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" });
    expect(
      (await createOffCycle(owner.client, owner.orgId, [workerId], "final_pay")).error,
    ).toBeNull();
    const again = await createOffCycle(owner.client, owner.orgId, [workerId], "missed_worker");
    expect(again.error?.code).toBe("MLOC4");
    // A one-off payment beside it is fine.
    expect(
      (await createOffCycle(owner.client, owner.orgId, [workerId], "one_off")).error,
    ).toBeNull();
  });

  it("lets a correction or one-off run pay adjustments only, for its own workers", async () => {
    const owner = await createTenantUser("poff-oneoff", "Off-cycle One-off Org");
    const { workerId, payRateId } = await addPayrollWorker(admin, owner.orgId);
    const { workerId: someoneElse, payRateId: otherRate } = await addPayrollWorker(
      admin,
      owner.orgId,
    );
    const run = await createOffCycle(owner.client, owner.orgId, [workerId], "one_off", {
      note: "Long-service award",
    });
    expect(run.error).toBeNull();
    const runId = run.data!;

    // Adjustments: for the run's workers, one-off only.
    const add = (worker: string, instalments = 1) =>
      owner.client.rpc("add_payroll_adjustment", {
        p_organisation_id: owner.orgId,
        p_run_id: runId,
        p_worker_id: worker,
        p_kind: "earning",
        p_label: "Long-service award",
        p_amount_kobo: "1500000",
        p_pensionable: false,
        p_taxable: true,
        p_instalments: instalments,
        p_reason: "Ten years with the company",
      });
    expect((await add(someoneElse)).error?.code).toBe("MLOC5");
    expect((await add(workerId, 3)).error?.code).toBe("MLOC5");
    const bonus = await add(workerId);
    expect(bonus.error).toBeNull();

    // A salary source on a one-off run is refused; so is a payslip for a worker not on the run.
    const withSalary = await saveResults(
      admin,
      owner,
      runId,
      resultsFor({ workerId, payRateId, adjustmentId: bonus.data! }),
    );
    expect(withSalary.error?.code).toBe("MLOC6");
    const notOnRun = await saveResults(
      admin,
      owner,
      runId,
      resultsFor({ workerId: someoneElse, payRateId: otherRate, adjustmentId: null }),
    );
    expect(notOnRun.error?.code).toBe("MLOC6");

    // The award alone: gross ₦15,000, no pension, NSITF ₦150.
    const awardOnly = resultsFor(
      { workerId, payRateId, adjustmentId: null },
      {
        anomalies: [],
        mutate: (doc) => {
          const slip = (doc.payslips as Record<string, unknown>[])[0]!;
          slip.pay_rate_ids = [];
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
          doc.totals = {
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
    const saved = await saveResults(admin, owner, runId, awardOnly);
    expect(saved.error).toBeNull();
    const { data: sources } = await admin
      .from("payslip_sources")
      .select("source_kind")
      .eq("run_id", runId);
    expect(sources).toEqual([{ source_kind: "adjustment" }]);
  });
});

describe("approval, posting and what an off-cycle run holds", () => {
  let owner: TenantUser;
  let hr: TestUser;
  let finance: TestUser;
  let runId: string;
  let paidDay: string;
  let workerId: string;
  let paidLeave: string;

  beforeAll(async () => {
    owner = await createTenantUser("poff-final", "Off-cycle Final Org");
    hr = await createTestUser("poff-final-hr");
    finance = await createTestUser("poff-final-fin");
    await addMember(hr, "hr", owner.orgId);
    await addMember(finance, "finance", owner.orgId);
    const leaver = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" });
    workerId = leaver.workerId;
    paidDay = await addLine(owner.orgId, workerId, "2026-10-01");
    const typeId = randomUUID();
    await seedRaw(
      `insert into public.leave_types (id, organisation_id, code, name, counting, paid)
       values ($1, $2, 'unpaid_test', 'Unpaid', 'working_days', false)`,
      [typeId, owner.orgId],
    );
    paidLeave = randomUUID();
    await seedRaw(
      `insert into public.leave_requests (id, organisation_id, worker_id, leave_type_id, leave_year,
         start_date, end_date, days, status, decided_at)
       values ($1, $2, $3, $4, 2026, '2026-09-28', '2026-09-28', 1, 'approved', now())`,
      [paidLeave, owner.orgId, workerId, typeId],
    );
    const created = await createOffCycle(owner.client, owner.orgId, [workerId], "final_pay");
    expect(created.error).toBeNull();
    runId = created.data!;
    const doc = resultsFor(
      { workerId, payRateId: leaver.payRateId, adjustmentId: null },
      {
        extra: [
          {
            code: "overtime",
            label: "Overtime, 1 h at ₦750 an hour",
            amount: 75_000,
            sources: [
              { kind: "timesheet_line", id: paidDay, from: "2026-10-01", to: "2026-10-01" },
            ],
          },
          {
            code: "leave_deduction",
            label: "Unpaid leave, 1 day",
            amount: 0,
            sources: [
              { kind: "leave_request", id: paidLeave, from: "2026-09-28", to: "2026-09-28" },
            ],
          },
        ],
      },
    );
    const saved = await saveResults(admin, owner, runId, doc);
    expect(saved.error).toBeNull();
    await submit(owner.client, owner.orgId, runId);
  });

  it("needs a second person, as a regular run does", async () => {
    // The owner prepared and submitted it; hr never approves.
    expect((await check(owner.orgId, runId, owner.id)).error).toBeNull();
    expect((await approve(owner.client, owner.orgId, runId)).error?.code).toBe("MLPRE");
    expect((await approve(hr.client, owner.orgId, runId)).error?.code).toBe(DENIED);
    expect((await check(owner.orgId, runId, finance.id)).error).toBeNull();
    const approved = await approve(finance.client, owner.orgId, runId);
    expect(approved.error).toBeNull();
    const { data: run } = await admin
      .from("payroll_runs")
      .select("kind, status, approved_by")
      .eq("id", runId)
      .single();
    expect(run).toEqual({ kind: "off_cycle", status: "approved", approved_by: finance.id });
  });

  it("makes its own remittances and leaves the period open for the regular run", async () => {
    const { data: remittances } = await admin
      .from("statutory_remittances")
      .select("kind")
      .eq("run_id", runId)
      .order("kind");
    expect((remittances ?? []).map((r) => r.kind)).toEqual(["nsitf", "paye", "pension"]);
    const { rows } = await db.query<{ posted: boolean }>(
      "select private.timesheet_period_posted($1, '2026-10-01') as posted",
      [owner.orgId],
    );
    expect(rows[0]!.posted).toBe(false);
    // The regular run for the period can still be made.
    const regular = await owner.client.rpc("create_payroll_run", {
      p_organisation_id: owner.orgId,
      p_period_start: OCT_START,
    });
    expect(regular.error).toBeNull();
  });

  it("holds the timesheet day it paid, for the database owner too", async () => {
    await expect(
      db.query("update public.timesheet_lines set worked_minutes = 600 where id = $1", [paidDay]),
    ).rejects.toMatchObject({ code: "MLTA5" });
    for (const sql of [
      "update public.timesheet_lines set status = 'pending' where id = $1",
      "delete from public.timesheet_lines where id = $1",
    ]) {
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await expect(db.query(sql, [paidDay]), sql).rejects.toMatchObject({ code: "MLTA5" });
      } finally {
        await db.query("rollback");
      }
    }
    // A day the run didn't pay (same worker, same period) still moves.
    const unpaid = await addLine(owner.orgId, workerId, "2026-10-02");
    await seedRaw("update public.timesheet_lines set worked_minutes = 470 where id = $1", [unpaid]);
  });

  it("holds the leave it paid (security M3)", async () => {
    const cancel = await hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: paidLeave,
      p_reason: "Came to work after all",
    });
    expect(cancel.error?.code).toBe("MLTA5");
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await expect(
        db.query("update public.leave_requests set status = 'cancelled' where id = $1", [
          paidLeave,
        ]),
      ).rejects.toMatchObject({ code: "MLTA5" });
    } finally {
      await db.query("rollback");
    }
    const { data } = await admin
      .from("leave_requests")
      .select("status")
      .eq("id", paidLeave)
      .single();
    expect(data).toEqual({ status: "approved" });
  });

  it("pays a day approved after the final pay posted in a correction run, once (money M2)", async () => {
    const late = await addLine(owner.orgId, workerId, "2026-10-05");
    const doc = earningsOnly(workerId, [
      {
        code: "overtime",
        amount: 75_000,
        sources: [{ kind: "timesheet_line", id: late, from: "2026-10-05", to: "2026-10-05" }],
      },
    ]);
    const first = await createOffCycle(owner.client, owner.orgId, [workerId], "correction", {
      note: "Day approved after the final pay",
    });
    expect(first.error).toBeNull();
    expect((await saveResults(admin, owner, first.data!, doc)).error).toBeNull();
    // The day the final pay already paid, or the same late day again, is refused.
    const second = await createOffCycle(owner.client, owner.orgId, [workerId], "correction", {
      note: "Paid again by mistake",
    });
    expect(second.error).toBeNull();
    expect((await saveResults(admin, owner, second.data!, doc)).error?.code).toBe("MLPRC");
    const again = earningsOnly(workerId, [
      {
        code: "overtime",
        amount: 75_000,
        sources: [{ kind: "timesheet_line", id: paidDay, from: "2026-10-01", to: "2026-10-01" }],
      },
    ]);
    expect((await saveResults(admin, owner, second.data!, again)).error?.code).toBe("MLPRC");
    // Never salary on a correction.
    const salary = earningsOnly(workerId, [
      {
        code: "basic",
        amount: 75_000,
        sources: [{ kind: "timesheet_line", id: late, from: "2026-10-05", to: "2026-10-05" }],
      },
    ]);
    expect((await saveResults(admin, owner, second.data!, salary)).error?.code).toBe("MLOC9");
  });

  it("keeps its workers fixed", async () => {
    await expect(
      db.query(
        `insert into public.payroll_run_workers (organisation_id, run_id, worker_id, created_by)
         values ($1, $2, $3, $4)`,
        [owner.orgId, runId, randomUUID(), owner.id],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(MLOC8|23503)$/) });
    await expect(
      db.query("delete from public.payroll_run_workers where run_id = $1", [runId]),
    ).rejects.toMatchObject({ code: "MLOC8" });
    await expect(db.query("truncate public.payroll_run_workers")).rejects.toMatchObject({
      code: "MLPRD",
    });
    // Signed-in roles can't write it at all.
    const attack = await owner.client.from("payroll_run_workers").insert({
      organisation_id: owner.orgId,
      run_id: runId,
      worker_id: workerId,
      created_by: owner.id,
    });
    expect(attack.error?.code).toBe(DENIED);
  });
});

describe("discarding an off-cycle draft", () => {
  it("removes its draft payslips and adjustments, then the run never changes", async () => {
    const owner = await createTenantUser("poff-discard", "Off-cycle Discard Org");
    const finance = await createTestUser("poff-discard-fin");
    await addMember(finance, "finance", owner.orgId);
    const regular = await seedPayrollRun(admin, owner);
    const { workerId, payRateId } = await addPayrollWorker(admin, owner.orgId, {
      end_date: "2026-10-05",
    });
    const created = await createOffCycle(owner.client, owner.orgId, [workerId], "final_pay");
    expect(created.error).toBeNull();
    const runId = created.data!;
    const adj = await owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_worker_id: workerId,
      p_kind: "earning",
      p_label: "Leave encashment",
      p_amount_kobo: "1500000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Six days not taken",
    });
    expect(adj.error).toBeNull();
    expect(
      (
        await saveResults(
          admin,
          owner,
          runId,
          resultsFor({ workerId, payRateId, adjustmentId: adj.data! }),
        )
      ).error,
    ).toBeNull();

    const discard = (client: Client, run: string, reason = "Paid in the regular run instead") =>
      client.rpc("discard_off_cycle_run", {
        p_organisation_id: owner.orgId,
        p_run_id: run,
        p_reason: reason,
      });
    expect((await discard(finance.client, runId)).error?.code).toBe(DENIED);
    expect((await discard(owner.client, regular.runId)).error?.code).toBe("MLOC7");
    expect((await discard(owner.client, runId, "")).error?.code).toBe("22023");
    expect((await discard(owner.client, runId)).error).toBeNull();

    const { data: run } = await admin
      .from("payroll_runs")
      .select("status, discarded_by, discard_reason, worker_count, net_kobo")
      .eq("id", runId)
      .single();
    expect(run).toEqual({
      status: "draft",
      discarded_by: owner.id,
      discard_reason: "Paid in the regular run instead",
      worker_count: 0,
      net_kobo: 0,
    });
    for (const table of ["payslips", "payslip_sources", "payroll_adjustments"] as const) {
      const { count } = await admin
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("run_id", runId);
      expect(count, table).toBe(0);
    }
    // Its worker's days are free again for another full-pay run of the period.
    expect(
      (await createOffCycle(owner.client, owner.orgId, [workerId], "final_pay")).error,
    ).toBeNull();

    // Never changes again: no recalculation, adjustment, submission or second discard.
    expect(
      (
        await saveResults(
          admin,
          owner,
          runId,
          resultsFor({ workerId, payRateId, adjustmentId: null }),
        )
      ).error?.code,
    ).toBe("MLOC7");
    const again = await owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_worker_id: workerId,
      p_kind: "earning",
      p_label: "Leave encashment",
      p_amount_kobo: "1500000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Six days not taken",
    });
    expect(again.error?.code).toBe("MLOC7");
    const submitted = await owner.client.rpc("submit_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect(submitted.error?.code).toMatch(/^(MLOC7|MLPRD)$/);
    expect((await discard(owner.client, runId)).error?.code).toBe("MLOC7");
    await expect(
      db.query("update public.payroll_runs set discard_reason = 'x' where id = $1", [runId]),
    ).rejects.toMatchObject({ code: "MLOC7" });
  });
});

/** A results document for one worker paying only `earnings` (no tax, no pension), NSITF 1%. */
function earningsOnly(
  workerId: string,
  earnings: { code: string; amount: number; sources: unknown[] }[],
): Record<string, unknown> {
  const gross = earnings.reduce((n, e) => n + e.amount, 0);
  const nsitf = Math.round(gross / 100);
  const totals = {
    gross_kobo: String(gross),
    paye_kobo: "0",
    pension_employee_kobo: "0",
    pension_employer_kobo: "0",
    nhf_kobo: "0",
    other_deductions_kobo: "0",
    net_kobo: String(gross),
    nsitf_kobo: String(nsitf),
    itf_kobo: "0",
    employer_cost_kobo: String(gross + nsitf),
    carried_forward_kobo: "0",
    worker_count: 1,
  };
  return {
    itf_applies: false,
    totals,
    anomalies: [],
    payslips: [
      {
        worker_id: workerId,
        employment_type: "permanent",
        tax_state: "Lagos",
        pfa_name: null,
        pay_rate_ids: [],
        days: { cycle: 30, rostered: 21, employed_rostered: 11, leave_deducted: 0 },
        ...totals,
        trace: { trace_version: 1, steps: [] },
        lines: [
          ...earnings.map((e) => ({
            code: e.code,
            kind: "earning",
            label: e.code,
            amount_kobo: String(e.amount),
            pensionable: false,
            taxable: true,
            sources: e.sources,
          })),
          {
            code: "nsitf",
            kind: "employer",
            label: "NSITF 1%",
            amount_kobo: String(nsitf),
            pensionable: false,
            taxable: false,
            sources: [],
          },
        ],
      },
    ],
  };
}

describe("review fixes", () => {
  it("refuses personal numbers in an off-cycle reason, a discard reason and an adjustment (security M1)", async () => {
    const owner = await createTenantUser("poff-pii", "Off-cycle PII Org");
    const { workerId } = await addPayrollWorker(admin, owner.orgId);
    for (const note of ["NIN 1234 5678 901", "acct 0123-456-789", "RSA PEN100012345678"]) {
      const refused = await createOffCycle(owner.client, owner.orgId, [workerId], "one_off", {
        note,
      });
      expect(refused.error?.code, note).toBe("22023");
    }
    const run = await createOffCycle(owner.client, owner.orgId, [workerId], "one_off", {
      note: "Award for 10 years of service, paid 2026",
    });
    expect(run.error).toBeNull();
    const adj = (label: string, reason: string) =>
      owner.client.rpc("add_payroll_adjustment", {
        p_organisation_id: owner.orgId,
        p_run_id: run.data!,
        p_worker_id: workerId,
        p_kind: "earning",
        p_label: label,
        p_amount_kobo: "1500000",
        p_pensionable: false,
        p_taxable: true,
        p_instalments: 1,
        p_reason: reason,
      });
    expect((await adj("Refund to 0123456789", "Overcharged")).error?.code).toBe("23514");
    expect((await adj("Refund", "Paid to account 012 345 6789")).error?.code).toBe("23514");
    const discard = await owner.client.rpc("discard_off_cycle_run", {
      p_organisation_id: owner.orgId,
      p_run_id: run.data!,
      p_reason: "Wrong worker, BVN 22233344455",
    });
    expect(discard.error?.code).toBe("22023");

    // The SQL helper and src/lib/personal-number.ts agree.
    const { hasPersonalNumber } = await import("@/lib/personal-number");
    for (const text of [
      "123456789",
      "1234567890",
      "12345-67890",
      "12 34 56 78 90",
      "PEN123456789012",
      "pen 1234 5678 9012",
      "PEN12345678901",
      "Award for 10 years, 2026",
      "",
    ]) {
      const { rows } = await db.query<{ has: boolean }>(
        "select private.has_personal_number($1) as has",
        [text],
      );
      expect(rows[0]!.has, text).toBe(hasPersonalNumber(text));
    }
  });

  it("refuses a salary line on a one-off run, and an earning line with no source on any run (security M2)", async () => {
    const owner = await createTenantUser("poff-lines", "Off-cycle Lines Org");
    const { workerId, payRateId } = await addPayrollWorker(admin, owner.orgId);
    const run = await createOffCycle(owner.client, owner.orgId, [workerId], "one_off", {
      note: "Long-service award",
    });
    expect(run.error).toBeNull();
    const award = await owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_run_id: run.data!,
      p_worker_id: workerId,
      p_kind: "earning",
      p_label: "Long-service award",
      p_amount_kobo: "1500000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Ten years with the company",
    });
    expect(award.error).toBeNull();
    // A basic-salary line, even one naming the award as its source.
    const salary = await saveResults(
      admin,
      owner,
      run.data!,
      earningsOnly(workerId, [
        {
          code: "basic",
          amount: 1_500_000,
          sources: [{ kind: "adjustment", id: award.data!, from: OCT_START, to: OCT_END }],
        },
      ]),
    );
    expect(salary.error?.code).toBe("MLOC9");

    // A regular run: an overtime line with no source is refused when the results commit.
    const regular = await seedPayrollRun(admin, owner);
    const doc = resultsFor(
      {
        workerId: regular.workerId,
        payRateId: regular.payRateId,
        adjustmentId: regular.adjustmentId,
      },
      { extra: [{ code: "overtime", label: "Overtime", amount: 75_000, sources: [] }] },
    );
    expect((await saveResults(admin, owner, regular.runId, doc)).error?.code).toBe("MLOC9");
    void payRateId;
  });

  it("keeps the regular run waiting for approval out of a full-pay run's items (money M1)", async () => {
    const owner = await createTenantUser("poff-review", "Off-cycle Review Org");
    const regular = await seedPayrollRun(admin, owner, { submit: true });
    const refused = await createOffCycle(
      owner.client,
      owner.orgId,
      [regular.workerId],
      "missed_worker",
    );
    expect(refused.error?.code).toBe("MLOCA");
  });

  it("sends an item added to the regular draft for a worker on a full-pay draft to that run (money M1)", async () => {
    const owner = await createTenantUser("poff-redirect", "Off-cycle Redirect Org");
    const regular = await seedPayrollRun(admin, owner);
    const final = await createOffCycle(
      owner.client,
      owner.orgId,
      [regular.workerId],
      "missed_worker",
    );
    expect(final.error).toBeNull();
    const added = await owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_run_id: regular.runId,
      p_worker_id: regular.workerId,
      p_kind: "earning",
      p_label: "Leave encashment",
      p_amount_kobo: "1000000",
      p_pensionable: false,
      p_taxable: true,
      p_instalments: 1,
      p_reason: "Six days not taken",
    });
    expect(added.error).toBeNull();
    const { data: rows } = await admin
      .from("payroll_adjustments")
      .select("run_id")
      .eq("worker_id", regular.workerId)
      .order("created_at");
    expect((rows ?? []).map((r) => r.run_id)).toEqual([final.data!, final.data!]);
    // Recurring items stay off an off-cycle run (a final pay may only continue an existing series).
    const recurring = await owner.client.rpc("add_payroll_adjustment", {
      p_organisation_id: owner.orgId,
      p_run_id: final.data!,
      p_worker_id: regular.workerId,
      p_kind: "deduction",
      p_label: "Salary advance",
      p_amount_kobo: "500000",
      p_pensionable: false,
      p_taxable: false,
      p_instalments: 3,
      p_reason: "New advance",
    });
    expect(recurring.error?.code).toBe("MLOC5");
  });

  it("pays a correction or one-off later than 45 days after the period, never a final pay (money L3)", async () => {
    const owner = await createTenantUser("poff-late", "Off-cycle Late Org");
    const { workerId } = await addPayrollWorker(admin, owner.orgId, { end_date: "2026-10-05" });
    expect(
      (
        await createOffCycle(owner.client, owner.orgId, [workerId], "correction", {
          payDate: "2027-03-01",
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await createOffCycle(owner.client, owner.orgId, [workerId], "final_pay", {
          payDate: "2027-03-01",
        })
      ).error?.code,
    ).toBe("22023");
  });
});
