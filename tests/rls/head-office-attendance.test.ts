/**
 * Slice 6.11: clocking in at Head office and what it leads to, against the real database.
 * - Security review M2: a worker mapped to Head office clocks in inside and outside its geofence
 *   with the existing no-shift clock-in (location consent required); another company's office is
 *   refused (MLPU7); an office with no geofence records the punch and flags it `no_geofence`.
 * - Money review M1: an office clock-in never matches a leftover shift at a client's site, so the
 *   approved day makes no Work Unit; mapping someone to an office takes them off their future
 *   client shifts in the same save.
 * - Money review round 2: a clock-out naming no site pairs with the office clock-in (L4); a
 *   department-only edit of someone already at the office removes no shift (M1-a); the shift
 *   release refuses someone not mapped to an office (L1). Payroll across cycles is in
 *   head-office-payroll.test.ts.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lagosToday } from "@/lib/dates";
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
const CENTRE = { lat: 6.4474, lng: 3.3611 };
const north = (m: number) => ({ lat: CENTRE.lat + m / 111_195, lng: CENTRE.lng });
const HOUR = 60 * 60 * 1000;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let ops: TestUser;
let clientSite: string;
let headOffice: string;
let branch: string;
let theirOffice: string;
let counter = 0;

interface Worker {
  id: string;
  org: string;
  client: Client;
  payRateId: string;
}

async function addMember(user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function officeOf(orgId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "select id::text from public.sites where organisation_id = $1 and kind = 'office'",
    [orgId],
  );
  return rows[0]!.id;
}

/** A monthly worker mapped to `site`, invited, signed in, with the consents given. */
async function addWorker(
  site: string,
  consents: ("location" | "selfie")[] = ["location", "selfie"],
): Promise<Worker> {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `HA-${String(counter).padStart(4, "0")}`,
      first_name: "Funke",
      last_name: `Office ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const workerId = data!.id;
  const rate = await admin
    .from("pay_rates")
    .insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      pay_type: "monthly",
      basic_kobo: 6_000_000,
      housing_kobo: 3_600_000,
      transport_kobo: 2_400_000,
      other_allowances_kobo: 0,
      effective_from: "2025-01-06",
    })
    .select("id")
    .single();
  expect(rate.error).toBeNull();
  const map = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: workerId,
    site_id: site,
    effective_from: "2025-01-06",
  });
  expect(map.error).toBeNull();
  const invite = await hr.client.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [workerId],
    p_sent_via: "print",
  });
  expect(invite.error).toBeNull();
  const email = `w-${workerId}@workers.metalira.invalid`;
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
  for (const kind of consents) {
    const consent = await client.rpc("accept_worker_consent", {
      p_organisation_id: owner.orgId,
      p_kind: kind,
      p_notice_version: "1.0",
    });
    expect(consent.error).toBeNull();
  }
  return { id: workerId, org: owner.orgId, client, payRateId: rate.data!.id };
}

function punch(
  w: Worker,
  args: {
    kind?: "in" | "out";
    site?: string | null;
    point?: { lat: number; lng: number };
    agoMs?: number;
    reason?: string | null;
  } = {},
) {
  const now = Date.now();
  const ago = args.agoMs ?? 0;
  const point = args.point ?? CENTRE;
  return w.client.rpc("record_punch", {
    p_expected_organisation_id: w.org,
    p_expected_worker_id: w.id,
    p_client_event_id: randomUUID(),
    p_kind: args.kind ?? "in",
    p_device_time: new Date(now - ago).toISOString(),
    p_sent_device_time: new Date(now).toISOString(),
    p_elapsed_ms: ago,
    p_site_id: (args.site === undefined ? headOffice : args.site) as string,
    p_latitude: point.lat,
    p_longitude: point.lng,
    p_accuracy_m: 10,
    p_outside_reason: (args.reason ?? null) as string,
    p_outside_note: null as unknown as string,
    p_has_selfie: false,
  });
}

type Recorded = { id: string; geofence_result: string; flags: string[] };

async function recorded(w: Worker, args: Parameters<typeof punch>[1] = {}): Promise<Recorded> {
  const { data, error } = await punch(w, args);
  expect(error).toBeNull();
  return data as unknown as Recorded;
}

/**
 * A client shift assignment made before slice 6.11's guard existed (MLHO6 refuses one for
 * someone mapped to an office): inserted as the database owner with the guard off for the
 * transaction only.
 */
async function insertLegacyAssignment(values: {
  id: string;
  worker: string;
  date: string;
  startsAt: string;
  endsAt: string;
}) {
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      "alter table public.shift_assignments disable trigger shift_assignments_00_office_guard",
    );
    await db.query(
      `insert into public.shift_assignments
         (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at)
       values ($1, $2, gen_random_uuid(), $3, $4::date, $5, $6, $7)`,
      [
        values.id,
        owner.orgId,
        clientSite,
        values.date,
        values.worker,
        values.startsAt,
        values.endsAt,
      ],
    );
    await db.query(
      "alter table public.shift_assignments enable always trigger shift_assignments_00_office_guard",
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

/** Runs `sql` as the database owner with ordinary triggers (and foreign keys) off. */
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

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ha-owner", "Head Office Attendance Org");
  other = await createTenantUser("ha-other", "Other Attendance Org");
  hr = await createTestUser("ha-hr");
  ops = await createTestUser("ha-ops");
  await addMember(hr, "hr");
  await addMember(ops, "ops_manager");

  const client = await owner.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(client.error).toBeNull();
  const site = await admin
    .from("sites")
    .insert({
      organisation_id: owner.orgId,
      client_id: client.data!,
      name: "Apapa Warehouse 3",
      centre: `SRID=4326;POINT(${CENTRE.lng} ${CENTRE.lat})`,
      radius_m: 100,
    } as never)
    .select("id")
    .single();
  expect(site.error).toBeNull();
  clientSite = site.data!.id;

  headOffice = await officeOf(owner.orgId);
  theirOffice = await officeOf(other.orgId);
  // Ops sets Head office's geofence, as on the Head office card.
  const fenced = await ops.client
    .from("sites")
    .update({ centre: `SRID=4326;POINT(${CENTRE.lng} ${CENTRE.lat})`, radius_m: 100 } as never)
    .eq("id", headOffice);
  expect(fenced.error).toBeNull();
  // A branch with no geofence yet.
  const added = await ops.client
    .from("sites")
    .insert({ organisation_id: owner.orgId, kind: "office", name: "Ikeja branch" })
    .select("id")
    .single();
  expect(added.error).toBeNull();
  branch = added.data!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("clocking in at Head office (security review M2)", () => {
  it("records a no-shift clock-in inside the fence, and one outside it with the reason", async () => {
    const w = await addWorker(headOffice);
    const inside = await recorded(w);
    expect(inside.geofence_result).toBe("inside");
    expect(inside.flags).toContain("no_shift");
    expect(inside.flags).not.toContain("no_geofence");

    const outside = await recorded(w, { kind: "out", point: north(600), reason: "other" });
    expect(outside.geofence_result).toBe("outside");
    expect(outside.flags).toContain("outside");
    const { rows } = await db.query<{ site_id: string }>(
      "select site_id::text from public.punches where id = $1",
      [outside.id],
    );
    expect(rows).toEqual([{ site_id: headOffice }]);
  });

  it("refuses a clock-in without location consent (MLPU6)", async () => {
    const w = await addWorker(headOffice, ["selfie"]);
    expect((await punch(w)).error?.code).toBe("MLPU6");
  });

  it("refuses another company's office (MLPU7)", async () => {
    const w = await addWorker(headOffice);
    expect((await punch(w, { site: theirOffice })).error?.code).toBe("MLPU7");
  });

  it("records a clock-in at an office with no geofence and flags it, never refusing it", async () => {
    const w = await addWorker(branch);
    const r = await recorded(w, { site: branch });
    expect(r.geofence_result).toBe("unknown");
    expect(r.flags).toEqual(expect.arrayContaining(["no_shift", "no_geofence"]));
  });
});

describe("an office day never becomes a Work Unit (money review M1)", () => {
  it("ignores a leftover client shift, and the approved day makes no Work Unit", async () => {
    const w = await addWorker(headOffice);
    // A leftover assignment at the client's site covering now (seeded directly).
    const leftover = randomUUID();
    const now = Date.now();
    await insertLegacyAssignment({
      id: leftover,
      worker: w.id,
      date: lagosToday(),
      startsAt: new Date(now - 9 * HOUR).toISOString(),
      endsAt: new Date(now + HOUR).toISOString(),
    });

    const clockIn = await recorded(w, { agoMs: 8 * HOUR });
    expect(clockIn.flags).toContain("no_shift");
    const clockOut = await recorded(w, { kind: "out" });
    const { rows: punches } = await db.query<{ shift_assignment_id: string | null }>(
      "select shift_assignment_id::text from public.punches where id = any($1::uuid[])",
      [[clockIn.id, clockOut.id]],
    );
    expect(punches).toEqual([{ shift_assignment_id: null }, { shift_assignment_id: null }]);

    // The leftover is taken off (the refresh reads only real shifts), then the day is refreshed.
    await seedRaw(
      `update public.shift_assignments set status = 'removed', removed_at = now(),
         removed_reason = 'Test leftover' where id = $1`,
      [leftover],
    );
    const day = (
      await db.query<{ d: string }>(
        "select (recorded_at at time zone 'Africa/Lagos')::date::text as d from public.punches where id = $1",
        [clockIn.id],
      )
    ).rows[0]!.d;
    const refreshed = await owner.client.rpc("refresh_timesheet_lines", {
      p_organisation_id: owner.orgId,
      p_from: day,
      p_to: day,
    });
    expect(refreshed.error).toBeNull();
    const { rows: lines } = await db.query<{ id: string; worked_minutes: number }>(
      `select id::text, worked_minutes from public.timesheet_lines
       where organisation_id = $1 and worker_id = $2 and no_shift_punch_id is not null`,
      [owner.orgId, w.id],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.worked_minutes).toBeGreaterThan(400);

    const approved = await owner.client.rpc("approve_timesheet_line", {
      p_organisation_id: owner.orgId,
      p_line_id: lines[0]!.id,
      p_reason: "Worked at Head office",
    });
    expect(approved.error).toBeNull();
    const { rows: status } = await db.query<{ status: string }>(
      "select status from public.timesheet_lines where id = $1",
      [lines[0]!.id],
    );
    expect(status).toEqual([{ status: "approved" }]);
    const { rows: units } = await db.query(
      "select 1 from public.work_units where organisation_id = $1 and worker_id = $2",
      [owner.orgId, w.id],
    );
    expect(units).toEqual([]);
  });

  it("takes someone mapped to an office off their future client shifts, in the same save", async () => {
    const w = await addWorker(clientSite);
    const future = randomUUID();
    const later = new Date(Date.now() + 3 * 24 * HOUR);
    await seedRaw(
      `insert into public.shift_assignments
         (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at)
       values ($1, $2, gen_random_uuid(), $3, ($4::timestamptz at time zone 'Africa/Lagos')::date,
               $5, $4::timestamptz, $4::timestamptz + interval '8 hours')`,
      [future, owner.orgId, clientSite, later.toISOString(), w.id],
    );
    const { data, error } = await hr.client.rpc("save_worker_mapping", {
      p_organisation_id: owner.orgId,
      p_worker_id: w.id,
      p_site_id: headOffice,
    });
    expect(error).toBeNull();
    const released = (data as { released_shifts: { assignment_id: string }[] }).released_shifts;
    expect(released.map((r) => r.assignment_id)).toEqual([future]);
    const { rows } = await db.query<{ status: string; removed_reason: string | null }>(
      "select status, removed_reason from public.shift_assignments where id = $1",
      [future],
    );
    expect(rows[0]!.status).toBe("removed");
    expect(rows[0]!.removed_reason).toMatch(/^Mapped to an office from /);
    const audit = await db.query(
      `select 1 from public.audit_log
       where organisation_id = $1 and action = 'roster.office_mapping_released' and entity_id = $2`,
      [owner.orgId, w.id],
    );
    expect(audit.rows).toHaveLength(1);
  });
});

describe("money review round 2", () => {
  it("refuses a new client shift for someone mapped to Head office (MLHO6), the secret key too", async () => {
    const w = await addWorker(headOffice);
    const refused = await admin.from("shift_assignments").insert({
      organisation_id: owner.orgId,
      shift_id: randomUUID(),
      site_id: clientSite,
      shift_date: lagosToday(),
      worker_id: w.id,
      starts_at: new Date(Date.now() + HOUR).toISOString(),
      ends_at: new Date(Date.now() + 9 * HOUR).toISOString(),
    });
    expect(refused.error?.code).toBe("MLHO6");
    expect(refused.error?.message).toBe(
      "This person is mapped to Head office. Map them to the client site first.",
    );
  });

  it("pairs a clock-out that names no site with the office clock-in, never a shift (L4)", async () => {
    const w = await addWorker(headOffice);
    const now = Date.now();
    // A legacy client shift covering the clock-out, to show it isn't picked up.
    await insertLegacyAssignment({
      id: randomUUID(),
      worker: w.id,
      date: lagosToday(),
      startsAt: new Date(now - HOUR).toISOString(),
      endsAt: new Date(now + 7 * HOUR).toISOString(),
    });
    const clockIn = await recorded(w, { agoMs: 3 * HOUR });
    const clockOut = await recorded(w, { kind: "out", site: null });
    expect(clockOut.flags).toContain("no_shift");
    const { rows } = await db.query<{ site_id: string; shift_assignment_id: string | null }>(
      `select site_id::text, shift_assignment_id::text from public.punches
       where id = any($1::uuid[]) order by recorded_at`,
      [[clockIn.id, clockOut.id]],
    );
    expect(rows).toEqual([
      { site_id: headOffice, shift_assignment_id: null },
      { site_id: headOffice, shift_assignment_id: null },
    ]);
  });

  it("removes no shift when a save only changes the department of someone already at the office (M1-a)", async () => {
    // At the client's site first, with a shift in three days; then put at Head office directly
    // (no save), as data from before the release existed would be.
    const w = await addWorker(clientSite);
    const shift = randomUUID();
    const later = Date.now() + 3 * 24 * HOUR;
    await seedRaw(
      `insert into public.shift_assignments
         (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at)
       values ($1, $2, gen_random_uuid(), $3, ($4::timestamptz at time zone 'Africa/Lagos')::date,
               $5, $4::timestamptz, $4::timestamptz + interval '8 hours')`,
      [shift, owner.orgId, clientSite, new Date(later).toISOString(), w.id],
    );
    await db.query(
      "update public.worker_assignments set effective_to = '2025-12-31' where worker_id = $1",
      [w.id],
    );
    const office = await admin.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: w.id,
      site_id: headOffice,
      effective_from: "2026-01-01",
    });
    expect(office.error).toBeNull();
    const department = await hr.client
      .from("departments")
      .insert({ organisation_id: owner.orgId, name: `Finance ${randomUUID().slice(0, 6)}` })
      .select("id")
      .single();
    expect(department.error).toBeNull();

    const { data, error } = await hr.client.rpc("save_worker_mapping", {
      p_organisation_id: owner.orgId,
      p_worker_id: w.id,
      p_department_id: department.data!.id,
      p_site_id: headOffice,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ department_changed: true, released_shifts: [] });
    const { rows } = await db.query<{ status: string }>(
      "select status from public.shift_assignments where id = $1",
      [shift],
    );
    expect(rows).toEqual([{ status: "assigned" }]);
  });

  it("refuses to release shifts for someone not mapped to an office (L1, MLHO7)", async () => {
    const w = await addWorker(clientSite);
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: hr.id, role: "authenticated", amr: [{ method: "otp" }] }),
      ]);
      await expect(
        db.query("select private.release_shifts_for_office($1, $2, current_date + 1)", [
          owner.orgId,
          w.id,
        ]),
      ).rejects.toMatchObject({ code: "MLHO7" });
    } finally {
      await db.query("rollback");
    }
  });
});
