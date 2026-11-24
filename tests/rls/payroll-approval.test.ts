/**
 * Slice 5.3: two-person approval, posting and the period lock (docs/PHASE_5.md 5.3) against the
 * real database.
 * - Two people (rule 10): the preparer is refused (MLPRE), including an owner who prepared; so is
 *   anyone who acknowledged an anomaly or recalculated; hr can never approve (42501); a second
 *   person in Finance (or another owner) approves.
 * - Decision 7: approval needs the approver's own server check (record_payroll_approval_check,
 *   the secret key only) with the hash the run was worked out from (MLPRF otherwise).
 * - Posted is final (rule 5): the run, payslips, lines, sources, adjustments, anomalies and
 *   decisions refuse every change for signed-in roles, the secret key and the database owner, even
 *   with session_replication_role = replica, and can't be truncated.
 * - The period lock: timesheet_period_posted is true inside the posted period only; 4.3's reopen
 *   and dispute refuse with MLTA5; the database owner can't move an approved day either.
 * - Backdated pay rates (Phase 1 decision 17): back to the day after the posted period, never into
 *   it; a version a posted payslip used never changes or goes (MLPRG).
 * - A rule-set version a posted run used may still close for a new version from tomorrow.
 *
 * Runs are seeded as in payroll-runs.test.ts (helpers/payroll.ts): results saved with the secret
 * key and the hash `SHA`, so a check naming `SHA` is the server finding nothing changed.
 * Timesheet lines are seeded as the database owner with triggers off for the transaction, as
 * timesheet-approval.test.ts does.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { NTA_2025_V1, ruleSetPolicyJson, ruleSetRulesJson } from "@/lib/payroll/rule-set";
import type { Database } from "@/types/db";

import {
  addPayrollWorker,
  OCT_END,
  resultsFor,
  saveResults,
  seedPayrollRun,
  SHA,
  type SeededRun,
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
const OTHER_SHA = "b".repeat(64);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let finance: TestUser;
let lineManager: TestUser;
let workerUser: TestUser;
let posted: SeededRun;

async function addMember(user: TestUser, role: Role, orgId: string, workerId?: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId ?? null });
  expect(error).toBeNull();
}

const check = (orgId: string, runId: string, actor: string, sha = SHA) =>
  admin.rpc("record_payroll_approval_check", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: actor,
    p_inputs_sha256: sha,
  });

const approve = (client: Client, orgId: string, runId: string) =>
  client.rpc("approve_payroll_run", { p_organisation_id: orgId, p_run_id: runId });

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

/** An approved (or other status) timesheet day for the worker, with a shift. */
async function addLine(orgId: string, workerId: string, workDate: string, status = "approved") {
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
            480, 0, $5, '{}'
     from public.timesheets t
     where t.organisation_id = $2 and t.worker_id = $3
       and t.period_start = private.timesheet_period_start($4::date, 20)`,
    [id, orgId, workerId, workDate, status],
  );
  return id;
}

/** Submitted by its owner (the seed), then approved by `approver` after a matching check. */
async function approveSeeded(o: TenantUser, run: SeededRun, approver: TestUser) {
  expect((await check(o.orgId, run.runId, approver.id)).error).toBeNull();
  const { data, error } = await approve(approver.client, o.orgId, run.runId);
  expect(error).toBeNull();
  return data!;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("pappr-owner", "Payroll Approval Org");
  hr = await createTestUser("pappr-hr");
  finance = await createTestUser("pappr-finance");
  lineManager = await createTestUser("pappr-lm");
  workerUser = await createTestUser("pappr-worker");
  await addMember(hr, "hr", owner.orgId);
  await addMember(finance, "finance", owner.orgId);
  await addMember(lineManager, "line_manager", owner.orgId);
  // The owner prepares, adjusts, acknowledges and submits October.
  posted = await seedPayrollRun(admin, owner, { submit: true });
  await addMember(workerUser, "worker", owner.orgId, posted.workerId);
});

afterAll(async () => {
  await db?.end();
});

describe("two people approve (rule 10)", () => {
  it("refuses the owner who prepared it, and hr whatever they did", async () => {
    // The owner is an approver by role, but prepared and submitted the run.
    expect((await check(owner.orgId, posted.runId, owner.id)).error).toBeNull();
    const own = await approve(owner.client, owner.orgId, posted.runId);
    expect(own.error?.code).toBe("MLPRE");
    expect(own.error?.message).toContain("a different person must approve");

    // hr never approves, and the server can't record a check naming them.
    expect((await check(owner.orgId, posted.runId, hr.id)).error?.code).toBe(DENIED);
    expect((await approve(hr.client, owner.orgId, posted.runId)).error?.code).toBe(DENIED);
    expect((await approve(lineManager.client, owner.orgId, posted.runId)).error?.code).toBe(DENIED);
    const { data: run } = await admin
      .from("payroll_runs")
      .select("status, approved_by")
      .eq("id", posted.runId)
      .single();
    expect(run).toEqual({ status: "review", approved_by: null });
  });

  it("refuses an owner who acknowledged an anomaly, and anyone who recalculated", async () => {
    const o = await createTenantUser("pappr-ack", "Payroll Ack Org");
    const prepHr = await createTestUser("pappr-ack-hr");
    const owner2 = await createTestUser("pappr-ack-owner2");
    const fin = await createTestUser("pappr-ack-fin");
    await addMember(prepHr, "hr", o.orgId);
    // A second owner (the secret key can't add owners; the database owner can).
    await db.query(
      "insert into public.memberships (organisation_id, user_id, role) values ($1, $2, 'owner')",
      [o.orgId, owner2.id],
    );
    await addMember(fin, "finance", o.orgId);
    // The tenant owner creates and saves; owner2 acknowledges; hr submits.
    const run = await seedPayrollRun(admin, o);
    const { data: anomalies } = await admin
      .from("payroll_anomalies")
      .select("id")
      .eq("run_id", run.runId);
    expect(
      (
        await owner2.client.rpc("acknowledge_payroll_anomalies", {
          p_organisation_id: o.orgId,
          p_run_id: run.runId,
          p_anomaly_ids: (anomalies ?? []).map((a) => a.id),
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await prepHr.client.rpc("submit_payroll_run", {
          p_organisation_id: o.orgId,
          p_run_id: run.runId,
        })
      ).error,
    ).toBeNull();

    expect((await check(o.orgId, run.runId, owner2.id)).error).toBeNull();
    expect((await approve(owner2.client, o.orgId, run.runId)).error?.code).toBe("MLPRE");
    // The tenant owner prepared and recalculated it.
    expect((await check(o.orgId, run.runId, o.id)).error).toBeNull();
    expect((await approve(o.client, o.orgId, run.runId)).error?.code).toBe("MLPRE");

    // Finance touched nothing: approved.
    await approveSeeded(o, run, fin);
    const { data: done } = await admin
      .from("payroll_runs")
      .select("status, approved_by, approved_at")
      .eq("id", run.runId)
      .single();
    expect(done).toMatchObject({ status: "approved", approved_by: fin.id });
    expect(done!.approved_at).not.toBeNull();
  });

  it("holds the rule in the table too: approved_by is never the preparer", async () => {
    // A constraint, whatever path writes the row (the guard refuses a direct write first).
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'payroll_runs_two_people'`,
    );
    expect(rows[0]!.def).toContain("approved_by <> prepared_by");
  });
});

