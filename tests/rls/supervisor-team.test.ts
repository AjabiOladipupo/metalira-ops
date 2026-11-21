/**
 * Slice 4.7b: My team for worker-supervisors (/m/team), against the real database.
 * - Timesheet days: a worker-supervisor (a worker login whose worker record is the crew's line
 *   manager) approves and rejects only their crew's days; never their own, never a worker outside
 *   the crew, never another company's; refused once they have left or while Shifts is off.
 *   crew_timesheet_days lists only the crew's undecided days.
 * - Leave step 1: the supervisor decides step 1 for their crew only (an ops manager no longer
 *   does, as for any worker with a line manager); never their own leave; an ended supervisor
 *   stops counting, and step 1 falls back to ops. crew_leave_requests shows the balance.
 * - Queries are out of scope: the supervisor reads no staff_queries or replies and can't raise
 *   one (4.6 is unchanged).
 * - Other roles, other companies and signed-out callers get nothing.
 *
 * Contracts, posts, shifts and assignments are seeded as the database owner with triggers off
 * for the transaction only, so their times can sit in the past.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
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

const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
let dayBack = 2;
const at = (day: string, time: string) => Date.parse(`${day}T${time}:00+01:00`);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"hr" | "ops", TestUser>;
let site: string;
let annual: string;
let counter = 0;

interface Worker {
  id: string;
  client: Client;
}

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function addWorkerRecord(
  extra: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
  orgId = owner.orgId,
): Promise<string> {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `ST-${String(counter).padStart(4, "0")}-${randomUUID().slice(0, 4)}`,
      first_name: "Kola",
      last_name: `Adebayo ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** A worker record with an accepted invite and a signed-in worker session. */
async function addWorker(
  extra: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
  orgId = owner.orgId,
): Promise<Worker> {
  const id = await addWorkerRecord(extra, orgId);
  const inviter = orgId === owner.orgId ? staff.hr.client : other.client;
  const invite = await inviter.rpc("create_worker_invites", {
    p_organisation_id: orgId,
    p_worker_ids: [id],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  const email = `w-${id}@workers.metalira.invalid`;
  const login = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { login: "worker" },
  });
  expect(login.error).toBeNull();
  const accepted = await admin.rpc("accept_worker_invite", {
    p_token: invite.data![0]!.token,
    p_auth_user_id: login.data.user!.id,
    p_pin_hash: PIN_HASH,
  });
  expect(accepted.error).toBeNull();
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  expect(link.error).toBeNull();
  const client = anonClient();
  const verified = await client.auth.verifyOtp({
    type: "email",
    token_hash: link.data.properties!.hashed_token,
  });
  expect(verified.error).toBeNull();
  return { id, client };
}

/**
 * A finished 07:00 to 19:00 shift, clocked in and out on time, each on its own day inside the
 * last 35 days (a worker has one shift at a time); returns its line id, or with `refresh` false
 * its assignment id (no line built yet).
 */
