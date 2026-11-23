/**
 * Slice 5.1: pay inputs (docs/PHASE_5.md 5.1) against the real database.
 * - payroll_period: the cycle holding a day (20th to 19th, paid on the 25th).
 * - payroll_inputs: owner, hr, finance and the secret key only; admin, ops_manager, a line
 *   manager, an untrusted session and another company get 42501; another company's worker id
 *   gives nothing; anon can't call it and nobody reaches the private definer from outside.
 * - Its jsonb parses with the earnings stage's Zod schema, carries no personal numbers, and runs
 *   through the earnings stage end to end (a joiner on 1 Oct: 13 of 21 rostered days).
 * - Owner decision, 23 Nov 2026: pay_rates reads for owner, hr and finance only (people.test.ts
 *   covers writes).
 *
 * Timesheet lines, shifts and leave are seeded as the database owner with triggers off for the
 * transaction (session_replication_role = replica), as timesheet-approval.test.ts does: the read
 * is under test here, not how those rows are made.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sumKobo } from "@/lib/money";
import { computeEarnings, POLICY_DEFAULTS } from "@/lib/payroll/earnings";
import { parsePayrollInputs } from "@/lib/payroll/inputs";
import type { Database } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const PERMISSION_DENIED = "42501";
const OCT_START = "2026-09-20";
const TIN = "TIN-55501234";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"hr" | "finance" | "admin" | "ops" | "lineManager", TestUser>;
let joiner: string;
let steady: string;
let otherWorker: string;
let counter = 0;

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function addWorker(orgId: string, startDate: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `PI-${String(counter).padStart(4, "0")}-${randomUUID().slice(0, 4)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: startDate,
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const rate = await admin.from("pay_rates").insert({
    organisation_id: orgId,
    worker_id: data!.id,
    pay_type: "monthly",
    basic_kobo: 6_000_000,
    housing_kobo: 3_600_000,
    transport_kobo: 2_400_000,
    other_allowances_kobo: 0,
    effective_from: startDate,
  });
  expect(rate.error).toBeNull();
  return data!.id;
}

/** Seeds rows as the database owner with triggers (and so foreign keys) off. */
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

async function addLine(
  workerId: string,
  workDate: string,
  minutes: { worked: number; ot: number; status?: string; exceptions?: string[] },
) {
  const timesheetId = randomUUID();
  await seedRaw(
    `insert into public.timesheets (id, organisation_id, worker_id, period_start, period_end)
     values ($1, $2, $3, private.timesheet_period_start($4::date, 20),
             private.timesheet_period_end(private.timesheet_period_start($4::date, 20)))
     on conflict (organisation_id, worker_id, period_start) do nothing`,
    [timesheetId, owner.orgId, workerId, workDate],
  );
  const { rows } = await db.query<{ id: string }>(
    `select id from public.timesheets where organisation_id = $1 and worker_id = $2
       and period_start = private.timesheet_period_start($3::date, 20)`,
    [owner.orgId, workerId, workDate],
  );
  await seedRaw(
    `insert into public.timesheet_lines (organisation_id, timesheet_id, worker_id, work_date,
       shift_assignment_id, shift_id, post_id, scheduled_minutes, worked_minutes, ot_minutes,
       status, exceptions)
     values ($1, $2, $3, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 480, $5, $6,
             $7, $8)`,
    [
      owner.orgId,
      rows[0]!.id,
      workerId,
      workDate,
      minutes.worked,
      minutes.ot,
      minutes.status ?? "approved",
      minutes.exceptions ?? [],
    ],
  );
}