describe("approval re-checks the inputs (decision 7)", () => {
  it("is refused without the approver's own check, and when the check found a change", async () => {
    const o = await createTenantUser("pappr-sha", "Payroll Hash Org");
    const fin = await createTestUser("pappr-sha-fin");
    const fin2 = await createTestUser("pappr-sha-fin2");
    await addMember(fin, "finance", o.orgId);
    await addMember(fin2, "finance", o.orgId);
    const run = await seedPayrollRun(admin, o, { submit: true });

    // No check at all.
    expect((await approve(fin.client, o.orgId, run.runId)).error?.code).toBe("MLPRF");
    // Someone else's check doesn't count.
    expect((await check(o.orgId, run.runId, fin2.id)).error).toBeNull();
    expect((await approve(fin.client, o.orgId, run.runId)).error?.code).toBe("MLPRF");
    // The server found different inputs (a day approved, a rate added since).
    const changed = await check(o.orgId, run.runId, fin.id, OTHER_SHA);
    expect(changed.error).toBeNull();
    expect(changed.data).toMatchObject({ matches: false });
    const refused = await approve(fin.client, o.orgId, run.runId);
    expect(refused.error?.code).toBe("MLPRF");
    expect(refused.error?.message).toContain("Return it to HR to recalculate");
    // The latest check counts: a fresh matching one approves.
    await approveSeeded(o, run, fin);
  });

  it("lets only the server record a check", async () => {
    for (const client of [owner.client, finance.client, hr.client]) {
      const { error } = await client.rpc("record_payroll_approval_check", {
        p_organisation_id: owner.orgId,
        p_run_id: posted.runId,
        p_actor: finance.id,
        p_inputs_sha256: SHA,
      });
      expect(error?.code).toBe(DENIED);
    }
    // Not for a draft, and not for someone outside the company.
    const o = await createTenantUser("pappr-draft", "Payroll Draft Check Org");
    const draft = await seedPayrollRun(admin, o);
    expect((await check(o.orgId, draft.runId, o.id)).error?.code).toBe("MLPRD");
    expect((await check(o.orgId, draft.runId, finance.id)).error?.code).toBe(DENIED);
    // Checks are kept as written.
    const { data: rows } = await admin
      .from("payroll_approval_checks")
      .select("id")
      .eq("organisation_id", owner.orgId);
    expect(rows!.length).toBeGreaterThan(0);
    await expect(
      db.query("update public.payroll_approval_checks set matches = true where id = $1", [
        rows![0]!.id,
      ]),
    ).rejects.toMatchObject({ code: "MLPRD" });
    await expect(
      db.query("delete from public.payroll_approval_checks where id = $1", [rows![0]!.id]),
    ).rejects.toMatchObject({ code: "MLPRD" });
    const ins = await finance.client.from("payroll_approval_checks").insert({
      organisation_id: owner.orgId,
      run_id: posted.runId,
      actor_id: finance.id,
      inputs_sha256: SHA,
      matches: true,
    });
    expect(ins.error?.code).toBe(DENIED);
  });
});

