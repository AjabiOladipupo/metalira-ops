/**
 * Slice 4.2: timesheet days from punches, against the real database.
 * - The accept examples: a 07:00 to 19:00 shift clocked in at 07:08 and out at 19:20 is 720
 *   worked and 20 overtime; in at 07:25 is 695 and late; with no clock-out it is 0 until a
 *   correction with a reason sets one, and the punches never change.
 * - Night shifts belong to the day they start; a shift on the 19th and one on the 20th land in
 *   different pay periods. Patrol scans never count. A removed shift with no punches has no line.
 * - Reads: owner, admin, hr and ops_manager every line; a line manager their reportees'; the
 *   worker their own; finance and another company nothing.
 * - Corrections: insert-only for every role, the secret key and the database owner included;
 *   never on your own line (an ops_manager linked to their own worker record included); a line manager only for reportees; hr can't;
 *   the reason is plain text.
 * - Frozen lines: an approved or rejected line is unchanged by a refresh, refuses corrections and
 *   refuses direct edits and deletes.
 * - Refresh scope: 62 days at most; a line manager refreshes only their reportees, a worker only
 *   themselves; finance is refused.
 * - private.punch_under_review follows the lines (decision 12), and the selfie sweep with it.
 * - The staff ID hook sees timesheet lines.
 * - The SQL minute rules agree with src/lib/timesheets/minutes.ts.
 *
 * Shifts and assignments are seeded as the database owner with triggers off for the transaction
 * only (session_replication_role = replica), so their times can sit anywhere in the past; the
 * roster rules have their own suites. Punches are inserted as the database owner (insert-only).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { computeLine, periodStart, type LineInput } from "@/lib/timesheets/minutes";
import type { Database } from "@/types/db";

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
type Line = Database["public"]["Tables"]["timesheet_lines"]["Row"];

const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const DAY = addDays(lagosToday(), -3);
const at = (day: string, time: string) => Date.parse(`${day}T${time}:00+01:00`);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager" | "worker", TestUser>;
let lmMembershipId: string;
let site: string;
let otherSite: string;
let counter = 0;

async function addMember(
  user: TestUser,
  role: Role,
  orgId = owner.orgId,
  workerId: string | null = null,
): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function addSite(orgId: string, name: string): Promise<string> {
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
  return row.data!.id;
}

async function addWorker(
  orgId = owner.orgId,
  extra: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
): Promise<string> {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `TS-${String(counter).padStart(4, "0")}`,
      first_name: "Musa",
      last_name: `Bello ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** A post, a shift and an assignment on `day` from `startsAt` to `endsAt`, triggers off. */
