/**
 * Slice 4.3: timesheet approval and Work Units, against the real database.
 * - The accept line: approving a day on a manned-post shift makes one billable Work Unit with the
 *   day's minutes; reopening cancels it; approving again makes a new one (one approved unit per
 *   line). Billable follows the contract type. No-shift and 0-minute days make none.
 * - Approvers (owner decision 6): the worker's line manager, ops_manager, admin or owner; never
 *   their own day; hr, finance and other companies are refused. Reopen: ops_manager, admin,
 *   owner. A running shift can't be approved.
 * - Approve N clean: only clean days (informational exceptions only); the rest refused by name;
 *   the dry run writes nothing; a line manager gets "not found" with no name for others' days.
 * - Decisions and Work Units are insert-only for every role, the secret key and the database
 *   owner included (Work Units move approved to cancelled once, by a reopen or dispute).
 * - Must-do 1: a reopened day whose shift no longer counts survives the refresh.
 * - Must-do 3 and 6: a punch that arrives after the decision flags its line at once, keyed on the
 *   punch's line whatever its date, for shift and no-shift lines; the cron's 7-day scan catches
 *   one the trigger missed; Reopen counts it; its selfie is kept at most 180 days.
 * - Must-do 7: the cron's result carries failed_codes.
 * - Dispute from the worker, the correction preview, and SQL against the TypeScript mirrors.
 *
 * Contracts, posts, shifts and assignments are seeded as the database owner with triggers off
 * for the transaction only (session_replication_role = replica), so their times can sit anywhere
 * in the past; punches are inserted as the database owner with triggers on (the late-punch
 * trigger), unless a test says otherwise.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { isCleanLine, workUnitBillable, type CleanInput } from "@/lib/timesheets/approval";
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
type ContractType = "manned_post" | "per_visit" | "fixed_monthly" | "per_job";

const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const DAY = addDays(lagosToday(), -3);
const OLD_DAY = addDays(lagosToday(), -20);
const at = (day: string, time: string) => Date.parse(`${day}T${time}:00+01:00`);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager" | "worker", TestUser>;
let lmMembershipId: string;
let site: string;
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
      staff_id: `TA-${String(counter).padStart(4, "0")}`,
      first_name: "Amaka",
      last_name: `Udo ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** A contract of `type`, a post on it, a shift and an assignment, triggers off. */
async function rostered(
  workerId: string,
  day: string,
  startsAt: number,
  endsAt: number,
  options: { orgId?: string; siteId?: string; type?: ContractType; unit?: string } = {},
): Promise<{ assignment: string; contract: string; post: string; shift: string }> {
  const orgId = options.orgId ?? owner.orgId;
  const siteId = options.siteId ?? site;
  const [contract, post, shift, assignment] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.contracts (id, organisation_id, client_id, reference, name, type, start_date, vat_applies, status)
       values ($1, $2, $3, $4, 'Guarding', $5, '2025-01-01', false, 'active')`,
      [contract, orgId, randomUUID(), `TA-${contract.slice(0, 8)}`, options.type ?? "manned_post"],
    );
    await db.query(
      `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
       values ($1, $2, $3, $4, $5, 'Guard', 'Day', $6, $7)`,
      [
        post,
        orgId,
        contract,
        siteId,
        `Gate ${post.slice(0, 6)} · Day`,
        options.unit ?? "shift",
        day,
      ],
    );
    await db.query(
      `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [shift, orgId, post, contract, siteId, day, new Date(startsAt), new Date(endsAt)],
    );
    await db.query(
      `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'assigned')`,
      [assignment, orgId, shift, siteId, day, workerId, new Date(startsAt), new Date(endsAt)],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  return { assignment, contract, post, shift };
}

async function punch(
  workerId: string,
  assignmentId: string | null,
  kind: "in" | "out",
  when: number,
  options: {
    flags?: string[];
    orgId?: string;
    source?: "self" | "supervisor";
    receivedAt?: number;
    triggersOff?: boolean;
  } = {},
): Promise<string> {
  const id = randomUUID();
  // A supervisor punch names its crew batch (slice 3.6); the batch's foreign key is off with
  // triggers, so supervisor punches are always seeded with triggers off.
  const supervisor = options.source === "supervisor";
  if (options.triggersOff || supervisor) {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
  }
  try {
    await db.query(
      `insert into public.punches (id, organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
         shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
         clock_drift_seconds, geofence_result, flags, payload_hash, crew_batch_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, 'elapsed', 0, 'inside', $12,
         md5(gen_random_uuid()::text), $13, $11)`,
      [
        id,
        options.orgId ?? owner.orgId,
        workerId,
        kind,
        options.source ?? "self",
        randomUUID(),
        randomUUID(),
        assignmentId,
        site,
        new Date(when),
        new Date(options.receivedAt ?? when),
        options.flags ?? [],
        supervisor ? randomUUID() : null,
      ],
    );
    if (options.triggersOff || supervisor) await db.query("commit");
  } catch (error) {
    if (options.triggersOff || supervisor) await db.query("rollback");
    throw error;
  }
  return id;
}

