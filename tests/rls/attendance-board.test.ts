/**
 * Slice 3.7: public.attendance_board against the real database.
 * - Statuses worked out on read: late, no-show, on site (arrived late, with its flags), starting
 *   within 2 hours, clocked out; shifts more than 2 hours away and removed assignments are left
 *   out; the latest publication marks a row published; each site's last sync.
 * - Role gating: owner, admin, hr and ops_manager see every row; a line manager only their
 *   reportees (their crews' sites); finance, another company, an untrusted password session and
 *   anon get nothing.
 * - Phones: returned in full to the roles that read them on the people record.
 * - The SQL status rule agrees with src/lib/attendance-board.ts at the boundaries.
 *
 * Shifts, assignments and punches are seeded as the database owner with triggers off for the
 * transaction only (session_replication_role = replica), so their times can sit anywhere around
 * now; the roster and punch rules have their own suites.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attendanceStatus } from "@/lib/attendance-board";
import { lagosToday } from "@/lib/dates";
import { mondayOf } from "@/lib/roster";
import type { Database } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  markPasswordTrusted,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];
type BoardRow = Database["public"]["Functions"]["attendance_board"]["Returns"][number];

const MIN = 60_000;
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager", TestUser>;
let lmMembershipId: string;
let apapa: string;
let lekki: string;
let otherSite: string;
let counter = 0;
const W = {} as Record<
  "late" | "noShow" | "onSite" | "starting" | "out" | "later" | "removed" | "crew" | "other",
  string
>;
const A = {} as Record<keyof typeof W, string>;

async function addMember(user: TestUser, role: Role, orgId = owner.orgId): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role })
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
  const site = await admin
    .from("sites")
    .insert({ organisation_id: orgId, client_id: clientId!, name, centre: CENTRE } as never)
    .select("id")
    .single();
  expect(site.error).toBeNull();
  return site.data!.id;
}

async function addWorker(
  name: string,
  orgId = owner.orgId,
  extra: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
): Promise<string> {
  counter += 1;
  const [first, last] = name.split(" ");
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `AB-${String(counter).padStart(4, "0")}`,
      first_name: first!,
      last_name: last!,
      phone: `0803123${String(4400 + counter).padStart(4, "0")}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** A post, a shift and an assignment from `startsAt` to `endsAt`, triggers off. */