async function workedDay(
  workerId: string,
  orgId = owner.orgId,
  siteId = site,
  refresh = true,
): Promise<string> {
  dayBack += 1;
  const DAY = addDays(lagosToday(), -dayBack);
  const [contract, post, shift, assignment] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const startsAt = new Date(at(DAY, "07:00"));
  const endsAt = new Date(at(DAY, "19:00"));
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.contracts (id, organisation_id, client_id, reference, name, type, start_date, vat_applies, status)
       values ($1, $2, $3, $4, 'Guarding', 'manned_post', '2025-01-01', false, 'active')`,
      [contract, orgId, randomUUID(), `ST-${contract.slice(0, 8)}`],
    );
    await db.query(
      `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
       values ($1, $2, $3, $4, $5, 'Guard', 'Day', 'shift', $6)`,
      [post, orgId, contract, siteId, `Gate ${post.slice(0, 6)} · Day`, DAY],
    );
    await db.query(
      `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [shift, orgId, post, contract, siteId, DAY, startsAt, endsAt],
    );
    await db.query(
      `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'assigned')`,
      [assignment, orgId, shift, siteId, DAY, workerId, startsAt, endsAt],
    );
    for (const [kind, when] of [
      ["in", startsAt],
      ["out", endsAt],
    ] as const) {
      await db.query(
        `insert into public.punches (id, organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
           shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
           clock_drift_seconds, geofence_result, flags, payload_hash, created_at)
         values ($1, $2, $3, $4, 'self', $5, $6, $7, $8, $9, $9, $9, 'elapsed', 0, 'inside', '{}',
           md5(gen_random_uuid()::text), $9)`,
        [randomUUID(), orgId, workerId, kind, randomUUID(), randomUUID(), assignment, siteId, when],
      );
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  if (!refresh) return assignment;
  const refreshed = await (orgId === owner.orgId ? owner : other).client.rpc(
    "refresh_timesheet_lines",
    { p_organisation_id: orgId, p_from: DAY, p_to: DAY, p_worker_ids: [workerId] },
  );
  expect(refreshed.error).toBeNull();
  const { rows } = await db.query<{ id: string }>(
    "select id from public.timesheet_lines where shift_assignment_id = $1",
    [assignment],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function lineStatus(lineId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    "select status from public.timesheet_lines where id = $1",
    [lineId],
  );
  return rows[0]!.status;
}

const approve = (client: Client, lineId: string, orgId = owner.orgId) =>
  client.rpc("approve_timesheet_line", { p_organisation_id: orgId, p_line_id: lineId });
const reject = (client: Client, lineId: string) =>
  client.rpc("reject_timesheet_line", {
    p_organisation_id: owner.orgId,
    p_line_id: lineId,
    p_reason: "Not on site per gate book",
  });

/** The next Monday at least `weeks` weeks ahead. */
function mondayAhead(weeks: number): string {
  const d = new Date(`${lagosToday()}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (8 - dow) + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

async function askLeave(worker: Worker, start: string, end = addDays(start, 2)) {
  const { data, error } = await worker.client.rpc("request_leave", {
    p_organisation_id: owner.orgId,
    p_leave_type_id: annual,
    p_start_date: start,
    p_end_date: end,
  });
  expect(error).toBeNull();
  return String((data as { id: string }).id);
}

const decideStep1 = (client: Client, requestId: string, decision = "approved") =>
  client.rpc("decide_leave_line_manager", {
    p_organisation_id: owner.orgId,
    p_request_id: requestId,
    p_decision: decision,
    ...(decision === "declined" ? { p_note: "Cover is short that week" } : {}),
  });

async function raiseQuery(workerId: string, subject: string) {
  const { data, error } = await staff.hr.client.rpc("raise_staff_query", {
    p_organisation_id: owner.orgId,
    p_worker_id: workerId,
    p_kind: "lateness",
    p_subject: subject,
    p_body: "You clocked in late three times this week. Please explain.",
    p_reply_by: addDays(lagosToday(), 3),
  });
  expect(error).toBeNull();
  return data!;
}

let seededAssignment = "";
let sup: Worker;
let crew: Worker;
let outsider: Worker;
let leaver: Worker;
let leaverCrew: Worker;
let otherSup: Worker;
let otherCrew: string;
let otherSite: string;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("st-owner", "Supervisor Team Org");
  other = await createTenantUser("st-other", "Other Supervisor Org");
  staff.hr = await createTestUser("st-hr");
  staff.ops = await createTestUser("st-ops");
  await addMember(staff.hr, "hr");
  await addMember(staff.ops, "ops_manager");

  for (const [orgId, name] of [
    [owner.orgId, "Apapa Warehouse 3"],
    [other.orgId, "Lekki Mall"],
  ] as const) {
    const { data: clientId, error } = await admin.rpc("create_client", {
      p_organisation_id: orgId,
      p_name: `${name} client`,
      p_contact_name: "Ngozi Eze",
      p_contact_email: "accounts@client.example",
    });
    expect(error).toBeNull();
    const row = await admin
      .from("sites")
      .insert({ organisation_id: orgId, client_id: clientId!, name, centre: CENTRE } as never)
      .select("id")
      .single();
    expect(row.error).toBeNull();
    if (orgId === owner.orgId) site = row.data!.id;
    else otherSite = row.data!.id;
  }

  const preset = await owner.client.rpc("apply_leave_preset", {
    p_organisation_id: owner.orgId,
    p_preset: "B",
  });
  expect(preset.error).toBeNull();
  const types = await admin.from("leave_types").select("id, code").eq("organisation_id", owner.orgId);
  annual = types.data!.find((t) => t.code === "annual")!.id;

  sup = await addWorker();
  crew = await addWorker({ line_manager_worker_id: sup.id });
  outsider = await addWorker();
  leaver = await addWorker();
  leaverCrew = await addWorker({ line_manager_worker_id: leaver.id });
  // The leaver has left: status ended with an end date in the past.
  await db.query(
    "update public.workers set status = 'ended', end_date = current_date - 1 where id = $1",
    [leaver.id],
  );

  otherSup = await addWorker({}, other.orgId);
  otherCrew = await addWorkerRecord({ line_manager_worker_id: otherSup.id }, other.orgId);
});

afterAll(async () => {
  await db?.end();
});

describe("timesheet days", () => {
  it("a supervisor approves and rejects their crew's days", async () => {
    const one = await workedDay(crew.id);
    const listed = await sup.client.rpc("crew_timesheet_days", { p_organisation_id: owner.orgId });
    expect(listed.error).toBeNull();
    expect(listed.data!.map((d) => d.line_id)).toContain(one);
    expect(listed.data!.every((d) => d.worker_id === crew.id)).toBe(true);

    const { data, error } = await approve(sup.client, one);
    expect(error).toBeNull();
    expect((data as { worked_minutes: number }).worked_minutes).toBe(720);
    expect(await lineStatus(one)).toBe("approved");

    const { rows } = await db.query<{ actor_id: string; decision: string }>(
      "select actor_id, decision from public.timesheet_decisions where line_id = $1",
      [one],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe("approved");

    const two = await workedDay(crew.id);
    expect((await reject(sup.client, two)).error).toBeNull();
    expect(await lineStatus(two)).toBe("rejected");
  });

  it("never their own day, a worker outside the crew or another company's", async () => {
    const own = await workedDay(sup.id);
    const ownRes = await approve(sup.client, own);
    expect(ownRes.error?.code).toBe("MLTA1");
    expect(await lineStatus(own)).toBe("pending");

    const outside = await workedDay(outsider.id);
    expect((await approve(sup.client, outside)).error?.code).toBe("42501");
    expect((await reject(sup.client, outside)).error?.code).toBe("42501");
    expect(await lineStatus(outside)).toBe("pending");

    // A crew member's colleague can't approve them: the crew member isn't a supervisor.
    const crewDay = await workedDay(crew.id);
    expect((await approve(outsider.client, crewDay)).error?.code).toBe("42501");
    expect((await approve(crew.client, own)).error?.code).toBe("42501");

    const foreign = await workedDay(otherCrew, other.orgId, otherSite);
    expect((await approve(sup.client, foreign, other.orgId)).error?.code).toBe("42501");
    expect((await approve(sup.client, foreign)).error?.code).toBe("P0002");
    expect(await lineStatus(foreign)).toBe("pending");

    const listed = await sup.client.rpc("crew_timesheet_days", { p_organisation_id: owner.orgId });
    const ids = listed.data!.map((d) => d.line_id);
    expect(ids).not.toContain(own);
    expect(ids).not.toContain(outside);
    expect(ids).toContain(crewDay);
  });

  it("an ended supervisor decides nothing and sees no days", async () => {
    const day = await workedDay(leaverCrew.id);
    expect((await approve(leaver.client, day)).error?.code).toBe("42501");
    const listed = await leaver.client.rpc("crew_timesheet_days", {
      p_organisation_id: owner.orgId,
    });
    expect(listed.error).toBeNull();
    expect(listed.data).toEqual([]);
    expect(await lineStatus(day)).toBe("pending");
  });

  it("refused while the company has Shifts off", async () => {
    const day = await workedDay(crew.id);
    const off = await owner.client.rpc("set_company_modules", {
      p_organisation_id: owner.orgId,
      p_shifts_enabled: false,
      p_people_enabled: true,
      p_payroll_enabled: false,
    });
    expect(off.error).toBeNull();
    try {
      expect((await approve(sup.client, day)).error?.code).toBe("42501");
      // The refresh leaves the crew alone too (security review L3): a day seeded now isn't
      // built by the supervisor's refresh while Shifts is off.
      const seeded = await workedDay(crew.id, owner.orgId, site, false);
      const refreshed = await sup.client.rpc("refresh_timesheet_lines", {
        p_organisation_id: owner.orgId,
        p_from: addDays(lagosToday(), -34),
        p_to: lagosToday(),
      });
      expect(refreshed.error).toBeNull();
      const { rows: none } = await db.query(
        "select 1 from public.timesheet_lines where shift_assignment_id = $1",
        [seeded],
      );
      expect(none).toHaveLength(0);
      seededAssignment = seeded;
      const listed = await sup.client.rpc("crew_timesheet_days", {
        p_organisation_id: owner.orgId,
      });
      expect(listed.data).toEqual([]);
    } finally {
      const on = await owner.client.rpc("set_company_modules", {
        p_organisation_id: owner.orgId,
        p_shifts_enabled: true,
        p_people_enabled: true,
        p_payroll_enabled: false,
      });
      expect(on.error).toBeNull();
    }
    expect(await lineStatus(day)).toBe("pending");
    // Shifts on again: the supervisor's refresh builds the crew's day.
    const back = await sup.client.rpc("refresh_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_from: addDays(lagosToday(), -34),
      p_to: lagosToday(),
    });
    expect(back.error).toBeNull();
    const { rows: built } = await db.query(
      "select 1 from public.timesheet_lines where shift_assignment_id = $1",
      [seededAssignment],
    );
    expect(built).toHaveLength(1);
  });

  it("a supervisor refreshes their crew's days, but not 36 days or anyone else's", async () => {
    const ok = await sup.client.rpc("refresh_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_from: addDays(lagosToday(), -34),
      p_to: lagosToday(),
    });
    expect(ok.error).toBeNull();
    const long = await sup.client.rpc("refresh_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_from: addDays(lagosToday(), -36),
      p_to: lagosToday(),
    });
    expect(long.error?.code).toBe("22023");
  });

  it("other roles, other companies and signed-out callers can't read the crew list", async () => {
    expect(
      (await staff.ops.client.rpc("crew_timesheet_days", { p_organisation_id: owner.orgId })).error
        ?.code,
    ).toBe("42501");
    expect(
      (await sup.client.rpc("crew_timesheet_days", { p_organisation_id: other.orgId })).error?.code,
    ).toBe("42501");
    expect(
      (await anonClient().rpc("crew_timesheet_days", { p_organisation_id: owner.orgId })).error,
    ).not.toBeNull();
  });
});

describe("leave step 1", () => {
  const start = mondayAhead(1);
  const sameYear = addDays(start, 25).slice(0, 4) === lagosToday().slice(0, 4);

  it("the supervisor decides step 1 for their crew, with the balance shown; ops no longer does", async () => {
    if (!sameYear) return;
    const requestId = await askLeave(crew, start);
    const listed = await sup.client.rpc("crew_leave_requests", { p_organisation_id: owner.orgId });
    expect(listed.error).toBeNull();
    const row = listed.data!.find((r) => r.id === requestId)!;
    expect(row.worker_id).toBe(crew.id);
    expect(row.days).toBe(3);
    expect(row.balance).toBeGreaterThan(0);
    expect(Array.isArray(row.open_shifts)).toBe(true);

    // The worker has a line manager now, so ops can't decide step 1.
    expect((await decideStep1(staff.ops.client, requestId)).error?.code).toBe("42501");

    const decided = await decideStep1(sup.client, requestId);
    expect(decided.error).toBeNull();
    expect((decided.data as { status: string }).status).toBe("pending_hr");
    // Step 2 stays HR's.
    const step2 = await sup.client.rpc("decide_leave_hr", {
      p_organisation_id: owner.orgId,
      p_request_id: requestId,
      p_decision: "approved",
    });
    expect(step2.error?.code).toBe("42501");
    const { rows } = await db.query<{ step: string; decision: string }>(
      "select step, decision from public.leave_decisions where request_id = $1",
      [requestId],
    );
    expect(rows).toEqual([{ step: "line_manager", decision: "approved" }]);
  });

  it("never outside the crew, never their own leave", async () => {
    if (!sameYear) return;
    const outsiderRequest = await askLeave(outsider, addDays(start, 7));
    expect((await decideStep1(sup.client, outsiderRequest)).error?.code).toBe("42501");
    const listed = await sup.client.rpc("crew_leave_requests", { p_organisation_id: owner.orgId });
    expect(listed.data!.map((r) => r.id)).not.toContain(outsiderRequest);

    const ownRequest = await askLeave(sup, addDays(start, 14));
    expect((await decideStep1(sup.client, ownRequest)).error?.code).toBe("MLLQ6");
    // The supervisor has no line manager, so ops decides their step 1.
    expect((await decideStep1(staff.ops.client, ownRequest, "declined")).error).toBeNull();
  });

  it("an ended supervisor stops counting: ops decides their old crew's step 1", async () => {
    if (!sameYear) return;
    const requestId = await askLeave(leaverCrew, addDays(start, 21));
    expect((await decideStep1(leaver.client, requestId)).error?.code).toBe("42501");
    expect((await decideStep1(staff.ops.client, requestId, "declined")).error).toBeNull();
  });

  it("other roles and companies can't read the crew's leave", async () => {
    expect(
      (await staff.hr.client.rpc("crew_leave_requests", { p_organisation_id: owner.orgId })).error
        ?.code,
    ).toBe("42501");
    expect(
      (await sup.client.rpc("crew_leave_requests", { p_organisation_id: other.orgId })).error?.code,
    ).toBe("42501");
  });
});

describe("queries stay out of reach", () => {
  it("a supervisor reads none of their crew's queries or replies and can't raise one", async () => {
    const query = await raiseQuery(crew.id, "Late on Monday");
    const direct = await sup.client.from("staff_queries").select("id, subject").eq("id", query);
    expect(direct.data ?? []).toEqual([]);
    const replies = await sup.client.from("staff_query_replies").select("id").eq("query_id", query);
    expect(replies.data ?? []).toEqual([]);
    const raised = await sup.client.rpc("raise_staff_query", {
      p_organisation_id: owner.orgId,
      p_worker_id: crew.id,
      p_kind: "lateness",
      p_subject: "Late again",
      p_body: "Please explain why you were late.",
      p_reply_by: addDays(lagosToday(), 3),
    });
    expect(raised.error).not.toBeNull();
  });
});

describe("the Approvals tile", () => {
  it("counts the people a supervisor supervises, and 0 for everyone else", async () => {
    const size = async (client: Client) =>
      (await client.rpc("crew_team_size", { p_organisation_id: owner.orgId })).data;
    expect(await size(sup.client)).toBe(1);
    expect(await size(crew.client)).toBe(0);
    expect(await size(leaver.client)).toBe(0);
    expect(await size(staff.ops.client)).toBe(0);
  });
});