describe("approval holds what the run pays (money review M1)", () => {
  it("is refused when a paid day is reopened after the check", async () => {
    const o = await createTenantUser("pappr-src", "Payroll Source Org");
    const fin = await createTestUser("pappr-src-fin");
    await addMember(fin, "finance", o.orgId);
    const { workerId, payRateId } = await addPayrollWorker(admin, o.orgId);
    const day = await addLine(o.orgId, workerId, "2026-10-03");
    const created = await o.client.rpc("create_payroll_run", {
      p_organisation_id: o.orgId,
      p_period_start: "2026-09-20",
    });
    expect(created.error).toBeNull();
    const runId = created.data!;
    const saved = await saveResults(
      admin,
      o,
      runId,
      resultsFor(
        { workerId, payRateId, adjustmentId: null },
        {
          anomalies: [],
          extra: [
            {
              code: "off_day",
              label: "Off-day work, 1 day",
              amount: 600_000,
              sources: [{ kind: "timesheet_line", id: day, from: "2026-10-03", to: "2026-10-03" }],
            },
          ],
        },
      ),
    );
    expect(saved.error).toBeNull();
    expect(
      (await o.client.rpc("submit_payroll_run", { p_organisation_id: o.orgId, p_run_id: runId }))
        .error,
    ).toBeNull();
    expect((await check(o.orgId, runId, fin.id)).error).toBeNull();
    // Reopened (as the database owner, standing in for 4.3's reopen) after the check.
    await seedRaw("update public.timesheet_lines set status = 'pending' where id = $1", [day]);
    const refused = await approve(fin.client, o.orgId, runId);
    expect(refused.error?.code).toBe("MLPRF");
    const { data: run } = await admin
      .from("payroll_runs")
      .select("status")
      .eq("id", runId)
      .single();
    expect(run).toEqual({ status: "review" });
  });

  it("is refused when a pay rate in its scope is written after the check", async () => {
    const o = await createTenantUser("pappr-late", "Payroll Late Rate Org");
    const fin = await createTestUser("pappr-late-fin");
    await addMember(fin, "finance", o.orgId);
    const run = await seedPayrollRun(admin, o, { submit: true });
    expect((await check(o.orgId, run.runId, fin.id)).error).toBeNull();
    const added = await o.client.rpc("add_pay_rate", {
      p_organisation_id: o.orgId,
      p_worker_id: run.workerId,
      p_rate: {
        pay_type: "monthly",
        basic_kobo: "6500000",
        housing_kobo: "3600000",
        transport_kobo: "2400000",
        other_allowances_kobo: "0",
        daily_rate_kobo: null,
        hourly_rate_kobo: null,
        effective_from: addDays(lagosToday(), 30),
      },
    });
    expect(added.error).toBeNull();
    expect((await approve(fin.client, o.orgId, run.runId)).error?.code).toBe("MLPRF");
    // A fresh check after the change (the server would find the new hash; here the seed's) passes.
    await approveSeeded(o, run, fin);
  });
});