async function rostered(
  orgId: string,
  siteId: string,
  workerId: string,
  startsAt: number,
  endsAt: number,
  status: "assigned" | "removed" = "assigned",
): Promise<string> {
  const day = lagosToday(new Date(startsAt));
  const post = randomUUID();
  const shift = randomUUID();
  const assignment = randomUUID();
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.posts (id, organisation_id, contract_id, site_id, name, role, band, unit, opened_on)
       values ($1, $2, $3, $4, $5, 'Guard', 'Day', 'shift', $6)`,
      [post, orgId, randomUUID(), siteId, `Gate ${counter} · Day`, day],
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
  orgId: string,
  workerId: string,
  assignmentId: string,
  siteId: string,
  kind: "in" | "out",
  at: number,
  flags: string[] = [],
  receivedAt = at,
) {
  await db.query(
    `insert into public.punches (organisation_id, worker_id, kind, recorded_by_user, client_event_id,
       shift_assignment_id, site_id, device_time, received_at, recorded_at, time_source,
       clock_drift_seconds, geofence_result, flags, payload_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, 'elapsed', 0, $10, $11, md5($5::text))`,
    [
      orgId,
      workerId,
      kind,
      randomUUID(),
      randomUUID(),
      assignmentId,
      siteId,
      new Date(at),
      new Date(receivedAt),
      flags.includes("outside") ? "outside" : "inside",
      flags,
    ],
  );
}

async function board(client: Client, orgId = owner.orgId) {
  return client.rpc("attendance_board", { p_organisation_id: orgId });
}

async function rowsFor(client: Client): Promise<BoardRow[]> {
  const { data, error } = await board(client);
  expect(error).toBeNull();
  return data ?? [];
}

const byAssignment = (rows: BoardRow[]) => new Map(rows.map((r) => [r.assignment_id, r]));

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ab-owner", "Board Org");
  other = await createTenantUser("ab-other", "Other Board Org");
  staff.admin = await createTestUser("ab-admin");
  staff.hr = await createTestUser("ab-hr");
  staff.finance = await createTestUser("ab-finance");
  staff.ops = await createTestUser("ab-ops");
  staff.lineManager = await createTestUser("ab-lm");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  lmMembershipId = await addMember(staff.lineManager, "line_manager");

  apapa = await addSite(owner.orgId, "Apapa Warehouse 3");
  lekki = await addSite(owner.orgId, "Lekki Estate");
  otherSite = await addSite(other.orgId, "Other Gate");

  // Whole seconds, so the minute counts are exact.
  const now = Math.floor(Date.now() / 1000) * 1000;
  W.late = await addWorker("Daniel Okon");
  A.late = await rostered(owner.orgId, apapa, W.late, now - 20 * MIN - 30_000, now + 8 * 60 * MIN);
  W.noShow = await addWorker("Sule Musa");
  A.noShow = await rostered(owner.orgId, apapa, W.noShow, now - 90 * MIN, now + 6 * 60 * MIN);
  W.onSite = await addWorker("Ngozi Eze");
  A.onSite = await rostered(owner.orgId, apapa, W.onSite, now - 120 * MIN, now + 6 * 60 * MIN);
  await punch(owner.orgId, W.onSite, A.onSite, apapa, "in", now - 105 * MIN, ["outside", "late"]);
  W.starting = await addWorker("Yusuf Bello");
  A.starting = await rostered(owner.orgId, apapa, W.starting, now + 60 * MIN, now + 13 * 60 * MIN);
  W.out = await addWorker("Ibrahim Sani");
  A.out = await rostered(owner.orgId, apapa, W.out, now - 12 * 60 * MIN - MIN, now - MIN);
  await punch(owner.orgId, W.out, A.out, apapa, "in", now - 12 * 60 * MIN);
  await punch(owner.orgId, W.out, A.out, apapa, "out", now - 2 * MIN, ["late_sync"], now - MIN);
  W.later = await addWorker("Ifeoma Okafor");
  A.later = await rostered(owner.orgId, apapa, W.later, now + 3 * 60 * MIN, now + 11 * 60 * MIN);
  W.removed = await addWorker("Rita Ojo");
  A.removed = await rostered(
    owner.orgId,
    apapa,
    W.removed,
    now - 30 * MIN,
    now + 60 * MIN,
    "removed",
  );
  W.crew = await addWorker("Chidi Obi", owner.orgId, {
    line_manager_membership_id: lmMembershipId,
  });
  A.crew = await rostered(owner.orgId, lekki, W.crew, now - 30 * MIN, now + 7 * 60 * MIN);
  W.other = await addWorker("Ada Obi", other.orgId);
  A.other = await rostered(other.orgId, otherSite, W.other, now - 30 * MIN, now + 60 * MIN);

  // The latest publication of Apapa's week lists the late worker's assignment.
  const day = lagosToday(new Date(now - 20 * MIN - 30_000));
  await db.query("begin");
  await db.query("set local session_replication_role = replica");
  await db.query(
    `insert into public.roster_publications (organisation_id, site_id, week_start, version, snapshot)
     values ($1, $2, $3, 1, $4::jsonb)`,
    [owner.orgId, apapa, mondayOf(day), JSON.stringify([{ a: A.late, w: W.late }])],
  );
  await db.query("commit");
});

afterAll(async () => {
  await db?.end();
});

describe("attendance_board: statuses worked out on read", () => {
  it("classifies every rostered worker on today's board", async () => {
    const rows = byAssignment(await rowsFor(owner.client));
    expect(rows.get(A.late)).toMatchObject({
      status: "late",
      late_minutes: 20,
      worker_name: "Daniel Okon",
      site_name: "Apapa Warehouse 3",
      published: true,
      last_punch_kind: null,
      late_grace_minutes: 10,
      no_show_after_minutes: 60,
      time_zone: "Africa/Lagos",
    });
    expect(rows.get(A.noShow)).toMatchObject({
      status: "no_show",
      late_minutes: 90,
      published: false,
    });
    expect(rows.get(A.onSite)).toMatchObject({
      status: "on_site",
      late_minutes: 15,
      last_punch_kind: "in",
    });
    expect([...rows.get(A.onSite)!.punch_flags].sort()).toEqual(["late", "outside"]);
    expect(rows.get(A.starting)).toMatchObject({ status: "starting", late_minutes: null });
    expect(rows.get(A.out)).toMatchObject({ status: "clocked_out", last_punch_kind: "out" });
    expect(rows.has(A.later)).toBe(false);
    expect(rows.has(A.removed)).toBe(false);
    expect(rows.has(A.other)).toBe(false);
  });

  it("gives each site its last sync and late syncs today", async () => {
    const rows = byAssignment(await rowsFor(owner.client));
    const site = rows.get(A.late)!;
    expect(site.site_last_sync_at).not.toBeNull();
    expect(Date.now() - Date.parse(site.site_last_sync_at)).toBeLessThan(10 * MIN);
    expect(site.site_late_syncs).toBe(1);
    expect(rows.get(A.crew)!.site_last_sync_at).toBeNull();
  });

  it("puts what needs action first", async () => {
    const statuses = (await rowsFor(owner.client)).map((r) => r.status);
    const order = ["no_show", "late", "starting", "on_site", "clocked_out"];
    const ranks = statuses.map((s) => order.indexOf(s));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("attendance_board: who sees what", () => {
  it("shows owner, admin, hr and ops_manager every row, with phones", async () => {
    for (const client of [owner.client, staff.admin.client, staff.hr.client, staff.ops.client]) {
      const rows = byAssignment(await rowsFor(client));
      expect(rows.size).toBe(6);
      expect(rows.get(A.late)!.phone).toMatch(/^0803123\d{4}$/);
      expect(rows.get(A.late)!.phone_last4).toHaveLength(4);
    }
  });

  it("shows a line manager only their reportees, at their crews' sites", async () => {
    const rows = await rowsFor(staff.lineManager.client);
    expect(rows.map((r) => r.assignment_id)).toEqual([A.crew]);
    expect(rows[0]).toMatchObject({ site_id: lekki, status: "late" });
    expect(rows[0]!.phone).toMatch(/^0803123\d{4}$/);
  });

  it("refuses finance, another company and anon", async () => {
    expect((await board(staff.finance.client)).error?.code).toBe("42501");
    expect((await board(other.client)).error?.code).toBe("42501");
    expect((await board(staff.ops.client, other.orgId)).error?.code).toBe("42501");
    expect((await board(anonClient())).error).not.toBeNull();
  });

  it("another company's owner sees only their own board", async () => {
    const own = await board(other.client, other.orgId);
    expect(own.error).toBeNull();
    expect(own.data!.map((r) => r.assignment_id)).toEqual([A.other]);
  });

  it("refuses an untrusted password session until it is trusted", async () => {
    const email = `rls-ab-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    await addMember({ id: created.data.user!.id, email, client }, "ops_manager");
    expect((await board(client)).error?.code).toBe("42501");
    await markPasswordTrusted(created.data.user!.id);
    expect((await board(client)).error).toBeNull();
  });

  it("shows nothing while Shifts is switched off", async () => {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query("update public.organisations set shifts_enabled = false where id = $1", [
        other.orgId,
      ]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
    const off = await board(other.client, other.orgId);
    expect(off.error).toBeNull();
    expect(off.data).toEqual([]);
  });

  it("is not callable as the private definer through the Data API", async () => {
    const { rows } = await db.query(
      `select has_function_privilege('anon', 'public.attendance_board(uuid)', 'execute') as anon_public,
              has_function_privilege('anon', 'private.attendance_board(uuid)', 'execute') as anon_private,
              has_function_privilege('authenticated', 'private.attendance_status(timestamptz, timestamptz, timestamptz, integer, integer, text)', 'execute') as status_fn`,
    );
    expect(rows[0]).toEqual({ anon_public: false, anon_private: false, status_fn: false });
  });
});