async function refresh(client: Client, from = DAY, to = DAY, orgId = owner.orgId) {
  const res = await client.rpc("refresh_timesheet_lines", {
    p_organisation_id: orgId,
    p_from: from,
    p_to: to,
  });
  expect(res.error).toBeNull();
}

interface LineRow {
  id: string;
  status: string;
  worked_minutes: number;
  ot_minutes: number;
  exceptions: string[];
  work_unit_id: string | null;
  decided_at: Date | null;
}

async function lineFor(assignmentId: string): Promise<LineRow> {
  const { rows } = await db.query<LineRow>(
    "select id, status, worked_minutes, ot_minutes, exceptions, work_unit_id, decided_at from public.timesheet_lines where shift_assignment_id = $1",
    [assignmentId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function lineById(id: string): Promise<LineRow> {
  const { rows } = await db.query<LineRow>(
    "select id, status, worked_minutes, ot_minutes, exceptions, work_unit_id, decided_at from public.timesheet_lines where id = $1",
    [id],
  );
  return rows[0]!;
}

async function units(lineId: string) {
  const { rows } = await db.query<{
    id: string;
    status: string;
    billable: boolean;
    quantity_minutes: number;
    ot_minutes: number;
    contract_type: string;
    unit: string;
    cancelled_by_decision_id: string | null;
  }>(
    "select id, status, billable, quantity_minutes, ot_minutes, contract_type, unit, cancelled_by_decision_id from public.work_units where timesheet_line_id = $1 order by created_at",
    [lineId],
  );
  return rows;
}

const approve = (client: Client, lineId: string, orgId = owner.orgId) =>
  client.rpc("approve_timesheet_line", { p_organisation_id: orgId, p_line_id: lineId });
const reject = (client: Client, lineId: string, reason = "Not on site per gate book") =>
  client.rpc("reject_timesheet_line", {
    p_organisation_id: owner.orgId,
    p_line_id: lineId,
    p_reason: reason,
  });
const reopen = (client: Client, lineId: string, reason = "Late clock-out arrived") =>
  client.rpc("reopen_timesheet_line", {
    p_organisation_id: owner.orgId,
    p_line_id: lineId,
    p_reason: reason,
  });

/** A finished 07:00 to 19:00 day, clocked 07:00 to 19:00 (clean), on `day`. */
async function cleanDay(
  options: { type?: ContractType; day?: string; worker?: string; flags?: string[] } = {},
) {
  const day = options.day ?? DAY;
  const worker = options.worker ?? (await addWorker());
  const r = await rostered(worker, day, at(day, "07:00"), at(day, "19:00"), {
    type: options.type,
  });
  await punch(worker, r.assignment, "in", at(day, "07:00"), { flags: options.flags });
  await punch(worker, r.assignment, "out", at(day, "19:00"));
  await refresh(owner.client, day, day);
  return { worker, ...r, line: await lineFor(r.assignment) };
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ta-owner", "Approval Org");
  other = await createTenantUser("ta-other", "Other Approval Org");
  staff.admin = await createTestUser("ta-admin");
  staff.hr = await createTestUser("ta-hr");
  staff.finance = await createTestUser("ta-finance");
  staff.ops = await createTestUser("ta-ops");
  staff.lineManager = await createTestUser("ta-lm");
  staff.worker = await createTestUser("ta-worker");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  lmMembershipId = await addMember(staff.lineManager, "line_manager");
  site = await addSite(owner.orgId, "Apapa Warehouse 3");
});

afterAll(async () => {
  await db?.end();
});

describe("the accept line", () => {
  it("approving a manned-post day makes one billable Work Unit with its minutes; reopening cancels it", async () => {
    const worker = await addWorker();
    const r = await rostered(worker, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await punch(worker, r.assignment, "in", at(DAY, "07:08"));
    await punch(worker, r.assignment, "out", at(DAY, "19:20"));
    await refresh(owner.client);
    const line = await lineFor(r.assignment);

    const res = await approve(staff.ops.client, line.id);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ billable: true, worked_minutes: 720, ot_minutes: 20 });
    const [unit, ...rest] = await units(line.id);
    expect(rest).toHaveLength(0);
    expect(unit).toMatchObject({
      status: "approved",
      billable: true,
      quantity_minutes: 720,
      ot_minutes: 20,
      contract_type: "manned_post",
      unit: "shift",
    });
    const approved = await lineById(line.id);
    expect(approved).toMatchObject({ status: "approved", work_unit_id: unit!.id });
    expect(approved.decided_at).not.toBeNull();

    // Reopen: the unit is cancelled naming the reopen decision; the line is pending again.
    const back = await reopen(staff.ops.client, line.id);
    expect(back.error).toBeNull();
    expect(back.data).toMatchObject({ cancelled_work_unit_id: unit!.id });
    const after = await units(line.id);
    expect(after[0]).toMatchObject({ status: "cancelled" });
    const { rows: dec } = await db.query(
      "select decision from public.timesheet_decisions where id = $1",
      [after[0]!.cancelled_by_decision_id],
    );
    expect(dec[0]).toMatchObject({ decision: "reopened" });
    expect(await lineById(line.id)).toMatchObject({ status: "pending", work_unit_id: null });

    // A new approval makes a new unit; still one approved unit per line.
    expect((await approve(staff.ops.client, line.id)).error).toBeNull();
    const again = await units(line.id);
    expect(again).toHaveLength(2);
    expect(again.filter((u) => u.status === "approved")).toHaveLength(1);
    const { rows: decisions } = await db.query<{ decision: string }>(
      "select decision from public.timesheet_decisions where line_id = $1 order by seq",
      [line.id],
    );
    expect(decisions.map((d) => d.decision)).toEqual(["approved", "reopened", "approved"]);
  });

  it("billable follows the contract type", async () => {
    for (const [type, billable] of [
      ["manned_post", true],
      ["per_visit", true],
      ["fixed_monthly", false],
      ["per_job", false],
    ] as const) {
      const d = await cleanDay({ type });
      expect((await approve(owner.client, d.line.id)).error).toBeNull();
      const [unit] = await units(d.line.id);
      expect(unit, type).toMatchObject({ billable, contract_type: type });
      // The SQL rule and its TypeScript mirror agree.
      const { rows } = await db.query<{ b: boolean }>(
        "select private.work_unit_billable($1) as b",
        [type],
      );
      expect(rows[0]!.b).toBe(workUnitBillable(type));
    }
  });

  it("a no-shift day and a 0-minute day make no Work Unit", async () => {
    const worker = await addWorker();
    const inId = await punch(worker, null, "in", at(DAY, "08:00"), { flags: ["no_shift"] });
    await punch(worker, null, "out", at(DAY, "16:00"), { flags: ["no_shift"] });
    await refresh(owner.client);
    const { rows } = await db.query<{ id: string }>(
      "select id from public.timesheet_lines where no_shift_punch_id = $1",
      [inId],
    );
    expect((await approve(owner.client, rows[0]!.id)).error).toBeNull();
    expect(await units(rows[0]!.id)).toHaveLength(0);

    const noShowWorker = await addWorker();
    const r = await rostered(noShowWorker, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await refresh(owner.client);
    const noShow = await lineFor(r.assignment);
    expect(noShow.exceptions).toContain("no_show");
    expect((await approve(owner.client, noShow.id)).error).toBeNull();
    expect(await units(noShow.id)).toHaveLength(0);
  });
});

describe("who decides", () => {
  it("the line manager decides a reportee's day, not anyone else's", async () => {
    const reportee = await addWorker(owner.orgId, { line_manager_membership_id: lmMembershipId });
    const mine = await cleanDay({ worker: reportee });
    const theirs = await cleanDay();
    expect((await approve(staff.lineManager.client, theirs.line.id)).error?.code).toBe("42501");
    expect((await approve(staff.lineManager.client, mine.line.id)).error).toBeNull();
    // A line manager can't reopen.
    expect((await reopen(staff.lineManager.client, mine.line.id)).error?.code).toBe("42501");
  });

  it("nobody decides their own day, an ops_manager linked to their worker record included", async () => {
    const opsSelf = await createTestUser("ta-ops-self");
    const selfWorker = await addWorker();
    await addMember(opsSelf, "ops_manager", owner.orgId, selfWorker);
    const d = await cleanDay({ worker: selfWorker });
    expect((await approve(opsSelf.client, d.line.id)).error?.code).toBe("MLTA1");
    expect((await reject(opsSelf.client, d.line.id)).error?.code).toBe("MLTA1");
    expect((await approve(staff.admin.client, d.line.id)).error).toBeNull();
    expect((await reopen(opsSelf.client, d.line.id)).error?.code).toBe("MLTA1");
  });

  it("hr, finance, a worker and another company are refused", async () => {
    const d = await cleanDay();
    expect((await approve(staff.hr.client, d.line.id)).error?.code).toBe("42501");
    expect((await approve(staff.finance.client, d.line.id)).error?.code).toBe("42501");
    expect((await approve(other.client, d.line.id, other.orgId)).error?.code).toBe("P0002");
    expect((await approve(other.client, d.line.id)).error?.code).toBe("42501");
    const w = await addWorker();
    const login = await createTestUser("ta-worker-x");
    await addMember(login, "worker", owner.orgId, w);
    expect((await approve(login.client, d.line.id)).error?.code).toBe("42501");
  });

  it("reject needs a plain-text reason; a decided day can't be decided again", async () => {
    const d = await cleanDay();
    expect((await reject(staff.ops.client, d.line.id, "")).error?.code).toBe("MLTA4");
    expect((await reject(staff.ops.client, d.line.id, "See www.example.com")).error?.code).toBe(
      "MLTA4",
    );
    expect((await reject(staff.ops.client, d.line.id)).error).toBeNull();
    expect(await lineById(d.line.id)).toMatchObject({ status: "rejected", work_unit_id: null });
    expect((await approve(staff.ops.client, d.line.id)).error?.code).toBe("MLTA2");
    expect((await reject(staff.ops.client, d.line.id)).error?.code).toBe("MLTA2");
  });

  it("a shift still running can't be approved", async () => {
    const worker = await addWorker();
    const now = Date.now();
    const r = await rostered(worker, lagosToday(), now - 3_600_000, now + 3_600_000);
    await punch(worker, r.assignment, "in", now - 3_600_000);
    await refresh(owner.client, lagosToday(), lagosToday());
    const line = await lineFor(r.assignment);
    expect((await approve(staff.ops.client, line.id)).error?.code).toBe("MLTA3");
  });
});

describe("approve N clean", () => {
  it("approves clean days only and refuses the rest by name; the dry run writes nothing", async () => {
    const clean = await cleanDay();
    const supervisor = await addWorker();
    const sr = await rostered(supervisor, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await punch(supervisor, sr.assignment, "in", at(DAY, "07:00"), {
      source: "supervisor",
      flags: ["no_location", "no_selfie"],
    });
    await punch(supervisor, sr.assignment, "out", at(DAY, "19:00"), { source: "supervisor" });
    await refresh(owner.client);
    const crew = await lineFor(sr.assignment);
    expect(crew.exceptions).toEqual(
      expect.arrayContaining(["no_location", "no_selfie", "supervisor"]),
    );
    // Own-phone no_selfie is not informational.
    const selfie = await cleanDay({ flags: ["no_selfie"] });
    const review = await cleanDay({ flags: ["delayed"] });
    const late = await addWorker();
    const lr = await rostered(late, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await punch(late, lr.assignment, "in", at(DAY, "07:40"));
    await punch(late, lr.assignment, "out", at(DAY, "19:00"));
    await refresh(owner.client);
    const lateLine = await lineFor(lr.assignment);
    const ids = [clean.line.id, crew.id, selfie.line.id, review.line.id, lateLine.id, randomUUID()];

    const decisionsBefore = await db.query(
      "select count(*)::int as n from public.timesheet_decisions",
    );
    const dry = await owner.client.rpc("approve_clean_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_line_ids: ids,
      p_dry_run: true,
    });
    expect(dry.error).toBeNull();
    const preview = dry.data as {
      approved: { line_id: string }[];
      refused: { line_id: string; code: string; worker_name?: string }[];
    };
    expect(preview.approved.map((a) => a.line_id).sort()).toEqual([clean.line.id, crew.id].sort());
    const codes = Object.fromEntries(preview.refused.map((x) => [x.line_id, x]));
    expect(codes[selfie.line.id]).toMatchObject({ code: "flagged" });
    expect(codes[selfie.line.id]!.worker_name).toMatch(/^Amaka Udo/);
    expect(codes[review.line.id]).toMatchObject({ code: "needs_review" });
    expect(codes[lateLine.id]).toMatchObject({ code: "flagged" });
    expect(preview.refused.find((x) => x.code === "not_found")?.worker_name).toBeUndefined();
    const decisionsAfter = await db.query(
      "select count(*)::int as n from public.timesheet_decisions",
    );
    expect(decisionsAfter.rows[0].n).toBe(decisionsBefore.rows[0].n);
    expect((await lineById(clean.line.id)).status).toBe("pending");

    const real = await owner.client.rpc("approve_clean_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_line_ids: ids,
    });
    expect(real.error).toBeNull();
    expect((await lineById(clean.line.id)).status).toBe("approved");
    expect((await lineById(crew.id)).status).toBe("approved");
    expect((await lineById(selfie.line.id)).status).toBe("pending");
    expect(await units(clean.line.id)).toHaveLength(1);
  });

  it("a line manager gets not_found, with no name, for a day that isn't their reportee's", async () => {
    const d = await cleanDay();
    const res = await staff.lineManager.client.rpc("approve_clean_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_line_ids: [d.line.id],
    });
    expect(res.error).toBeNull();
    const out = res.data as { approved: unknown[]; refused: Record<string, unknown>[] };
    expect(out.approved).toHaveLength(0);
    expect(out.refused[0]).toEqual({ line_id: d.line.id, code: "not_found" });
  });

  it("refuses hr and more than 500 days", async () => {
    const res = await staff.hr.client.rpc("approve_clean_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_line_ids: [randomUUID()],
    });
    expect(res.error?.code).toBe("42501");
    const many = await owner.client.rpc("approve_clean_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_line_ids: Array.from({ length: 501 }, () => randomUUID()),
    });
    expect(many.error?.code).toBe("22023");
  });

  it("the SQL clean rule agrees with src/lib/timesheets/approval.ts", async () => {
    const cases: CleanInput[] = [
      { status: "pending", exceptions: [], needsReview: false, inPunch: null, outPunch: null },
      { status: "approved", exceptions: [], needsReview: false, inPunch: null, outPunch: null },
      { status: "pending", exceptions: [], needsReview: true, inPunch: null, outPunch: null },
      {
        status: "pending",
        exceptions: ["no_selfie", "supervisor"],
        needsReview: false,
        inPunch: { source: "supervisor", flags: ["no_selfie"] },
        outPunch: { source: "self", flags: [] },
      },
      {
        status: "pending",
        exceptions: ["no_selfie", "supervisor"],
        needsReview: false,
        inPunch: { source: "self", flags: ["no_selfie"] },
        outPunch: { source: "supervisor", flags: [] },
      },
      {
        status: "pending",
        exceptions: ["no_location"],
        needsReview: false,
        inPunch: { source: "self", flags: ["no_location"] },
        outPunch: null,
      },
      {
        status: "pending",
        exceptions: ["corrected"],
        needsReview: false,
        inPunch: null,
        outPunch: null,
      },
      {
        status: "pending",
        exceptions: ["supervisor"],
        needsReview: false,
        inPunch: null,
        outPunch: null,
      },
    ];
    for (const c of cases) {
      const { rows } = await db.query<{ clean: boolean }>(
        "select private.timesheet_line_is_clean($1, $2, $3, $4, $5, $6, $7) as clean",
        [
          c.status,
          c.exceptions,
          c.needsReview,
          c.inPunch?.source ?? null,
          c.inPunch?.flags ?? null,
          c.outPunch?.source ?? null,
          c.outPunch?.flags ?? null,
        ],
      );
      expect(rows[0]!.clean, JSON.stringify(c)).toBe(isCleanLine(c));
    }
  });
});