describe("posting", () => {
  let decisionId: string;

  beforeAll(async () => {
    decisionId = await approveSeeded(owner, posted, finance);
  });

  it("records the approval as a decision and in the audit log", async () => {
    const { data: decision } = await admin
      .from("payroll_run_decisions")
      .select("decision, actor_id, inputs_sha256")
      .eq("id", decisionId)
      .single();
    expect(decision).toEqual({ decision: "approved", actor_id: finance.id, inputs_sha256: SHA });
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, action")
      .eq("organisation_id", owner.orgId)
      .eq("entity_id", posted.runId)
      .eq("action", "payroll.run_approved");
    expect(audit).toEqual([{ actor_id: finance.id, action: "payroll.run_approved" }]);
    // Nothing more to decide: approve again, return, recalculate are refused.
    expect((await check(owner.orgId, posted.runId, finance.id)).error?.code).toBe("MLPRD");
    expect((await approve(finance.client, owner.orgId, posted.runId)).error?.code).toBe("MLPRD");
    const back = await finance.client.rpc("return_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: posted.runId,
      p_reason: "Too late",
    });
    expect(back.error?.code).toBe("MLPRD");
  });

  it("refuses every change to posted rows for the database owner, even with triggers off", async () => {
    const statements: [string, unknown[]][] = [
      ["update public.payroll_runs set net_kobo = net_kobo where id = $1", [posted.runId]],
      [
        "update public.payroll_runs set status = 'draft', approved_at = null, approved_by = null, submitted_at = null, submitted_by = null where id = $1",
        [posted.runId],
      ],
      ["delete from public.payroll_runs where id = $1", [posted.runId]],
      ["update public.payslips set net_kobo = 1 where run_id = $1", [posted.runId]],
      ["delete from public.payslips where run_id = $1", [posted.runId]],
      ["update public.payslip_lines set amount_kobo = 1 where run_id = $1", [posted.runId]],
      ["delete from public.payslip_lines where run_id = $1", [posted.runId]],
      ["update public.payslip_sources set stands = false where run_id = $1", [posted.runId]],
      ["delete from public.payslip_sources where run_id = $1", [posted.runId]],
      ["delete from public.payroll_adjustments where run_id = $1", [posted.runId]],
      [
        "update public.payroll_anomalies set acknowledged_at = now() where run_id = $1",
        [posted.runId],
      ],
      ["delete from public.payroll_anomalies where run_id = $1", [posted.runId]],
      ["update public.payroll_run_decisions set reason = 'x' where run_id = $1", [posted.runId]],
      [
        `insert into public.payslip_lines (organisation_id, payslip_id, run_id, position, code, kind,
           label, amount_kobo, pensionable, taxable)
         select organisation_id, id, run_id, 99, 'basic', 'earning', 'Extra', 1, true, true
         from public.payslips where run_id = $1`,
        [posted.runId],
      ],
    ];
    for (const [sql, params] of statements) {
      await expect(db.query(sql, params), sql).rejects.toMatchObject({ code: "MLPRD" });
      // ENABLE ALWAYS: replica mode doesn't skip the guards.
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await expect(db.query(sql, params), `replica: ${sql}`).rejects.toMatchObject({
          code: "MLPRD",
        });
      } finally {
        await db.query("rollback");
      }
    }
    for (const table of ["payroll_runs", "payslips", "payslip_lines", "payslip_sources"]) {
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await expect(db.query(`truncate public.${table} cascade`)).rejects.toMatchObject({
          code: "MLPRD",
        });
      } finally {
        await db.query("rollback");
      }
    }
    const { data: run } = await admin
      .from("payroll_runs")
      .select("status")
      .eq("id", posted.runId)
      .single();
    expect(run).toEqual({ status: "approved" });
  });

  it("refuses the secret key and signed-in roles too (no write grants)", async () => {
    for (const client of [admin, owner.client, finance.client, hr.client]) {
      const run = await client
        .from("payroll_runs")
        .update({ needs_recalculation: true })
        .eq("id", posted.runId);
      expect(run.error?.code).toBe(DENIED);
      const slip = await client.from("payslips").update({ net_kobo: 1 }).eq("run_id", posted.runId);
      expect(slip.error?.code).toBe(DENIED);
      for (const table of [
        "payroll_runs",
        "payslips",
        "payslip_lines",
        "payslip_sources",
      ] as const) {
        const del = await client.from(table).delete().eq("organisation_id", owner.orgId);
        expect(del.error?.code, table).toBe(DENIED);
      }
    }
  });
});