describe("attendance_status agrees with src/lib/attendance-board.ts", () => {
  const start = Date.parse("2026-11-21T05:00:00Z");
  const cases: [number, number, number, number, "in" | "out" | null][] = [
    // [now offset min, duration min, grace, no-show, last kind]
    [-120, 720, 10, 60, null],
    [0, 720, 10, 60, null],
    [10, 720, 10, 60, null],
    [10.01, 720, 10, 60, null],
    [60, 720, 10, 60, null],
    [60.01, 720, 10, 60, null],
    [30, 30, 10, 60, null],
    [29, 30, 10, 60, null],
    [30, 720, 30, 30, null],
    [30.01, 720, 30, 30, null],
    [200, 720, 10, 60, "in"],
    [800, 720, 10, 60, "in"],
    [100, 720, 10, 60, "out"],
    [5, 720, 0, 15, null],
  ];

  it("gives the same status for every case, boundaries included", async () => {
    for (const [offset, duration, grace, noShow, kind] of cases) {
      const now = start + offset * MIN;
      const ends = start + duration * MIN;
      const { rows } = await db.query(
        "select private.attendance_status($1, $2, $3, $4, $5, $6) as s",
        [new Date(now), new Date(start), new Date(ends), grace, noShow, kind],
      );
      const ts = attendanceStatus({
        now,
        startsAt: start,
        endsAt: ends,
        lateGraceMinutes: grace,
        noShowAfterMinutes: noShow,
        lastPunchKind: kind,
      });
      expect(rows[0].s, `${offset} min, ${duration}, ${grace}/${noShow}, ${kind}`).toBe(ts);
    }
  });
});