describe("insert-only records", () => {
  it("decisions and Work Units can't be edited or deleted by anyone", async () => {
    const d = await cleanDay();
    expect((await approve(owner.client, d.line.id)).error).toBeNull();
    const [unit] = await units(d.line.id);
    const { rows } = await db.query<{ id: string }>(
      "select id from public.timesheet_decisions where line_id = $1",
      [d.line.id],
    );
    const decision = rows[0]!.id;

    // The database owner.
    await expect(
      db.query("update public.timesheet_decisions set reason = 'x' where id = $1", [decision]),
    ).rejects.toMatchObject({ code: "MLTA0" });
    await expect(
      db.query("delete from public.timesheet_decisions where id = $1", [decision]),
    ).rejects.toMatchObject({ code: "MLTA0" });
    await expect(
      db.query("update public.work_units set quantity_minutes = 1 where id = $1", [unit!.id]),
    ).rejects.toMatchObject({ code: "MLTA0" });
    await expect(
      db.query("delete from public.work_units where id = $1", [unit!.id]),
    ).rejects.toMatchObject({ code: "MLTA0" });
    // Cancelling naming the approval (not a reopen) is refused.
    await expect(
      db.query(
        "update public.work_units set status = 'cancelled', cancelled_by_decision_id = $2 where id = $1",
        [unit!.id, decision],
      ),
    ).rejects.toMatchObject({ code: "MLTA0" });
    await expect(db.query("truncate public.timesheet_decisions cascade")).rejects.toBeTruthy();
    await expect(db.query("truncate public.work_units cascade")).rejects.toBeTruthy();

    // The secret key and signed-in roles have no write grants.
    for (const client of [admin, owner.client]) {
      const u = await client.from("work_units").update({ quantity_minutes: 1 }).eq("id", unit!.id);
      expect(u.error?.code).toBe("42501");
      const x = await client.from("timesheet_decisions").delete().eq("id", decision);
      expect(x.error?.code).toBe("42501");
      const i = await client.from("timesheet_decisions").insert({
        organisation_id: owner.orgId,
        line_id: d.line.id,
        worker_id: d.worker,
        decision: "approved",
        scheduled_minutes: 0,
        worked_minutes: 0,
        late_minutes: 0,
        early_minutes: 0,
        ot_minutes: 0,
      });
      expect(i.error?.code).toBe("42501");
    }
    // A decided line can't be edited directly either.
    await expect(
      db.query("update public.timesheet_lines set worked_minutes = 1 where id = $1", [d.line.id]),
    ).rejects.toMatchObject({ code: "MLTS0" });
  });

  it("Work Units are read by owner, admin, finance and ops_manager only", async () => {
    const reportee = await addWorker(owner.orgId, { line_manager_membership_id: lmMembershipId });
    const d = await cleanDay({ worker: reportee });
    expect((await approve(owner.client, d.line.id)).error).toBeNull();
    for (const [client, n] of [
      [owner.client, 1],
      [staff.admin.client, 1],
      [staff.finance.client, 1],
      [staff.ops.client, 1],
      [staff.hr.client, 0],
      [staff.lineManager.client, 0],
      [other.client, 0],
    ] as const) {
      const { data } = await client
        .from("work_units")
        .select("id")
        .eq("timesheet_line_id", d.line.id);
      expect(data ?? []).toHaveLength(n);
    }
    // The line manager reads their reportee's decisions.
    const { data } = await staff.lineManager.client
      .from("timesheet_decisions")
      .select("id")
      .eq("line_id", d.line.id);
    expect(data).toHaveLength(1);
  });
});

