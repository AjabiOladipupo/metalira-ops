/**
 * Slice 5.3's end-to-end golden test (docs/PHASE_5.md decision 6, 5.3 accept line): the six
 * golden workers with their pay rates and a full October 2026 cycle (20 Sep to 19 Oct, paid
 * 25 Oct) of approved days, prepared by HR through the server engine path (createRunSpec: the
 * pay inputs read as HR, the earnings stage and gross to net, saved by save_payroll_results with
 * the secret key), submitted, and approved by a second person in Finance through approveRunSpec
 * (the inputs re-gathered on the server and their hash recorded, then approve_payroll_run). Every
 * stored payslip and the run's totals equal fixtures/october-2026-golden.json, in kobo.
 *
 * Also end to end:
 * - a day approved after submission changes the inputs, so approval is refused until it's gone;
 * - after posting, reopening a day in 20 Sep to 19 Oct is refused (MLTA5);
 * - a day of the posted period approved after posting is paid in November's run as arrears, once,
 *   with its source recorded (decision 10; 5.1's arrears rule now that the period posts); once
 *   November is approved, December doesn't pay it again.
 *
 * Timesheet days are seeded as the database owner with triggers off for the transaction (as
 * timesheet-approval.test.ts does): the payroll path is under test here, not clock-ins.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import golden from "../../fixtures/october-2026-golden.json";
import { MutationError, runMutation } from "@/server/identity/mutate";
import { approveRunSpec, createRunSpec, INPUTS_CHANGED_MESSAGE } from "@/server/payroll/runs";
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
const kobo = (naira: number) => BigInt(Math.round(naira * 100));

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let finance: TestUser;
const workers: Record<string, string> = {};
let runId: string;
let lateDay: string;
let novRunId: string;

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

/** One no-shift day for a worker (a clock-in with no roster), with its status. */
async function noShiftDay(workerId: string, workDate: string, status: string) {
  const id = randomUUID();
  await asOwnerWithTriggersOff(
    `insert into public.timesheet_lines (id, organisation_id, timesheet_id, worker_id, work_date,
       no_shift_punch_id, scheduled_minutes, worked_minutes, ot_minutes, status, exceptions)
     select $1, $2, t.id, $3, $4, gen_random_uuid(), 0, 480, 0, $5, '{}'
     from public.timesheets t
     where t.organisation_id = $2 and t.worker_id = $3
       and t.period_start = private.timesheet_period_start($4::date, 20)`,
    [id, owner.orgId, workerId, workDate, status],
  );
  return id;
}

const ctxOf = (user: TestUser, role: Role) => ({
  supabase: user.client,
  userId: user.id,
  organisationId: owner.orgId,
  role,
});