describe("the period lock", () => {
  it("is true for days in the posted period only", async () => {
    const { rows } = await db.query<{ d: string; posted: boolean }>(
      `select d::text, private.timesheet_period_posted($1, d) as posted
       from unnest(array['2026-09-19', '2026-09-20', '2026-10-05', '2026-10-19', '2026-10-20']::date[]) d`,
      [owner.orgId],
    );
    expect(Object.fromEntries(rows.map((r) => [r.d, r.posted]))).toEqual({
      "2026-09-19": false,
      "2026-09-20": true,
      "2026-10-05": true,
      "2026-10-19": true,
      "2026-10-20": false,
    });
    // Another company's days aren't locked by this run.
    const other = await createTenantUser("pappr-lock-other", "Payroll Lock Other Org");
    const { rows: theirs } = await db.query<{ posted: boolean }>(
      "select private.timesheet_period_posted($1, '2026-10-05') as posted",
      [other.orgId],
    );
    expect(theirs[0]!.posted).toBe(false);
  });

  it("makes 4.3's reopen and dispute refuse with MLTA5, and holds for the database owner", async () => {
    const day = await addLine(owner.orgId, posted.workerId, "2026-10-06");
    const reopen = await owner.client.rpc("reopen_timesheet_line", {
      p_organisation_id: owner.orgId,
      p_line_id: day,
      p_reason: "Late clock-out arrived",
    });
    expect(reopen.error?.code).toBe("MLTA5");
    const dispute = await workerUser.client.rpc("dispute_timesheet_line", {
      p_line_id: day,
      p_reason: "I clocked out at 19:30",
    });
    expect(dispute.error?.code).toBe("MLTA5");
    await expect(
      db.query("update public.timesheet_lines set status = 'pending' where id = $1", [day]),
    ).rejects.toMatchObject({ code: "MLTA5" });
    // ENABLE ALWAYS: replica mode doesn't skip the freeze either.
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await expect(
        db.query("update public.timesheet_lines set status = 'pending' where id = $1", [day]),
      ).rejects.toMatchObject({ code: "MLTA5" });
      await expect(
        db.query("delete from public.timesheet_lines where id = $1", [day]),
      ).rejects.toMatchObject({ code: "MLTA5" });
    } finally {
      await db.query("rollback");
    }
    const { data: line } = await admin
      .from("timesheet_lines")
      .select("status")
      .eq("id", day)
      .single();
    expect(line).toEqual({ status: "approved" });
  });
});

