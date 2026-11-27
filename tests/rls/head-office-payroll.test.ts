/**
 * Slice 6.11, money review: Head office staff are paid their salary once, through the real run
 * path (createRunSpec calculates with the engine and saves through save_payroll_results; the
 * runs are approved, so October is posted when November reads its arrears).
 *
 * - H1: a no-shift weekday approved in its own cycle is covered by salary and recorded as a
 *   source of the salary line, so it never comes back as arrears.
 * - H1-a (round 2): a no-shift weekday approved after its cycle posted is a working day of that
 *   posted cycle's calendar, so the next run pays ₦0 arrears for it.
 * - H1-b (round 2): an office worker with a client shift from before the MLHO6 guard (a stray
 *   last-rostered day) keeps office weekdays as working days: no off-day pay, the zero-minute
 *   shift line pays nothing, and no Work Unit is made.
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
const SALARY = 12_000_000n;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let finance: TestUser;
let clientSite: string;
let headOffice: string;
let ada: string;
let bayo: string;
const lines: Record<string, string> = {};

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

async function addWorker(first: string): Promise<string> {
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `HP-${randomUUID().slice(0, 6)}`,
      first_name: first,
      last_name: "Office",
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

async function mapToOffice(workerId: string) {
  const { error } = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: workerId,
    site_id: headOffice,
    effective_from: "2025-01-06",
  });
  expect(error).toBeNull();
}

/** A timesheet line, seeded as the database owner (the read is under test, not the refresh). */
async function addLine(
  workerId: string,
  workDate: string,
  options: { minutes?: number; status?: string; assignment?: string } = {},
): Promise<string> {
  await asOwnerWithTriggersOff(
    `insert into public.timesheets (id, organisation_id, worker_id, period_start, period_end)
     values (gen_random_uuid(), $1, $2, private.timesheet_period_start($3::date, 20),
             private.timesheet_period_end(private.timesheet_period_start($3::date, 20)))
     on conflict (organisation_id, worker_id, period_start) do nothing`,
    [owner.orgId, workerId, workDate],
  );
  const { rows } = await db.query<{ id: string }>(
    `select id from public.timesheets where organisation_id = $1 and worker_id = $2
       and period_start = private.timesheet_period_start($3::date, 20)`,
    [owner.orgId, workerId, workDate],
  );
  const id = randomUUID();
  const shift = options.assignment ?? null;
  await asOwnerWithTriggersOff(
    `insert into public.timesheet_lines (id, organisation_id, timesheet_id, worker_id, work_date,
       shift_assignment_id, shift_id, post_id, no_shift_punch_id, scheduled_minutes,
       worked_minutes, ot_minutes, status, exceptions)
     values ($1, $2, $3, $4, $5::date, $6::uuid,
             case when $6::uuid is null then null else gen_random_uuid() end,
             case when $6::uuid is null then null else gen_random_uuid() end,
             case when $6::uuid is null then gen_random_uuid() else null end,
             case when $6::uuid is null then 0 else 480 end, $7, 0, $8,
             case when $6::uuid is null then array['no_shift'] else '{}'::text[] end)`,
    [
      id,
      owner.orgId,
      rows[0]!.id,
      workerId,
      workDate,
      shift,
      options.minutes ?? 480,
      options.status ?? "approved",
    ],
  );
  return id;
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

async function payslipOf(runId: string, workerId: string) {
  const { data: slip } = await admin
    .from("payslips")
    .select("id, gross_kobo::text")
    .eq("run_id", runId)
    .eq("worker_id", workerId)
    .single();
  const { data: slipLines } = await admin
    .from("payslip_lines")
    .select("position, code, amount_kobo::text")
    .eq("payslip_id", slip!.id)
    .order("position");
  const { data: sources } = await admin
    .from("payslip_sources")
    .select("source_kind, source_id, line_positions, off_day")
    .eq("payslip_id", slip!.id);
  return { gross: BigInt(slip!.gross_kobo), lines: slipLines ?? [], sources: sources ?? [] };
}

beforeAll(async () => {
  const env = loadLocalEnv();
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = env.publishableKey;
  process.env.SUPABASE_SECRET_KEY = env.secretKey;
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("hp-owner", "Head Office Payroll Org");
  hr = await createTestUser("hp-hr", "Halima Bello");
  finance = await createTestUser("hp-finance", "Femi Finance");
  for (const [user, role] of [
    [hr, "hr"],
    [finance, "finance"],
  ] as const) {
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: user.id, role });
    expect(error).toBeNull();
  }
  const client = await admin
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: "Coastline" })
    .select("id")
    .single();
  expect(client.error).toBeNull();
  const site = await admin
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: client.data!.id, name: "Apapa" })
    .select("id")
    .single();
  expect(site.error).toBeNull();
  clientSite = site.data!.id;
  const { rows } = await db.query<{ id: string }>(
    "select id::text from public.sites where organisation_id = $1 and kind = 'office'",
    [owner.orgId],
  );
  headOffice = rows[0]!.id;

  // Ada works at Head office. Thu 1 Oct is approved in its cycle; Mon 12 Oct is still pending
  // when October posts and is approved later.
  ada = await addWorker("Ada");
  await mapToOffice(ada);
  lines.adaInCycle = await addLine(ada, "2026-10-01");
  lines.adaLate = await addLine(ada, "2026-10-12", { status: "pending" });

  // Bayo had a client shift on Wed 14 Oct assigned before the MLHO6 guard (he wasn't mapped to
  // the office yet), never worked: a zero-minute shift line. Then he was put at Head office.
  bayo = await addWorker("Bayo");
  const legacy = randomUUID();
  await asOwnerWithTriggersOff(
    `insert into public.shift_assignments
       (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at)
     values ($1, $2, gen_random_uuid(), $3, date '2026-10-14', $4,
             timestamptz '2026-10-14 07:00+01', timestamptz '2026-10-14 15:00+01')`,
    [legacy, owner.orgId, clientSite, bayo],
  );
  await mapToOffice(bayo);
  for (const d of ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]) {
    await addLine(bayo, d);
  }
  lines.bayoShift = await addLine(bayo, "2026-10-14", { minutes: 0, assignment: legacy });
});