beforeAll(async () => {
  // The server modules read these (the admin client and the engine's reads).
  const env = loadLocalEnv();
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.publishableKey;
  process.env.SUPABASE_SECRET_KEY = env.secretKey;

  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("pgold-owner", "Golden Payroll Org");
  hr = await createTestUser("pgold-hr", "Oluwaseun Adeyemi");
  finance = await createTestUser("pgold-finance", "Adaeze Okafor");
  await addMember(hr, "hr");
  await addMember(finance, "finance");

  // The six golden workers: full cycle, 50% basic / 30% housing / 20% transport, Lagos.
  for (const w of golden.workers) {
    const [first, last] = w.name.split(" ");
    const { data, error } = await admin
      .from("workers")
      .insert({
        organisation_id: owner.orgId,
        staff_id: `GD-${randomUUID().slice(0, 6)}`,
        first_name: first!,
        last_name: last!,
        employment_type: "permanent",
        start_date: "2025-01-06",
        tax_state: "Lagos",
        annual_rent_declared_kobo: w.annual_rent * 100,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const gross = w.gross * 100;
    const basic = gross / 2;
    const housing = (gross * 3) / 10;
    const rate = await admin.from("pay_rates").insert({
      organisation_id: owner.orgId,
      worker_id: data.id,
      pay_type: "monthly",
      basic_kobo: basic,
      housing_kobo: housing,
      transport_kobo: gross - basic - housing,
      other_allowances_kobo: 0,
      effective_from: "2025-01-06",
    });
    if (rate.error) throw new Error(rate.error.message);
    workers[w.name] = data.id;
  }

  // A full cycle of approved days: every Monday to Friday, 8 hours, no overtime, on a shift.
  const ids = Object.values(workers);
  await asOwnerWithTriggersOff(
    `insert into public.timesheets (organisation_id, worker_id, period_start, period_end)
     select $1, w, $3::date, $4::date from unnest($2::uuid[]) w`,
    [owner.orgId, ids, OCT_START, OCT_END],
  );
  const { rowCount } = await asOwnerWithTriggersOff(
    `insert into public.timesheet_lines (organisation_id, timesheet_id, worker_id, work_date,
       shift_assignment_id, shift_id, post_id, scheduled_minutes, worked_minutes, ot_minutes,
       status, exceptions)
     select t.organisation_id, t.id, t.worker_id, d::date, gen_random_uuid(), gen_random_uuid(),
            gen_random_uuid(), 480, 480, 0, 'approved', '{}'
     from public.timesheets t
     cross join generate_series($2::date, $3::date, interval '1 day') d
     where t.organisation_id = $1 and extract(isodow from d) < 6`,
    [owner.orgId, OCT_START, OCT_END],
  );
  expect(rowCount).toBe(6 * 21);
  // A Saturday Musa Ibrahim worked, still waiting for his manager when payroll is prepared.
  lateDay = await noShiftDay(workers["Musa Ibrahim"]!, "2026-10-10", "pending");
});

afterAll(async () => {
  await db?.end();
});

describe("October 2026 through run and approval", () => {
  it("HR prepares it with the server engine, acknowledges the warnings and submits", async () => {
    const created = await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: OCT_START });
    expect(created.calculated).toBe(true);
    runId = created.runId;

    const { data: anomalies } = await admin
      .from("payroll_anomalies")
      .select("id, code, severity")
      .eq("run_id", runId);
    expect(anomalies!.filter((a) => a.severity === "blocking")).toEqual([]);
    // The pending Saturday is flagged ("pay next run").
    expect(anomalies!.map((a) => a.code)).toContain("open_timesheet_days");
    const ack = await hr.client.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_anomaly_ids: anomalies!.map((a) => a.id),
    });
    expect(ack.error).toBeNull();
    const sub = await hr.client.rpc("submit_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
    });
    expect(sub.error).toBeNull();
  });

  it("refuses HR approving, and Finance approving after the inputs changed", async () => {
    await expect(runMutation(ctxOf(hr, "hr"), approveRunSpec, { runId })).rejects.toMatchObject({
      code: "forbidden",
    });

    // A day approved after submission: the server's re-gathering finds different inputs.
    const extra = await noShiftDay(workers["Grace Edet"]!, "2026-10-03", "approved");
    const refused = await runMutation(ctxOf(finance, "finance"), approveRunSpec, { runId }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(MutationError);
    expect((refused as MutationError).message).toBe(INPUTS_CHANGED_MESSAGE);
    const { data: checks } = await admin
      .from("payroll_approval_checks")
      .select("actor_id, matches")
      .eq("run_id", runId);
    expect(checks).toEqual([{ actor_id: finance.id, matches: false }]);

    // Gone again (as the database owner): the inputs are the submitted ones once more.
    await asOwnerWithTriggersOff("delete from public.timesheet_lines where id = $1", [extra]);
    const { data: run } = await admin
      .from("payroll_runs")
      .select("status")
      .eq("id", runId)
      .single();
    expect(run).toEqual({ status: "review" });
  });

  it("a second person in Finance approves, and every stored payslip equals the golden fixture", async () => {
    const approved = await runMutation(ctxOf(finance, "finance"), approveRunSpec, { runId });
    expect(approved.runId).toBe(runId);

    const { data: run } = await admin
      .from("payroll_runs")
      .select(
        "status, approved_by, prepared_by, worker_count, itf_applies, gross_kobo::text, paye_kobo::text, pension_employee_kobo::text, pension_employer_kobo::text, net_kobo::text, nsitf_kobo::text, itf_kobo::text, employer_cost_kobo::text",
      )
      .eq("id", runId)
      .single();
    expect(run).toMatchObject({
      status: "approved",
      approved_by: finance.id,
      prepared_by: hr.id,
      worker_count: 6,
      itf_applies: true,
    });
    const t = golden.totals;
    expect(BigInt(run!.gross_kobo)).toBe(kobo(t.gross));
    expect(BigInt(run!.paye_kobo)).toBe(kobo(t.paye));
    expect(BigInt(run!.pension_employee_kobo)).toBe(kobo(t.pension_employee));
    expect(BigInt(run!.net_kobo)).toBe(kobo(t.net));
    expect(BigInt(run!.employer_cost_kobo)).toBe(kobo(t.employer_cost));
    const st = golden.statutory;
    expect(BigInt(run!.pension_employee_kobo) + BigInt(run!.pension_employer_kobo)).toBe(
      kobo(st.pension_total),
    );
    expect(BigInt(run!.nsitf_kobo)).toBe(kobo(st.nsitf));
    expect(BigInt(run!.itf_kobo)).toBe(kobo(st.itf));

    const { data: slips } = await admin
      .from("payslips")
      .select(
        "worker_id, gross_kobo::text, paye_kobo::text, pension_employee_kobo::text, net_kobo::text, employer_cost_kobo::text, nhf_kobo::text, other_deductions_kobo::text",
      )
      .eq("run_id", runId);
    expect(slips).toHaveLength(6);
    for (const w of golden.workers) {
      const s = slips!.find((x) => x.worker_id === workers[w.name]);
      expect(s, w.name).toBeDefined();
      expect(
        {
          gross: BigInt(s!.gross_kobo),
          paye: BigInt(s!.paye_kobo),
          pension: BigInt(s!.pension_employee_kobo),
          net: BigInt(s!.net_kobo),
          cost: BigInt(s!.employer_cost_kobo),
          nhf: BigInt(s!.nhf_kobo),
          other: BigInt(s!.other_deductions_kobo),
        },
        w.name,
      ).toEqual({
        gross: kobo(w.gross),
        paye: kobo(w.paye),
        pension: kobo(w.pension_employee),
        net: kobo(w.net),
        cost: kobo(w.employer_cost),
        nhf: 0n,
        other: 0n,
      });
    }
  });

  it("owes the golden statutory figures as remittances (slice 5.6)", async () => {
    const { data: rems, error } = await admin
      .from("statutory_remittances")
      .select("kind, authority_key, amount_kobo::text, worker_count, due_date")
      .eq("run_id", runId);
    expect(error).toBeNull();
    const owed = (kind: string) =>
      (rems ?? []).filter((r) => r.kind === kind).reduce((n, r) => n + BigInt(r.amount_kobo), 0n);
    const st = golden.statutory;
    expect(owed("pension")).toBe(kobo(st.pension_total));
    expect(owed("nsitf")).toBe(kobo(st.nsitf));
    expect(owed("itf")).toBe(kobo(st.itf));
    expect(owed("paye")).toBe(kobo(golden.totals.paye));
    expect(owed("nhf")).toBe(0n);
    // Everyone is in Lagos, with no PFA on file here; pension is due 7 working days after
    // Sunday 25 Oct 2026 (Tuesday 3 Nov); the levies have no due date until the company sets one.
    expect(rems!.find((r) => r.kind === "paye")).toMatchObject({
      authority_key: "Lagos",
      worker_count: 5,
      due_date: null,
    });
    expect(rems!.find((r) => r.kind === "pension")).toMatchObject({
      authority_key: null,
      worker_count: 6,
      due_date: "2026-11-03",
    });
    expect(rems).toHaveLength(4);
  });

  it("locks 20 Sep to 19 Oct: reopening a day there is refused", async () => {
    const { data: day } = await admin
      .from("timesheet_lines")
      .select("id")
      .eq("worker_id", workers["Musa Ibrahim"]!)
      .eq("work_date", "2026-10-05")
      .single();
    const reopen = await owner.client.rpc("reopen_timesheet_line", {
      p_organisation_id: owner.orgId,
      p_line_id: day!.id,
      p_reason: "Late clock-out arrived",
    });
    expect(reopen.error?.code).toBe("MLTA5");
  });

  it("pays a day approved after posting in November's run as arrears, once", async () => {
    // Musa's Saturday is approved now (as the database owner, with its decision): after posting.
    await asOwnerWithTriggersOff(
      `insert into public.timesheet_decisions (organisation_id, line_id, worker_id, decision,
         actor_id, scheduled_minutes, worked_minutes, late_minutes, early_minutes, ot_minutes,
         exceptions, needs_review)
       select organisation_id, id, worker_id, 'approved', $2, scheduled_minutes, worked_minutes,
              late_minutes, early_minutes, ot_minutes, exceptions, needs_review
       from public.timesheet_lines where id = $1`,
      [lateDay, owner.id],
    );
    await asOwnerWithTriggersOff(
      "update public.timesheet_lines set status = 'approved', decided_at = now() where id = $1",
      [lateDay],
    );

    const nov = await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: NOV_START });
    expect(nov.calculated).toBe(true);
    const { data: musa } = await admin
      .from("payslips")
      .select("id")
      .eq("run_id", nov.runId)
      .eq("worker_id", workers["Musa Ibrahim"]!)
      .single();
    const { data: lines } = await admin
      .from("payslip_lines")
      .select("code, label, amount_kobo::text, position")
      .eq("payslip_id", musa!.id)
      .eq("code", "arrears");
    // A no-shift Saturday is off-day work: 8 hours at ₦120,000 ÷ (20 × 8 h) = ₦750 an hour.
    expect(lines).toHaveLength(1);
    expect(BigInt(lines![0]!.amount_kobo)).toBe(600_000n);
    expect(lines![0]!.label).toContain("Arrears, 20 Sep to 19 Oct, approved after posting");
    const { data: sources } = await admin
      .from("payslip_sources")
      .select("source_kind, from_date, to_date, stands")
      .eq("payslip_id", musa!.id)
      .eq("source_id", lateDay);
    expect(sources).toEqual([
      {
        source_kind: "timesheet_line",
        from_date: "2026-10-10",
        to_date: "2026-10-10",
        stands: true,
      },
    ]);
    // Nobody else gets arrears.
    const { data: others } = await admin
      .from("payslip_lines")
      .select("payslip_id")
      .eq("run_id", nov.runId)
      .eq("code", "arrears");
    expect(others).toHaveLength(1);
    novRunId = nov.runId;
  });

  it("approves November with its arrears, and December never pays the Saturday again", async () => {
    const { data: anomalies } = await admin
      .from("payroll_anomalies")
      .select("id, severity")
      .eq("run_id", novRunId);
    expect(anomalies!.filter((a) => a.severity === "blocking")).toEqual([]);
    if (anomalies!.length > 0) {
      const ack = await hr.client.rpc("acknowledge_payroll_anomalies", {
        p_organisation_id: owner.orgId,
        p_run_id: novRunId,
        p_anomaly_ids: anomalies!.map((a) => a.id),
      });
      expect(ack.error).toBeNull();
    }
    const sub = await hr.client.rpc("submit_payroll_run", {
      p_organisation_id: owner.orgId,
      p_run_id: novRunId,
    });
    expect(sub.error).toBeNull();
    await runMutation(ctxOf(finance, "finance"), approveRunSpec, { runId: novRunId });

    const dec = await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: DEC_START });
    expect(dec.calculated).toBe(true);
    const { data: arrears } = await admin
      .from("payslip_lines")
      .select("payslip_id")
      .eq("run_id", dec.runId)
      .eq("code", "arrears");
    expect(arrears).toEqual([]);
    const { data: paid } = await admin
      .from("payslip_sources")
      .select("run_id")
      .eq("source_id", lateDay)
      .eq("stands", true);
    expect(paid).toEqual([{ run_id: novRunId }]);
  });
});