describe("leave in a posted period (money review H1)", () => {
  const LOCKED =
    "Part of this leave is in a posted pay period. Ask payroll to correct it in the next run.";
  let typeId: string;

  async function leave(start: string, end: string, status: string) {
    const id = randomUUID();
    await seedRaw(
      `insert into public.leave_requests (id, organisation_id, worker_id, leave_type_id, leave_year,
         start_date, end_date, days, status, decided_at)
       values ($1, $2, $3, $4, 2026, $5, $6, 2, $7,
               case when $7 = 'approved' then now() end)`,
      [id, owner.orgId, posted.workerId, typeId, start, end, status],
    );
    return id;
  }

  beforeAll(async () => {
    typeId = randomUUID();
    await seedRaw(
      `insert into public.leave_types (id, organisation_id, code, name, counting, paid)
       values ($1, $2, 'unpaid_test', 'Unpaid', 'working_days', false)`,
      [typeId, owner.orgId],
    );
  });

  it("refuses cancelling approved leave after posting", async () => {
    const id = await leave("2026-10-12", "2026-10-13", "approved");
    const { error } = await hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: id,
      p_reason: "Came to work after all",
    });
    expect(error?.code).toBe("MLTA5");
    expect(error?.message).toBe(LOCKED);
    const { data } = await admin.from("leave_requests").select("status").eq("id", id).single();
    expect(data).toEqual({ status: "approved" });
  });

  it("refuses approving (or declining) leave in a posted period, even partly", async () => {
    const id = await leave("2026-10-16", "2026-10-21", "pending_hr");
    for (const decision of ["approved", "declined"]) {
      const { error } = await hr.client.rpc("decide_leave_hr", {
        p_organisation_id: owner.orgId,
        p_request_id: id,
        p_decision: decision,
        p_note: "Checked",
      });
      expect(error?.code, decision).toBe("MLTA5");
    }
    const { data } = await admin.from("leave_requests").select("status").eq("id", id).single();
    expect(data).toEqual({ status: "pending_hr" });
  });
});