describe("must-do 1: a stale day with decisions survives the refresh", () => {
  it("a reopened no-show whose shift was removed stays, and the refresh doesn't fail", async () => {
    const worker = await addWorker();
    const r = await rostered(worker, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await refresh(owner.client);
    const line = await lineFor(r.assignment);
    expect((await approve(owner.client, line.id)).error).toBeNull();
    expect((await reopen(owner.client, line.id)).error).toBeNull();
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(
      "update public.shift_assignments set status = 'removed', removed_at = now() where id = $1",
      [r.assignment],
    );
    await db.query("commit");
    await refresh(owner.client);
    expect(await lineById(line.id)).toMatchObject({ status: "pending" });
  });
});

describe("must-do 3 and 6: late punches", () => {
  it("a punch after the decision flags its line at once, whatever its date; Reopen counts it", async () => {
    const worker = await addWorker();
    const r = await rostered(worker, OLD_DAY, at(OLD_DAY, "07:00"), at(OLD_DAY, "19:00"));
    await punch(worker, r.assignment, "in", at(OLD_DAY, "07:00"));
    await refresh(owner.client, OLD_DAY, OLD_DAY);
    const line = await lineFor(r.assignment);
    expect(line.exceptions).toContain("no_clock_out");
    expect((await approve(owner.client, line.id)).error).toBeNull();

    // The clock-out arrives now (sent from an offline phone), 20 days after its day.
    const late = await punch(worker, r.assignment, "out", at(OLD_DAY, "19:00"), {
      receivedAt: Date.now(),
    });
    const flagged = await lineById(line.id);
    expect(flagged.exceptions).toContain("late_punch_after_decision");
    expect(flagged.status).toBe("approved");
    const kept = await db.query<{ k: boolean }>("select private.punch_under_review($1, $2) as k", [
      owner.orgId,
      late,
    ]);
    expect(kept.rows[0]!.k).toBe(true);

    // The review screen shows it with Reopen.
    const { data: review } = await owner.client.rpc("timesheet_review_days", {
      p_organisation_id: owner.orgId,
      p_from: OLD_DAY,
      p_to: OLD_DAY,
    });
    const row = (review ?? []).find((x) => x.line_id === line.id);
    expect(row).toMatchObject({ can_reopen: true });
    expect(row!.exceptions).toContain("late_punch_after_decision");

    // Reopen counts the punch.
    expect((await reopen(owner.client, line.id)).error).toBeNull();
    const counted = await lineById(line.id);
    expect(counted.worked_minutes).toBe(720);
    expect(counted.exceptions).not.toContain("late_punch_after_decision");
  });

  it("covers no-shift lines: a late clock-out that pairs with a decided no-shift clock-in", async () => {
    const worker = await addWorker();
    const inId = await punch(worker, null, "in", at(DAY, "08:00"), { flags: ["no_shift"] });
    await refresh(owner.client);
    const { rows } = await db.query<{ id: string }>(
      "select id from public.timesheet_lines where no_shift_punch_id = $1",
      [inId],
    );
    const lineId = rows[0]!.id;
    expect((await approve(owner.client, lineId)).error).toBeNull();
    await punch(worker, null, "out", at(DAY, "16:00"), {
      flags: ["no_shift"],
      receivedAt: Date.now(),
    });
    expect((await lineById(lineId)).exceptions).toContain("late_punch_after_decision");
  });

  it("the cron's 7-day scan flags a late punch the trigger missed", async () => {
    const worker = await addWorker();
    const r = await rostered(worker, OLD_DAY, at(OLD_DAY, "07:00"), at(OLD_DAY, "19:00"));
    await punch(worker, r.assignment, "in", at(OLD_DAY, "07:00"));
    await punch(worker, r.assignment, "out", at(OLD_DAY, "19:00"));
    await refresh(owner.client, OLD_DAY, OLD_DAY);
    const line = await lineFor(r.assignment);
    expect((await approve(owner.client, line.id)).error).toBeNull();
    await punch(worker, r.assignment, "out", at(OLD_DAY, "19:30"), {
      receivedAt: Date.now(),
      triggersOff: true,
    });
    expect((await lineById(line.id)).exceptions).not.toContain("late_punch_after_decision");
    const cron = await admin.rpc("refresh_timesheets_recent", { p_organisation_id: owner.orgId });
    expect(cron.error).toBeNull();
    expect(cron.data).toMatchObject({ failed: 0, failed_codes: [] });
    expect((await lineById(line.id)).exceptions).toContain("late_punch_after_decision");
  });

  it("a late punch's selfie is kept at most 180 days from when it arrived", async () => {
    const worker = await addWorker();
    const r = await rostered(worker, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await punch(worker, r.assignment, "in", at(DAY, "07:00"));
    await punch(worker, r.assignment, "out", at(DAY, "19:00"));
    await refresh(owner.client);
    const line = await lineFor(r.assignment);
    expect((await approve(owner.client, line.id)).error).toBeNull();
    const day = 86_400_000;
    // Decided 300 days ago (moved back with triggers off); one punch arrived 100 days ago, one 200.
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(
      "update public.timesheet_lines set decided_at = now() - interval '300 days' where id = $1",
      [line.id],
    );
    await db.query("commit");
    // Sent (and recorded) 100 and 200 days ago: past the 90-day age rule either way.
    const recent = await punch(worker, r.assignment, "out", Date.now() - 100 * day, {
      triggersOff: true,
    });
    const old = await punch(worker, r.assignment, "out", Date.now() - 200 * day, {
      triggersOff: true,
    });
    const check = async (id: string) =>
      (
        await db.query<{ k: boolean }>("select private.punch_under_review($1, $2) as k", [
          owner.orgId,
          id,
        ])
      ).rows[0]!.k;
    expect(await check(recent)).toBe(true);
    expect(await check(old)).toBe(false);
  });
});

describe("disputes from the worker", () => {
  it("the worker disputes their own day; an approved day's Work Unit is cancelled; 3 at most", async () => {
    const w = await addWorker();
    await addMember(staff.worker, "worker", owner.orgId, w);
    const d = await cleanDay({ worker: w });
    const dispute = (lineId: string, reason = "I clocked out at 19:30") =>
      staff.worker.client.rpc("dispute_timesheet_line", { p_line_id: lineId, p_reason: reason });

    expect((await dispute(d.line.id, "")).error?.code).toBe("MLTA4");
    expect((await approve(owner.client, d.line.id)).error).toBeNull();
    const [unit] = await units(d.line.id);
    expect((await dispute(d.line.id)).error).toBeNull();
    expect(await lineById(d.line.id)).toMatchObject({ status: "disputed", work_unit_id: null });
    expect((await units(d.line.id))[0]).toMatchObject({ id: unit!.id, status: "cancelled" });
    // Disputed again before a decision: refused.
    expect((await dispute(d.line.id)).error?.code).toBe("MLTA2");
    // Approve and dispute until the cap.
    expect((await approve(owner.client, d.line.id)).error).toBeNull();
    expect((await dispute(d.line.id)).error).toBeNull();
    expect((await approve(owner.client, d.line.id)).error).toBeNull();
    expect((await dispute(d.line.id)).error).toBeNull();
    expect((await approve(owner.client, d.line.id)).error).toBeNull();
    expect((await dispute(d.line.id)).error?.code).toBe("MLTA6");

    // Someone else's day is not found.
    const others = await cleanDay();
    expect((await dispute(others.line.id)).error?.code).toBe("P0002");

    // The worker reads their own days, with Dispute closed after 3.
    const { data } = await staff.worker.client.rpc("my_timesheet_days", {
      p_organisation_id: owner.orgId,
      p_from: DAY,
      p_to: DAY,
    });
    expect((data ?? []).map((x) => x.line_id)).toEqual([d.line.id]);
    expect(data![0]).toMatchObject({ status: "approved", can_dispute: false });
  });
});

describe("the correction preview", () => {
  it("shows the minutes now and after, and saves nothing", async () => {
    const worker = await addWorker();
    const r = await rostered(worker, DAY, at(DAY, "07:00"), at(DAY, "19:00"));
    await punch(worker, r.assignment, "in", at(DAY, "07:00"));
    await refresh(owner.client);
    const line = await lineFor(r.assignment);
    const before = await db.query("select count(*)::int as n from public.timesheet_corrections");
    const res = await staff.ops.client.rpc("preview_timesheet_correction", {
      p_organisation_id: owner.orgId,
      p_line_id: line.id,
      p_kind: "set_clock_out",
      p_reason: "Gate book shows 19:00",
      p_corrected_at: new Date(at(DAY, "19:00")).toISOString(),
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      current: { worked_minutes: 0, exceptions: ["no_clock_out"] },
      next: { worked_minutes: 720, exceptions: ["corrected"] },
    });
    const after = await db.query("select count(*)::int as n from public.timesheet_corrections");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await lineById(line.id)).worked_minutes).toBe(0);
    // The same checks as the correction: hr is refused.
    const hr = await staff.hr.client.rpc("preview_timesheet_correction", {
      p_organisation_id: owner.orgId,
      p_line_id: line.id,
      p_kind: "set_minutes",
      p_reason: "Check",
      p_minutes: 600,
    });
    expect(hr.error?.code).toBe("42501");
  });
});