afterAll(async () => {
  await db?.end();
});

describe("Head office staff are paid their salary once", () => {
  let octRun: string;

  it("October: the salary only, with Ada's covered weekday recorded as a source of her salary (H1)", async () => {
    octRun = (await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: OCT_START })).runId;
    const a = await payslipOf(octRun, ada);
    expect(a.gross).toBe(SALARY);
    expect(a.lines.some((l) => l.code === "off_day")).toBe(false);
    const basic = a.lines.find((l) => l.code === "basic")!;
    const covered = a.sources.find((s) => s.source_id === lines.adaInCycle)!;
    expect(covered).toMatchObject({ source_kind: "timesheet_line", off_day: false });
    expect(covered.line_positions).toEqual([basic.position]);
  });

  it("October: Bayo's stray client shift turns no office weekday into off-day work (H1-b)", async () => {
    const b = await payslipOf(octRun, bayo);
    expect(b.gross).toBe(SALARY);
    expect(b.lines.some((l) => l.code === "off_day")).toBe(false);
    expect(b.sources.map((s) => s.source_id)).not.toContain(lines.bayoShift);
    const { rows } = await db.query(
      "select 1 from public.work_units where organisation_id = $1 and worker_id = $2",
      [owner.orgId, bayo],
    );
    expect(rows).toEqual([]);
    await submitAndApprove(octRun);
  });

  it("November: ₦0 arrears for a weekday approved after October posted, and nothing paid twice (H1, H1-a)", async () => {
    await asOwnerWithTriggersOff(
      "update public.timesheet_lines set status = 'approved' where id = $1",
      [lines.adaLate],
    );
    const novRun = (await runMutation(ctxOf(hr, "hr"), createRunSpec, { periodStart: NOV_START }))
      .runId;
    for (const worker of [ada, bayo]) {
      const slip = await payslipOf(novRun, worker);
      expect(slip.lines.filter((l) => l.code === "arrears" || l.code === "off_day")).toEqual([]);
      expect(slip.gross).toBe(SALARY);
    }
    // The late weekday is settled by November's salary, so it never comes back.
    const a = await payslipOf(novRun, ada);
    expect(a.sources.map((s) => s.source_id)).toContain(lines.adaLate);
  });
});