describe("backdated pay rates (Phase 1 decision 17)", () => {
  const monthly = (from: string, basic = "6500000") => ({
    pay_type: "monthly",
    basic_kobo: basic,
    housing_kobo: "3600000",
    transport_kobo: "2400000",
    other_allowances_kobo: "0",
    daily_rate_kobo: null,
    hourly_rate_kobo: null,
    effective_from: from,
  });

  it("gives the earliest start: the day after the posted period", async () => {
    const { data, error } = await hr.client.rpc("pay_rate_earliest_start", {
      p_organisation_id: owner.orgId,
    });
    expect(error).toBeNull();
    expect(data).toBe(addDays(OCT_END, 1));
    const lm = await lineManager.client.rpc("pay_rate_earliest_start", {
      p_organisation_id: owner.orgId,
    });
    expect(lm.error?.code).toBe(DENIED);
    // A company with nothing posted keeps "today or later".
    const o = await createTenantUser("pappr-floor", "Payroll Floor Org");
    const fresh = await o.client.rpc("pay_rate_earliest_start", { p_organisation_id: o.orgId });
    expect(fresh.data).toBe(lagosToday());
  });

  it("refuses a start inside the posted period and allows one in the earliest unposted period", async () => {
    const into = await hr.client.rpc("add_pay_rate", {
      p_organisation_id: owner.orgId,
      p_worker_id: posted.workerId,
      p_rate: monthly("2026-10-15"),
    });
    expect(into.error?.code).toBe("MLPR2");
    expect(into.error?.message).toContain("20 Oct 2026");

    const after = await hr.client.rpc("add_pay_rate", {
      p_organisation_id: owner.orgId,
      p_worker_id: posted.workerId,
      p_rate: monthly(addDays(OCT_END, 1)),
    });
    expect(after.error).toBeNull();
    const { data: rates } = await admin
      .from("pay_rates")
      .select("id, effective_from, effective_to")
      .eq("worker_id", posted.workerId)
      .order("effective_from");
    expect(rates!.map((r) => [r.effective_from, r.effective_to])).toEqual([
      ["2025-01-06", OCT_END],
      [addDays(OCT_END, 1), null],
    ]);
  });

  it("never changes or cancels a version a posted payslip used", async () => {
    const usedId = posted.payRateId;
    await expect(
      db.query("update public.pay_rates set basic_kobo = 1 where id = $1", [usedId]),
    ).rejects.toMatchObject({ code: "MLPRG" });
    await expect(
      db.query("delete from public.pay_rates where id = $1", [usedId]),
    ).rejects.toMatchObject({ code: "MLPRG" });
    // Its end can't move back into the posted period.
    await expect(
      db.query("update public.pay_rates set effective_to = '2026-10-10' where id = $1", [usedId]),
    ).rejects.toMatchObject({ code: "MLPRG" });
  });

  it("lets a backdated typo be corrected or cancelled, even in force (money review M2)", async () => {
    const { data: later } = await admin
      .from("pay_rates")
      .select("id")
      .eq("worker_id", posted.workerId)
      .gt("effective_from", OCT_END)
      .single();
    // In force since 20 Oct, after the posted period, used by no posted payslip: amendable.
    const fixed = await hr.client
      .from("pay_rates")
      .update({ basic_kobo: 6_400_000 })
      .eq("id", later!.id);
    expect(fixed.error).toBeNull();
    const cancelled = await hr.client.rpc("cancel_pay_rate", {
      p_organisation_id: owner.orgId,
      p_pay_rate_id: later!.id,
    });
    expect(cancelled.error).toBeNull();
    // The posted version reopens to cover the days after the posted period again.
    const { data: rates } = await admin
      .from("pay_rates")
      .select("id, effective_from, effective_to")
      .eq("worker_id", posted.workerId)
      .order("effective_from");
    expect(rates!.map((r) => [r.id, r.effective_to])).toEqual([[posted.payRateId, null]]);
    // Added again from the earliest unposted day.
    const again = await hr.client.rpc("add_pay_rate", {
      p_organisation_id: owner.orgId,
      p_worker_id: posted.workerId,
      p_rate: monthly(addDays(OCT_END, 1)),
    });
    expect(again.error).toBeNull();
  });

  it("keeps a version that ended before today frozen (security review L2)", async () => {
    const o = await createTenantUser("pappr-ended", "Payroll Ended Rate Org");
    const run = await seedPayrollRun(admin, o, { submit: true });
    const fin = await createTestUser("pappr-ended-fin");
    await addMember(fin, "finance", o.orgId);
    await approveSeeded(o, run, fin);
    // A version from 20 Nov closes the posted one on 19 Nov, a day already past. Cancelling the
    // new one would reopen the ended one: refused, ended versions stay as they are.
    const added = await o.client.rpc("add_pay_rate", {
      p_organisation_id: o.orgId,
      p_worker_id: run.workerId,
      p_rate: monthly("2026-11-20", "6600000"),
    });
    expect(added.error).toBeNull();
    const { data: rows } = await admin
      .from("pay_rates")
      .select("id, effective_from, effective_to")
      .eq("worker_id", run.workerId)
      .order("effective_from");
    expect(rows!.map((r) => r.effective_to)).toEqual(["2026-11-19", null]);
    await expect(
      db.query("delete from public.pay_rates where id = $1", [rows![1]!.id]),
    ).rejects.toThrow(/has ended/);
    expect(
      (await admin.from("pay_rates").select("id").eq("worker_id", run.workerId)).data,
    ).toHaveLength(2);
  });
});

describe("rule sets used by a posted run", () => {
  it("names the posted run's version, which may still close for a version from tomorrow", async () => {
    const { data: run } = await admin
      .from("payroll_runs")
      .select("rule_set_id")
      .eq("id", posted.runId)
      .single();
    const { rows } = await db.query<{ posted: boolean }>(
      "select private.tax_rule_set_in_posted_run($1) as posted",
      [run!.rule_set_id],
    );
    expect(rows[0]!.posted).toBe(true);
    const { error } = await hr.client.rpc("add_tax_rule_set_version", {
      p_organisation_id: owner.orgId,
      p_name: "NTA 2025 v2",
      p_rules: { ...ruleSetRulesJson(NTA_2025_V1.rules), nsitf: { rate_bps: 150 } },
      p_policy: ruleSetPolicyJson(NTA_2025_V1.policy),
      p_effective_from: addDays(lagosToday(), 1),
      p_reason: "Adviser's advice",
    });
    expect(error).toBeNull();
    // The posted version is kept.
    await expect(
      db.query("delete from public.tax_rule_sets where id = $1", [run!.rule_set_id]),
    ).rejects.toMatchObject({ code: "MLPR8" });
  });
});