const inputs = (client: Client, orgId = owner.orgId, workerIds?: string[]) =>
  client.rpc("payroll_inputs", {
    p_organisation_id: orgId,
    p_period_start: OCT_START,
    ...(workerIds ? { p_worker_ids: workerIds } : {}),
  });

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("pi-owner", "Pay Inputs Org");
  other = await createTenantUser("pi-other", "Other Pay Inputs Org");
  staff.hr = await createTestUser("pi-hr");
  staff.finance = await createTestUser("pi-finance");
  staff.admin = await createTestUser("pi-admin");
  staff.ops = await createTestUser("pi-ops");
  staff.lineManager = await createTestUser("pi-lm");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.admin, "admin");
  await addMember(staff.ops, "ops_manager");
  await addMember(staff.lineManager, "line_manager");

  joiner = await addWorker(owner.orgId, "2026-10-01", {
    tin: TIN,
    tax_state: "Lagos",
    pfa_name: "Stanbic IBTC Pension",
    annual_rent_declared_kobo: 36_000_000,
  });
  steady = await addWorker(owner.orgId, "2025-01-06");
  otherWorker = await addWorker(other.orgId, "2025-01-06");
  // Left before the cycle: not in it.
  await addWorker(owner.orgId, "2025-01-06", { end_date: "2026-09-01", status: "ended" });

  const holiday = await admin
    .from("public_holidays")
    .insert({ organisation_id: owner.orgId, holiday_date: "2026-10-01", name: "Independence Day" });
  expect(holiday.error).toBeNull();

  // The steady worker: overtime on 1 Oct, a context day before the cycle, a pending day, a
  // no-show, and approved unpaid leave across the 19th and 20th.
  await addLine(steady, "2026-10-01", { worked: 480, ot: 20 });
  await addLine(steady, "2026-09-18", { worked: 480, ot: 0 });
  await addLine(steady, "2026-10-02", { worked: 480, ot: 0, status: "pending" });
  await addLine(steady, "2026-10-07", { worked: 0, ot: 0, status: "rejected", exceptions: ["no_show"] });
  await addLine(steady, "2026-10-20", { worked: 480, ot: 0 }); // next cycle

  const typeId = randomUUID();
  const requestId = randomUUID();
  await seedRaw(
    `insert into public.leave_types (id, organisation_id, code, name, counting, paid)
     values ($1, $2, 'unpaid', 'Unpaid', 'working_days', false)`,
    [typeId, owner.orgId],
  );
  await seedRaw(
    `insert into public.leave_requests (id, organisation_id, worker_id, leave_type_id, leave_year,
       start_date, end_date, days, status, decided_at)
     values ($1, $2, $3, $4, 2026, '2026-10-15', '2026-10-23', 7, 'approved', now())`,
    [requestId, owner.orgId, steady, typeId],
  );
  await seedRaw(
    `insert into public.leave_request_pay (request_id, organisation_id, pay_percent, pay_below_service)
     values ($1, $2, 0, false)`,
    [requestId, owner.orgId],
  );
});

afterAll(async () => {
  await db?.end();
});

describe("payroll_period", () => {
  it("gives the cycle holding a day: 20 Sep to 19 Oct, paid on 25 Oct", async () => {
    for (const day of ["2026-09-20", "2026-10-05", "2026-10-19"]) {
      const { data, error } = await staff.hr.client.rpc("payroll_period", {
        p_organisation_id: owner.orgId,
        p_date: day,
      });
      expect(error).toBeNull();
      expect(data).toEqual([
        { period_start: "2026-09-20", period_end: "2026-10-19", pay_date: "2026-10-25" },
      ]);
    }
    const refused = await staff.ops.client.rpc("payroll_period", {
      p_organisation_id: owner.orgId,
      p_date: "2026-10-05",
    });
    expect(refused.error?.code).toBe(PERMISSION_DENIED);
  });
});