async function rostered(
  workerId: string,
  day: string,
  startsAt: number,
  endsAt: number,
  options: { orgId?: string; siteId?: string; status?: "assigned" | "removed" } = {},
): Promise<string> {
  const orgId = options.orgId ?? owner.orgId;
  const siteId = options.siteId ?? site;
  const status = options.status ?? "assigned";
  const post = randomUUID();
  const shift = randomUUID();
  const assignment = randomUUID();
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
       values ($1, $2, $3, $4, $5, 'Guard', 'Day', 'shift', $6)`,
      [post, orgId, randomUUID(), siteId, `Gate ${randomUUID().slice(0, 6)} · Day`, day],
    );
    await db.query(
      `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [shift, orgId, post, randomUUID(), siteId, day, new Date(startsAt), new Date(endsAt)],
    );
    await db.query(
      `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status, removed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        assignment,
        orgId,
        shift,
        siteId,
        day,
        workerId,
        new Date(startsAt),
        new Date(endsAt),
        status,
        status === "removed" ? new Date() : null,
      ],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  return assignment;
}

async function punch(
  workerId: string,
  assignmentId: string | null,
  kind: "in" | "out" | "checkpoint",
  when: number,
  options: {
    flags?: string[];
    orgId?: string;
    siteId?: string;
    id?: string;
    receivedAt?: number;
  } = {},
): Promise<string> {
  const orgId = options.orgId ?? owner.orgId;
  const id = options.id ?? randomUUID();
  let checkpoint: string | null = null;
  if (kind === "checkpoint") {
    const cp = await db.query<{ id: string }>(
      `insert into public.site_checkpoints (organisation_id, site_id, name)
       values ($1, $2, $3) returning id`,
      [orgId, options.siteId ?? site, `Point ${randomUUID().slice(0, 6)}`],
    );
    checkpoint = cp.rows[0]!.id;
  }
  await db.query(
    `insert into public.punches (id, organisation_id, worker_id, kind, recorded_by_user, client_event_id,
       shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
       clock_drift_seconds, geofence_result, flags, payload_hash, checkpoint_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12, $9, 'elapsed', 0, 'inside', $10,
       md5(gen_random_uuid()::text), $11)`,
    [
      id,
      orgId,
      workerId,
      kind,
      randomUUID(),
      randomUUID(),
      assignmentId,
      options.siteId ?? site,
      new Date(when),
      options.flags ?? [],
      checkpoint,
      new Date(options.receivedAt ?? when),
    ],
  );
  return id;
}

async function refresh(client: Client, from = DAY, to = DAY, orgId = owner.orgId) {
  return client.rpc("refresh_timesheet_lines", {
    p_organisation_id: orgId,
    p_from: from,
    p_to: to,
  });
}

/**
 * Moves a line's status as the database owner, with the decision row slice 4.3's guard requires
 * (a line's status follows its latest decision).
 */
async function setStatus(lineId: string, status: "pending" | "approved" | "rejected" | "disputed") {
  const decision = status === "pending" ? "reopened" : status;
  await db.query(
    `insert into public.timesheet_decisions (organisation_id, line_id, worker_id, decision, reason,
       actor_id, scheduled_minutes, worked_minutes, late_minutes, early_minutes, ot_minutes, exceptions)
     select organisation_id, id, worker_id, $2::text,
       case when $2::text = 'approved' then null else 'Set by the test' end, $3,
       scheduled_minutes, worked_minutes, late_minutes, early_minutes, ot_minutes, exceptions
     from public.timesheet_lines where id = $1`,
    [lineId, decision, owner.id],
  );
  await db.query("update public.timesheet_lines set status = $2 where id = $1", [lineId, status]);
}

async function lineFor(assignmentId: string): Promise<Line> {
  const { rows } = await db.query<Line>(
    "select *, work_date::text as work_date from public.timesheet_lines where shift_assignment_id = $1",
    [assignmentId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function correct(
  client: Client,
  lineId: string,
  args: Partial<{
    kind: string;
    reason: string;
    correctedAt: string;
    minutes: number;
    punchId: string;
  }> = {},
) {
  return client.rpc("add_timesheet_correction", {
    p_organisation_id: owner.orgId,
    p_line_id: lineId,
    p_kind: args.kind ?? "set_clock_out",
    p_reason: args.reason ?? "Gate book shows 19:00",
    ...(args.correctedAt
      ? { p_corrected_at: args.correctedAt }
      : args.kind === undefined || args.kind === "set_clock_out"
        ? { p_corrected_at: new Date(at(DAY, "19:00")).toISOString() }
        : {}),
    ...(args.minutes !== undefined ? { p_minutes: args.minutes } : {}),
    ...(args.punchId ? { p_punch_id: args.punchId } : {}),
  });
}

const W = {} as Record<"onTime" | "late" | "noOut" | "reportee" | "self" | "other", string>;
const A = {} as Record<keyof typeof W, string>;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ts-owner", "Timesheet Org");
  other = await createTenantUser("ts-other", "Other Timesheet Org");
  staff.admin = await createTestUser("ts-admin");
  staff.hr = await createTestUser("ts-hr");
  staff.finance = await createTestUser("ts-finance");
  staff.ops = await createTestUser("ts-ops");
  staff.lineManager = await createTestUser("ts-lm");
  staff.worker = await createTestUser("ts-worker");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  lmMembershipId = await addMember(staff.lineManager, "line_manager");

  site = await addSite(owner.orgId, "Apapa Warehouse 3");
  otherSite = await addSite(other.orgId, "Other Gate");

  const start = at(DAY, "07:00");
  const end = at(DAY, "19:00");
  W.onTime = await addWorker();
  A.onTime = await rostered(W.onTime, DAY, start, end);
  await punch(W.onTime, A.onTime, "in", at(DAY, "07:08"));
  await punch(W.onTime, A.onTime, "out", at(DAY, "19:20"));
  // A patrol scan on the shift never counts as a clock-in or clock-out.
  await punch(W.onTime, A.onTime, "checkpoint", at(DAY, "12:00"));

  W.late = await addWorker();
  A.late = await rostered(W.late, DAY, start, end);
  await punch(W.late, A.late, "in", at(DAY, "07:25"));
  await punch(W.late, A.late, "out", at(DAY, "19:00"));

  W.noOut = await addWorker();
  A.noOut = await rostered(W.noOut, DAY, start, end);
  await punch(W.noOut, A.noOut, "in", at(DAY, "07:02"));

  W.reportee = await addWorker(owner.orgId, { line_manager_membership_id: lmMembershipId });
  A.reportee = await rostered(W.reportee, DAY, start, end);
  await punch(W.reportee, A.reportee, "in", at(DAY, "07:00"), { flags: ["delayed"] });
  await punch(W.reportee, A.reportee, "out", at(DAY, "19:00"));

  // The worker login's own worker record.
  W.self = await addWorker();
  A.self = await rostered(W.self, DAY, start, end);
  await addMember(staff.worker, "worker", owner.orgId, W.self);

  W.other = await addWorker(other.orgId);
  A.other = await rostered(W.other, DAY, start, end, { orgId: other.orgId, siteId: otherSite });

  const mine = await refresh(owner.client);
  expect(mine.error).toBeNull();
  const theirs = await refresh(other.client, DAY, DAY, other.orgId);
  expect(theirs.error).toBeNull();
});

afterAll(async () => {
  await db?.end();
});

describe("the accept examples", () => {
  it("07:08 to 19:20 is 720 worked and 20 overtime", async () => {
    const l = await lineFor(A.onTime);
    expect(l).toMatchObject({
      work_date: DAY,
      scheduled_minutes: 720,
      worked_minutes: 720,
      late_minutes: 0,
      ot_minutes: 20,
      exceptions: ["overtime"],
      needs_review: false,
      status: "pending",
    });
  });

  it("07:25 is 695 worked, flagged late", async () => {
    expect(await lineFor(A.late)).toMatchObject({
      worked_minutes: 695,
      late_minutes: 25,
      exceptions: ["late"],
    });
  });

  it("no clock-out is 0 until a correction with a reason sets one; the punches never change", async () => {
    const before = await lineFor(A.noOut);
    expect(before).toMatchObject({ worked_minutes: 0, exceptions: ["no_clock_out"] });
    const punchesBefore = await db.query("select * from public.punches where worker_id = $1", [
      W.noOut,
    ]);
    const fixed = await correct(staff.ops.client, before.id);
    expect(fixed.error).toBeNull();
    expect(await lineFor(A.noOut)).toMatchObject({
      worked_minutes: 720,
      exceptions: ["corrected"],
    });
    const punchesAfter = await db.query("select * from public.punches where worker_id = $1", [
      W.noOut,
    ]);
    expect(punchesAfter.rows).toEqual(punchesBefore.rows);
    // A later refresh keeps applying the correction.
    expect((await refresh(owner.client)).error).toBeNull();
    expect((await lineFor(A.noOut)).worked_minutes).toBe(720);
  });

  it("a delayed punch sets needs_review", async () => {
    expect(await lineFor(A.reportee)).toMatchObject({
      worked_minutes: 720,
      exceptions: ["delayed"],
      needs_review: true,
    });
  });

  it("a rostered worker with no punches shows as a no-show; the timesheet follows the pay period", async () => {
    const l = await lineFor(A.self);
    expect(l).toMatchObject({ worked_minutes: 0, exceptions: ["no_show"] });
    const sheet = await db.query(
      "select worker_id, period_start::text as period_start, period_end::text as period_end from public.timesheets where id = $1",
      [l.timesheet_id],
    );
    expect(sheet.rows[0]).toMatchObject({ worker_id: W.self, period_start: periodStart(DAY, 20) });
  });
});

describe("days, periods and what counts", () => {
  it("a night shift belongs to the day it starts; the 19th and the 20th land in different periods", async () => {
    const today = lagosToday();
    const [y, m] = today.split("-").map(Number) as [number, number];
    // Last month's 19th and 20th: always in the past and within 62 days of each other.
    const month = new Date(Date.UTC(y, m - 2, 1));
    const ym = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    const d19 = `${ym}-19`;
    const d20 = `${ym}-20`;
    const w = await addWorker();
    const night = await rostered(w, d19, at(d19, "19:00"), at(d20, "07:00"));
    await punch(w, night, "in", at(d19, "18:58"));
    await punch(w, night, "out", at(d20, "07:10"));
    const day = await rostered(w, d20, at(d20, "19:00"), at(addDays(d20, 1), "07:00"));
    await punch(w, day, "in", at(d20, "19:00"));
    await punch(w, day, "out", at(addDays(d20, 1), "07:00"));
    expect((await refresh(owner.client, d19, d20)).error).toBeNull();
    const n = await lineFor(night);
    const d = await lineFor(day);
    expect(n).toMatchObject({ work_date: d19, worked_minutes: 720, ot_minutes: 10 });
    expect(d).toMatchObject({ work_date: d20, worked_minutes: 720 });
    const { rows } = await db.query<{ id: string; period_start: string }>(
      "select id, period_start::text as period_start from public.timesheets where id = any($1)",
      [[n.timesheet_id, d.timesheet_id]],
    );
    const periods = new Map(rows.map((r) => [r.id, r.period_start]));
    expect(periods.get(n.timesheet_id)).toBe(periodStart(d19, 20));
    expect(periods.get(d.timesheet_id)).toBe(d20);
  });

  it("a clock-in with no shift gets its own no_shift line, paired with its clock-out", async () => {
    const w = await addWorker();
    const p = await punch(w, null, "in", at(DAY, "08:00"), { flags: ["no_shift"] });
    await punch(w, null, "out", at(DAY, "16:30"), { flags: ["no_shift"] });
    expect((await refresh(owner.client)).error).toBeNull();
    const { rows } = await db.query<Line>(
      "select *, work_date::text as work_date from public.timesheet_lines where no_shift_punch_id = $1",
      [p],
    );
    expect(rows[0]).toMatchObject({
      work_date: DAY,
      shift_assignment_id: null,
      scheduled_minutes: 0,
      worked_minutes: 510,
      exceptions: ["no_shift"],
    });
  });

  it("a shift taken off before anyone clocked in has no line, and a stale pending line goes", async () => {
    const w = await addWorker();
    const removed = await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"), {
      status: "removed",
    });
    const kept = await rostered(
      w,
      addDays(DAY, -1),
      at(addDays(DAY, -1), "07:00"),
      at(addDays(DAY, -1), "19:00"),
    );
    expect((await refresh(owner.client, addDays(DAY, -1), DAY)).error).toBeNull();
    const none = await db.query(
      "select 1 from public.timesheet_lines where shift_assignment_id = $1",
      [removed],
    );
    expect(none.rows).toEqual([]);
    expect((await lineFor(kept)).exceptions).toEqual(["no_show"]);
    // The assignment is taken off afterwards: its pending line, with no correction, goes.
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(
      "update public.shift_assignments set status = 'removed', removed_at = now() where id = $1",
      [kept],
    );
    await db.query("commit");
    expect((await refresh(owner.client, addDays(DAY, -1), DAY)).error).toBeNull();
    const gone = await db.query(
      "select 1 from public.timesheet_lines where shift_assignment_id = $1",
      [kept],
    );
    expect(gone.rows).toEqual([]);
  });

  it("a shift that hasn't started has no line yet", async () => {
    const w = await addWorker();
    const tomorrow = addDays(lagosToday(), 1);
    const later = await rostered(w, tomorrow, at(tomorrow, "07:00"), at(tomorrow, "19:00"));
    expect((await refresh(owner.client, tomorrow, tomorrow)).error).toBeNull();
    const none = await db.query(
      "select 1 from public.timesheet_lines where shift_assignment_id = $1",
      [later],
    );
    expect(none.rows).toEqual([]);
  });
});

describe("who reads timesheets", () => {
  const ids = async (
    client: Client,
    table: "timesheet_lines" | "timesheets" | "timesheet_corrections",
  ) => {
    const { data, error } = await client.from(table).select("worker_id");
    expect(error).toBeNull();
    return new Set((data ?? []).map((r) => r.worker_id));
  };

  it("owner, admin, hr and ops_manager read every line; finance none", async () => {
    for (const client of [owner.client, staff.admin.client, staff.hr.client, staff.ops.client]) {
      const seen = await ids(client, "timesheet_lines");
      for (const w of [W.onTime, W.late, W.noOut, W.reportee, W.self])
        expect(seen.has(w)).toBe(true);
      expect(seen.has(W.other)).toBe(false);
    }
    expect((await ids(staff.finance.client, "timesheet_lines")).size).toBe(0);
  });

  it("a line manager reads their reportees' lines and corrections only", async () => {
    expect([...(await ids(staff.lineManager.client, "timesheet_lines"))]).toEqual([W.reportee]);
    expect([...(await ids(staff.lineManager.client, "timesheets"))]).toEqual([W.reportee]);
  });

  it("a worker reads their own only; another company nothing", async () => {
    expect([...(await ids(staff.worker.client, "timesheet_lines"))]).toEqual([W.self]);
    expect([...(await ids(staff.worker.client, "timesheet_corrections"))]).toEqual([]);
    const theirs = await ids(other.client, "timesheet_lines");
    expect([...theirs]).toEqual([W.other]);
  });
});

describe("corrections", () => {
  it("are insert-only for everyone, the secret key and the database owner included", async () => {
    const l = await lineFor(A.noOut);
    const { rows } = await db.query<{ id: string }>(
      "select id from public.timesheet_corrections where line_id = $1",
      [l.id],
    );
    const id = rows[0]!.id;
    await expect(
      db.query("update public.timesheet_corrections set reason = 'Changed' where id = $1", [id]),
    ).rejects.toMatchObject({ code: "MLTS0" });
    await expect(
      db.query("delete from public.timesheet_corrections where id = $1", [id]),
    ).rejects.toMatchObject({ code: "MLTS0" });
    await expect(db.query("truncate public.timesheet_corrections cascade")).rejects.toBeTruthy();
    await expect(db.query("truncate public.timesheet_lines cascade")).rejects.toBeTruthy();
    await expect(db.query("truncate public.timesheets cascade")).rejects.toBeTruthy();
    const update = await admin.from("timesheet_corrections").update({ reason: "x" }).eq("id", id);
    expect(update.error).not.toBeNull();
    const del = await admin.from("timesheet_corrections").delete().eq("id", id);
    expect(del.error).not.toBeNull();
    const insert = await admin.from("timesheet_corrections").insert({
      organisation_id: owner.orgId,
      line_id: l.id,
      worker_id: W.noOut,
      kind: "set_minutes",
      minutes: 600,
      reason: "Planted",
    });
    expect(insert.error).not.toBeNull();
    const direct = await staff.ops.client.from("timesheet_corrections").insert({
      organisation_id: owner.orgId,
      line_id: l.id,
      worker_id: W.noOut,
      kind: "set_minutes",
      minutes: 600,
      reason: "Planted",
    });
    expect(direct.error?.code).toBe("42501");
    const lineEdit = await staff.ops.client
      .from("timesheet_lines")
      .update({ worked_minutes: 1 })
      .eq("id", l.id);
    expect(lineEdit.error?.code).toBe("42501");
    const after = await db.query("select reason from public.timesheet_corrections where id = $1", [
      id,
    ]);
    expect(after.rows[0].reason).toBe("Gate book shows 19:00");
  });

  it("are refused on your own line, even for an operations manager", async () => {
    // An owner can never be a worker (MLOW3); an ops_manager linked to their own worker record can.
    const mine = await addWorker();
    const asg = await rostered(mine, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    const opsSelf = await createTestUser("ts-ops-self");
    await addMember(opsSelf, "ops_manager", owner.orgId, mine);
    expect((await refresh(owner.client)).error).toBeNull();
    const l = await lineFor(asg);
    const res = await correct(opsSelf.client, l.id, { kind: "set_minutes", minutes: 720 });
    expect(res.error?.code).toBe("MLTS1");
    // Another ops_manager may.
    const ok = await correct(staff.ops.client, l.id, {
      kind: "set_minutes",
      minutes: 0,
      reason: "Did not attend",
    });
    expect(ok.error).toBeNull();
  });

  it("a line manager corrects reportees only; hr and finance can't; another company can't", async () => {
    const reportee = await lineFor(A.reportee);
    const late = await lineFor(A.late);
    const ok = await correct(staff.lineManager.client, reportee.id, {
      kind: "set_minutes",
      minutes: 480,
      reason: "Went home sick at 15:00",
    });
    expect(ok.error).toBeNull();
    expect((await lineFor(A.reportee)).worked_minutes).toBe(480);
    expect(
      (await correct(staff.lineManager.client, late.id, { kind: "set_minutes", minutes: 1 })).error
        ?.code,
    ).toBe("42501");
    for (const client of [
      staff.hr.client,
      staff.finance.client,
      staff.worker.client,
      other.client,
    ]) {
      const res = await correct(client, late.id, { kind: "set_minutes", minutes: 1 });
      expect(res.error?.code).toBe("42501");
    }
    expect((await lineFor(A.late)).worked_minutes).toBe(695);
  });

  it("needs a plain-text reason and valid values", async () => {
    const l = await lineFor(A.late);
    for (const reason of ["", "see https://example.com", "call 08031234567", "<b>x</b>"]) {
      const res = await correct(staff.ops.client, l.id, {
        kind: "set_minutes",
        minutes: 600,
        reason,
      });
      expect(res.error?.code, reason).toBe("MLTS4");
    }
    const future = await correct(staff.ops.client, l.id, {
      correctedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(future.error?.code).toBe("MLTS3");
    const farAway = await correct(staff.ops.client, l.id, {
      correctedAt: new Date(at(DAY, "07:00") - 2 * 86_400_000).toISOString(),
    });
    expect(farAway.error?.code).toBe("MLTS3");
    const tooMany = await correct(staff.ops.client, l.id, { kind: "set_minutes", minutes: 2000 });
    expect(tooMany.error?.code).toBe("MLTS3");
    const notMine = await correct(staff.ops.client, l.id, {
      kind: "void_punch",
      punchId: randomUUID(),
    });
    expect(notMine.error?.code).toBe("MLTS3");
  });

  it("a no-shift day can't be corrected to span more than 24 hours (security review M1)", async () => {
    const w = await addWorker();
    const p = await punch(w, null, "in", at(DAY, "08:00"), { flags: ["no_shift"] });
    await punch(w, null, "out", at(DAY, "23:00"), { flags: ["no_shift"] });
    expect((await refresh(owner.client)).error).toBeNull();
    const { rows } = await db.query<Line>(
      "select * from public.timesheet_lines where no_shift_punch_id = $1",
      [p],
    );
    const lineId = rows[0]!.id;
    const early = await correct(staff.ops.client, lineId, {
      kind: "set_clock_in",
      correctedAt: new Date(at(DAY, "08:00") - 12 * 3_600_000).toISOString(),
      reason: "Started the night before",
    });
    expect(early.error?.code).toBe("MLTS3");
    const ok = await correct(staff.ops.client, lineId, {
      kind: "set_clock_in",
      correctedAt: new Date(at(DAY, "08:00") - 3 * 3_600_000).toISOString(),
      reason: "Arrived at 05:00",
    });
    expect(ok.error).toBeNull();
    const after = await db.query<Line>("select * from public.timesheet_lines where id = $1", [
      lineId,
    ]);
    expect(after.rows[0]!.worked_minutes).toBe(1080);
  });

  it("void_punch sets a clock-in aside and the next one counts", async () => {
    const w = await addWorker();
    const asg = await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    const first = await punch(w, asg, "in", at(DAY, "06:00"));
    await punch(w, asg, "in", at(DAY, "07:30"), { flags: ["double_in"] });
    await punch(w, asg, "out", at(DAY, "19:00"));
    expect((await refresh(owner.client)).error).toBeNull();
    const before = await lineFor(asg);
    expect(before).toMatchObject({ in_punch_id: first, worked_minutes: 720 });
    const res = await correct(staff.ops.client, before.id, {
      kind: "void_punch",
      punchId: first,
      reason: "Clocked in from home by mistake",
    });
    expect(res.error).toBeNull();
    expect(await lineFor(asg)).toMatchObject({
      worked_minutes: 690,
      late_minutes: 30,
      exceptions: ["late", "double_in", "corrected"],
    });
  });
});

describe("frozen lines", () => {
  it("an approved line is unchanged by refresh and refuses corrections, edits and deletes", async () => {
    const w = await addWorker();
    const asg = await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await punch(w, asg, "in", at(DAY, "07:00"));
    expect((await refresh(owner.client)).error).toBeNull();
    const l = await lineFor(asg);
    await setStatus(l.id, "approved");
    const snapshot = await lineFor(asg);
    await punch(w, asg, "out", at(DAY, "19:00"));
    expect((await refresh(owner.client)).error).toBeNull();
    expect(await lineFor(asg)).toEqual(snapshot);
    const res = await correct(staff.ops.client, l.id);
    expect(res.error?.code).toBe("MLTS2");
    await expect(
      db.query("update public.timesheet_lines set worked_minutes = 720 where id = $1", [l.id]),
    ).rejects.toMatchObject({ code: "MLTS0" });
    await expect(
      db.query("delete from public.timesheet_lines where id = $1", [l.id]),
    ).rejects.toMatchObject({ code: "MLTS0" });
    await expect(
      db.query("update public.timesheets set period_end = period_end + 1 where id = $1", [
        l.timesheet_id,
      ]),
    ).rejects.toMatchObject({ code: "MLTS0" });
  });
});

describe("refresh scope", () => {
  it("refuses more than 62 days, and finance", async () => {
    const wide = await refresh(owner.client, addDays(DAY, -63), DAY);
    expect(wide.error?.code).toBe("22023");
    const fin = await refresh(staff.finance.client);
    expect(fin.error?.code).toBe("42501");
    const cross = await refresh(owner.client, DAY, DAY, other.orgId);
    expect(cross.error?.code).toBe("42501");
  });

  it("a worker refreshes at most 35 days", async () => {
    const wide = await refresh(staff.worker.client, addDays(DAY, -36), DAY);
    expect(wide.error?.code).toBe("22023");
    expect((await refresh(staff.worker.client, addDays(DAY, -35), DAY)).error).toBeNull();
  });

  it("a line manager refreshes only reportees, a worker only themselves", async () => {
    const w = await addWorker();
    const asg = await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    expect((await refresh(staff.lineManager.client)).error).toBeNull();
    expect((await refresh(staff.worker.client)).error).toBeNull();
    const none = await db.query(
      "select 1 from public.timesheet_lines where shift_assignment_id = $1",
      [asg],
    );
    expect(none.rows).toEqual([]);
    expect((await refresh(staff.hr.client)).error).toBeNull();
    expect((await lineFor(asg)).exceptions).toEqual(["no_show"]);
  });

  it("the cron's functions are for the server only", async () => {
    expect((await owner.client.rpc("timesheet_cron_organisations", {})).error).not.toBeNull();
    expect(
      (await owner.client.rpc("refresh_timesheets_recent", { p_organisation_id: owner.orgId }))
        .error,
    ).not.toBeNull();
    const orgs = await admin.rpc("timesheet_cron_organisations", { p_limit: 200 });
    expect(orgs.error).toBeNull();
    const recent = await admin.rpc("refresh_timesheets_recent", { p_organisation_id: owner.orgId });
    expect(recent.error).toBeNull();
    expect(recent.data).toMatchObject({ failed: 0 });
  });

  it("the cron skips a worker whose refresh fails and refreshes the rest (security review M1)", async () => {
    const yesterday = addDays(lagosToday(), -1);
    const bad = await addWorker();
    const good = await addWorker();
    const badAsg = await rostered(bad, yesterday, at(yesterday, "07:00"), at(yesterday, "19:00"));
    const goodAsg = await rostered(good, yesterday, at(yesterday, "07:00"), at(yesterday, "19:00"));
    // A row the database refuses for one worker only, standing in for any bad data.
    await db.query(`create function public.ts_test_refuse() returns trigger language plpgsql as $f$
      begin
        if new.worker_id = '${bad}'::uuid then raise exception 'refused for the test'; end if;
        return new;
      end $f$`);
    await db.query(
      "create trigger ts_test_refuse before insert on public.timesheet_lines for each row execute function public.ts_test_refuse()",
    );
    try {
      const res = await admin.rpc("refresh_timesheets_recent", { p_organisation_id: owner.orgId });
      expect(res.error).toBeNull();
      expect((res.data as { failed: number }).failed).toBe(1);
    } finally {
      await db.query("drop trigger ts_test_refuse on public.timesheet_lines");
      await db.query("drop function public.ts_test_refuse()");
    }
    expect((await lineFor(goodAsg)).exceptions).toEqual(["no_show"]);
    const none = await db.query(
      "select 1 from public.timesheet_lines where shift_assignment_id = $1",
      [badAsg],
    );
    expect(none.rows).toEqual([]);
  });
});

describe("punch_under_review follows the lines (decision 12)", () => {
  const underReview = async (punchId: string) =>
    (
      await db.query<{ r: boolean }>("select private.punch_under_review($1, $2) as r", [
        owner.orgId,
        punchId,
      ])
    ).rows[0]!.r;

  it("is true with no line yet, while pending or disputed; false once approved or rejected", async () => {
    const w = await addWorker();
    const asg = await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    const p = await punch(w, asg, "in", at(DAY, "07:00"));
    const second = await punch(w, asg, "in", at(DAY, "07:05"));
    expect(await underReview(p)).toBe(true);
    expect((await refresh(owner.client)).error).toBeNull();
    const l = await lineFor(asg);
    expect(await underReview(p)).toBe(true);
    // A second clock-in the line didn't pick is kept while the shift's line is open.
    expect(await underReview(second)).toBe(true);
    await setStatus(l.id, "disputed");
    expect(await underReview(p)).toBe(true);
    expect(await underReview(second)).toBe(true);
    await setStatus(l.id, "approved");
    expect(await underReview(p)).toBe(false);
    // Once decided, a punch the line doesn't point at follows the 90-day age rule only (it
    // arrived before the decision): kept now, swept once old (security review L2).
    expect(await underReview(second)).toBe(true);
    await setStatus(l.id, "pending");
    await setStatus(l.id, "rejected");
    expect(await underReview(p)).toBe(false);
  });

  it("a punch no line ever uses is kept under 90 days only (security review L1)", async () => {
    const w = await addWorker();
    const old = new Date(Date.now() - 100 * 86_400_000);
    const stale = randomUUID();
    await db.query(
      `insert into public.punches (id, organisation_id, worker_id, kind, recorded_by_user, client_event_id,
         site_id, device_time, received_at, recorded_at, time_source, clock_drift_seconds,
         geofence_result, flags, payload_hash, created_at)
       values ($1, $2, $3, 'out', $4, $5, $6, $7, $7, $7, 'elapsed', 0, 'inside', '{}', md5('stale'), $7)`,
      [stale, owner.orgId, w, randomUUID(), randomUUID(), site, old],
    );
    expect(await underReview(stale)).toBe(false);
    const fresh = await punch(w, null, "out", at(DAY, "16:00"));
    expect(await underReview(fresh)).toBe(true);
  });

  it("a punch arriving after its day was decided is kept and flags the line (security review L2)", async () => {
    const w = await addWorker();
    const asg = await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await punch(w, asg, "in", at(DAY, "07:00"));
    expect((await refresh(owner.client)).error).toBeNull();
    const l = await lineFor(asg);
    await setStatus(l.id, "approved");
    const decided = await lineFor(asg);
    expect(decided.decided_at).not.toBeNull();
    // The clock-out syncs after the approval.
    const late = await punch(w, asg, "out", at(DAY, "19:00"), { receivedAt: Date.now() });
    expect(await underReview(late)).toBe(true);
    expect((await refresh(owner.client)).error).toBeNull();
    const flagged = await lineFor(asg);
    expect(flagged).toMatchObject({
      status: "approved",
      worked_minutes: decided.worked_minutes,
      out_punch_id: null,
      exceptions: [...decided.exceptions, "late_punch_after_decision"],
    });
    expect(await underReview(late)).toBe(true);
    // The flag is the only change a decided day accepts.
    await expect(
      db.query("update public.timesheet_lines set exceptions = '{}' where id = $1", [l.id]),
    ).rejects.toMatchObject({ code: "MLTS0" });
  });

  it("a voided punch follows the line that set it aside", async () => {
    const w = await addWorker();
    const asg = await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    const p = await punch(w, asg, "in", at(DAY, "07:00"));
    expect((await refresh(owner.client)).error).toBeNull();
    const l = await lineFor(asg);
    expect(
      (
        await correct(staff.ops.client, l.id, {
          kind: "void_punch",
          punchId: p,
          reason: "Test punch",
        })
      ).error,
    ).toBeNull();
    expect((await lineFor(asg)).in_punch_id).toBeNull();
    expect(await underReview(p)).toBe(true);
    await setStatus(l.id, "approved");
    expect(await underReview(p)).toBe(false);
  });

  it("the 90-day selfie sweep keeps a pending day's selfie and offers a decided or unused one", async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    const day = lagosToday(old);
    const ym = old.toISOString().slice(0, 7);
    const w = await addWorker();
    const asg = await rostered(w, day, at(day, "07:00"), at(day, "19:00"));
    const id = randomUUID();
    await db.query(
      `insert into public.punches (id, organisation_id, worker_id, kind, recorded_by_user, client_event_id,
         shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
         clock_drift_seconds, geofence_result, flags, payload_hash, selfie_expected, selfie_path,
         selfie_uploaded_at, created_at)
       values ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $8, $8, 'elapsed', 0, 'inside', '{}',
         md5('old'), true, $9, $8, $10)`,
      [
        id,
        owner.orgId,
        w,
        randomUUID(),
        randomUUID(),
        asg,
        site,
        new Date(at(day, "07:00")),
        `${owner.orgId}/${ym}/${id}.jpg`,
        old,
      ],
    );
    const due = async () => {
      const res = await admin.rpc("punch_selfies_due", { p_limit: 1000 });
      expect(res.error).toBeNull();
      return (res.data ?? []).some((d) => d.punch_id === id);
    };
    // No line has ever used it and it is past 90 days (the cron covers 7 days, so a punch that
    // should have a line has one long before): not kept (security review L1).
    expect(await due()).toBe(true);
    expect((await refresh(owner.client, day, day)).error).toBeNull();
    const l = await lineFor(asg);
    expect(await due()).toBe(false);
    await setStatus(l.id, "approved");
    expect(await due()).toBe(true);
  });
});

describe("the staff ID hook sees timesheet lines", () => {
  it("a worker with only a no-show line has work records", async () => {
    const w = await addWorker();
    const has = async () =>
      (
        await db.query<{ has: boolean }>("select private.worker_has_work_records($1, $2) as has", [
          owner.orgId,
          w,
        ])
      ).rows[0]!.has;
    expect(await has()).toBe(false);
    await rostered(w, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    expect(await has()).toBe(false);
    expect((await refresh(owner.client)).error).toBeNull();
    expect(await has()).toBe(true);
  });
});

describe("the SQL rules match src/lib/timesheets", () => {
  it("minutes and exceptions", async () => {
    const now = at("2026-11-12", "09:00");
    const base: LineInput = {
      startsAt: at("2026-11-10", "07:00"),
      endsAt: at("2026-11-10", "19:00"),
      inAt: at("2026-11-10", "07:08"),
      outAt: at("2026-11-10", "19:20"),
      setMinutes: null,
      setOtMinutes: null,
      inFlags: [],
      outFlags: [],
      bySupervisor: false,
      corrected: false,
      shiftRemoved: false,
      graceMinutes: 10,
      noShowAfterMinutes: 60,
      now,
    };
    const cases: LineInput[] = [
      base,
      { ...base, inAt: at("2026-11-10", "07:25") },
      { ...base, inAt: at("2026-11-10", "07:10") + 59_000, outAt: at("2026-11-10", "18:30") },
      { ...base, inAt: at("2026-11-10", "07:11") },
      { ...base, outAt: null },
      { ...base, outAt: null, now: at("2026-11-10", "22:00") },
      { ...base, inAt: null, outAt: null },
      { ...base, inAt: null, outAt: null, now: at("2026-11-10", "07:30") },
      {
        ...base,
        startsAt: at("2026-11-10", "19:00"),
        endsAt: at("2026-11-11", "07:00"),
        inAt: at("2026-11-11", "00:30"),
        outAt: at("2026-11-11", "07:45"),
      },
      { ...base, startsAt: null, endsAt: null, inAt: at("2026-11-10", "08:00"), outAt: null },
      { ...base, startsAt: null, endsAt: null, outAt: at("2026-11-10", "16:30") },
      { ...base, setMinutes: 480, setOtMinutes: 15, corrected: true },
      {
        ...base,
        inFlags: ["no_location", "no_selfie", "late"],
        outFlags: ["delayed", "outside"],
        bySupervisor: true,
        shiftRemoved: true,
      },
      { ...base, inFlags: ["time_unverified"], graceMinutes: 0 },
      // Clamped to a 24-hour day (security review M1).
      {
        ...base,
        startsAt: null,
        endsAt: null,
        inAt: at("2026-11-10", "07:00"),
        outAt: at("2026-11-11", "13:00"),
      },
    ];
    const ts = (v: number | null) => (v === null ? null : new Date(v));
    for (const c of cases) {
      const { rows } = await db.query(
        `select * from private.timesheet_line_compute($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          ts(c.startsAt),
          ts(c.endsAt),
          ts(c.inAt),
          ts(c.outAt),
          c.setMinutes,
          c.setOtMinutes,
          c.inFlags,
          c.outFlags,
          c.bySupervisor,
          c.corrected,
          c.shiftRemoved,
          c.graceMinutes,
          c.noShowAfterMinutes,
          new Date(c.now),
        ],
      );
      const js = computeLine(c);
      expect(rows[0], JSON.stringify(c)).toEqual({
        scheduled_minutes: js.scheduledMinutes,
        worked_minutes: js.workedMinutes,
        late_minutes: js.lateMinutes,
        early_minutes: js.earlyMinutes,
        ot_minutes: js.otMinutes,
        exceptions: js.exceptions,
        needs_review: js.needsReview,
      });
    }
  });

  it("pay periods", async () => {
    for (const [date, startDay] of [
      ["2026-11-19", 20],
      ["2026-11-20", 20],
      ["2026-01-05", 20],
      ["2026-03-01", 1],
      ["2026-03-27", 28],
    ] as const) {
      const { rows } = await db.query<{ s: string }>(
        "select private.timesheet_period_start($1::date, $2)::text as s",
        [date, startDay],
      );
      expect(rows[0]!.s, date).toBe(periodStart(date, startDay));
    }
  });
});