describe("the review read", () => {
  it("owner reads every day; a line manager only reportees'; finance is refused", async () => {
    const reportee = await addWorker(owner.orgId, { line_manager_membership_id: lmMembershipId });
    const mine = await cleanDay({ worker: reportee });
    const theirs = await cleanDay();
    const read = (client: Client) =>
      client.rpc("timesheet_review_days", {
        p_organisation_id: owner.orgId,
        p_from: DAY,
        p_to: DAY,
      });
    const all = await read(owner.client);
    const ids = (all.data ?? []).map((x) => x.line_id);
    expect(ids).toEqual(expect.arrayContaining([mine.line.id, theirs.line.id]));
    const lm = await read(staff.lineManager.client);
    const lmIds = (lm.data ?? []).map((x) => x.line_id);
    expect(lmIds).toContain(mine.line.id);
    expect(lmIds).not.toContain(theirs.line.id);
    expect((lm.data ?? []).find((x) => x.line_id === mine.line.id)).toMatchObject({
      can_decide: true,
      can_reopen: false,
      clean: true,
    });
    const hr = await read(staff.hr.client);
    expect((hr.data ?? []).find((x) => x.line_id === mine.line.id)).toMatchObject({
      can_decide: false,
    });
    expect((await read(staff.finance.client)).error?.code).toBe("42501");
    expect((await read(other.client)).error?.code).toBe("42501");
  });
});