describe("who reads pay inputs", () => {
  it("lets owner, hr, finance and the secret key read", async () => {
    for (const client of [owner.client, staff.hr.client, staff.finance.client, admin]) {
      const { data, error } = await inputs(client);
      expect(error).toBeNull();
      const ids = parsePayrollInputs(data).workers.map((w) => w.workerId);
      expect(ids.sort()).toEqual([joiner, steady].sort());
    }
  });

  it("refuses admin, ops managers and line managers (42501)", async () => {
    for (const client of [staff.admin.client, staff.ops.client, staff.lineManager.client]) {
      const { data, error } = await inputs(client);
      expect(error?.code).toBe(PERMISSION_DENIED);
      expect(data).toBeNull();
    }
  });

  it("refuses another company, and gives nothing for another company's worker id", async () => {
    expect((await inputs(other.client)).error?.code).toBe(PERMISSION_DENIED);
    const { data, error } = await inputs(owner.client, owner.orgId, [otherWorker]);
    expect(error).toBeNull();
    expect(parsePayrollInputs(data).workers).toEqual([]);
    const theirs = await inputs(other.client, other.orgId, [joiner, otherWorker]);
    expect(parsePayrollInputs(theirs.data).workers.map((w) => w.workerId)).toEqual([otherWorker]);
  });

  it("refuses an untrusted password session", async () => {
    const email = `rls-pi-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    await addMember({ id: created.data.user!.id, email, client }, "hr");
    expect((await inputs(client)).error?.code).toBe(PERMISSION_DENIED);
  });

  it("can't be called by anon, and the definer isn't reachable from outside", async () => {
    expect((await inputs(anonClient())).error).not.toBeNull();
    const { rows } = await db.query(
      `select has_function_privilege('anon', 'public.payroll_inputs(uuid, date, uuid[])', 'execute') as anon_public,
              has_function_privilege('anon', 'private.payroll_inputs(uuid, date, uuid[])', 'execute') as anon_private`,
    );
    expect(rows[0]).toMatchObject({ anon_public: false, anon_private: false });
  });

  it("refuses a period that doesn't start on the company's start day", async () => {
    const { error } = await owner.client.rpc("payroll_inputs", {
      p_organisation_id: owner.orgId,
      p_period_start: "2026-09-21",
    });
    expect(error?.code).toBe("22023");
  });
});

describe("what the inputs carry", () => {
  it("parses, carries no personal numbers, and prices a joiner on 1 Oct at 13 of 21 days", async () => {
    const { data, error } = await inputs(staff.finance.client);
    expect(error).toBeNull();
    const text = JSON.stringify(data);
    expect(text).not.toContain(TIN);
    expect(text).not.toMatch(/first_name|last_name|staff_id|bank|account|"nin|bvn|"rsa_pin/i);

    const parsed = parsePayrollInputs(data);
    expect(parsed.period).toEqual({ start: "2026-09-20", end: "2026-10-19", payDate: "2026-10-25" });
    expect(parsed.holidays).toContain("2026-10-01");
    const j = parsed.workers.find((w) => w.workerId === joiner)!;
    expect(j.statutory).toMatchObject({
      taxState: "Lagos",
      hasTin: true,
      hasRsaPin: false,
      annualRentKobo: 36_000_000n,
    });
    expect(j.payRates[0]!.basic).toBe(6_000_000n);

    const policy = {
      standardShiftMinutes: parsed.organisation.standardShiftMinutes,
      hourlyRateDivisorDays: parsed.organisation.hourlyRateDivisorDays,
      workDaysPerWeek: parsed.organisation.workDaysPerWeek,
      ...POLICY_DEFAULTS,
    };
    const result = computeEarnings(
      {
        period: parsed.period,
        holidays: parsed.holidays,
        defaultWorkDays: parsed.organisation.defaultWorkDays,
        worker: j,
      },
      policy,
    );
    expect(result.days).toMatchObject({ rostered: 21, employedRostered: 13 });
    expect(sumKobo(result.lines.map((l) => l.amountKobo))).toBe(7_428_571n);
  });

  it("returns approved lines with context days, flags no-shows and open days, and approved leave", async () => {
    const { data } = await inputs(staff.hr.client, owner.orgId, [steady]);
    const [w] = parsePayrollInputs(data).workers;
    expect(w!.lines.map((l) => l.workDate)).toEqual(["2026-09-18", "2026-10-01"]);
    expect(w!.lines[1]).toMatchObject({ workedMinutes: 480, otMinutes: 20, hasShift: true });
    expect(w!.noShowDates).toEqual(["2026-10-07"]);
    expect(w!.openLineCount).toBe(1);
    expect(w!.arrears).toEqual([]); // nothing is posted until 5.3
    expect(w!.leave).toEqual([
      expect.objectContaining({
        typeCode: "unpaid",
        startDate: "2026-10-15",
        endDate: "2026-10-23",
        payPercent: 0,
        payBelowService: false,
      }),
    ]);
  });
});

describe("pay rates: owner, hr and finance only (owner decision, 23 Nov 2026)", () => {
  it("shows pay rates to owner, hr and finance, and to nobody else", async () => {
    for (const client of [owner.client, staff.hr.client, staff.finance.client]) {
      const { data } = await client.from("pay_rates").select("id").eq("worker_id", joiner);
      expect(data).toHaveLength(1);
    }
    for (const client of [staff.admin.client, staff.ops.client, staff.lineManager.client, other.client]) {
      const { data } = await client.from("pay_rates").select("id").eq("worker_id", joiner);
      expect(data).toEqual([]);
    }
  });
});
