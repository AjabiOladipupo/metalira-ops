/**
 * Slice 3.5: clock in and out against the real database.
 * - record_punch: the worker and company come from the session; the queue owner the phone sends
 *   is only compared (wrong_session otherwise); another company's site is refused; idempotent on
 *   client_event_id, a different punch under the same id refused; outside punches recorded with
 *   the flag and reason; refused with no location consent, with Shifts off, for a leaver, and
 *   past 20 an hour; the shift matched and late flagged; server-corrected time and drift.
 * - punches are insert-only for everyone; nobody writes them directly.
 * - Reads: the worker their own; owner, admin, ops_manager and hr all; a line manager their
 *   reportees'; finance and other companies nothing. The point is not granted; punch_locations
 *   gives it to owner and admin only, with an audit row.
 * - The staff ID hook sees punches.
 * - The SQL time and flag rules agree with src/lib/punches.
 * - Selfies: only the server attaches one, at the punch's own path, within the bucket's size and
 *   type limits; workers can't upload or read; managers read by signed URL; no public read.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lagosToday } from "@/lib/dates";
import { punchFlags, type FlagInput } from "@/lib/punches/flags";
import { correctedTime } from "@/lib/punches/time";
import type { Database, Json } from "@/types/db";

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
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const north = (m: number) => ({ lat: CENTRE.lat + m / 111_195, lng: CENTRE.lng });

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager", TestUser>;
let clientId: string;
let site: string;
let otherSite: string;
let counter = 0;

interface Worker {
  id: string;
  org: string;
  userId: string;
  client: Client;
}

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

/** A worker mapped to `mappedTo`, invited, signed in, with the consents given. */
async function addWorker(
  options: {
    orgId?: string;
    mappedTo?: string | null;
    consents?: ("location" | "selfie")[];
    fields?: Partial<Database["public"]["Tables"]["workers"]["Insert"]>;
    inviter?: TestUser;
  } = {},
): Promise<Worker> {
  const orgId = options.orgId ?? owner.orgId;
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `PU-${String(counter).padStart(4, "0")}`,
      first_name: "Musa",
      last_name: `Bello ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...options.fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const workerId = data!.id;
  const mappedTo = options.mappedTo === undefined ? site : options.mappedTo;
  if (mappedTo) {
    const map = await admin.from("worker_assignments").insert({
      organisation_id: orgId,
      worker_id: workerId,
      site_id: mappedTo,
      effective_from: "2025-01-06",
    });
    expect(map.error).toBeNull();
  }
  const invite = await (options.inviter ?? staff.hr).client.rpc("create_worker_invites", {
    p_organisation_id: orgId,
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
  for (const kind of options.consents ?? ["location", "selfie"]) {
    const consent = await client.rpc("accept_worker_consent", {
      p_organisation_id: orgId,
      p_kind: kind,
      p_notice_version: "1.0",
    });
    expect(consent.error).toBeNull();
  }
  return { id: workerId, org: orgId, userId: login.data.user!.id, client };
}

interface PunchArgs {
  kind?: "in" | "out";
  id?: string;
  org?: string;
  worker?: string;
  site?: string | null;
  point?: { lat: number; lng: number } | null;
  accuracy?: number | null;
  reason?: string | null;
  note?: string | null;
  selfie?: boolean;
  deviceTime?: Date;
  sentDeviceTime?: Date | null;
  elapsedMs?: number | null;
}

function punch(w: Worker, args: PunchArgs = {}) {
  const now = new Date();
  const point = args.point === undefined ? CENTRE : args.point;
  return w.client.rpc("record_punch", {
    p_expected_organisation_id: args.org ?? w.org,
    p_expected_worker_id: args.worker ?? w.id,
    p_client_event_id: args.id ?? randomUUID(),
    p_kind: args.kind ?? "in",
    p_device_time: (args.deviceTime ?? now).toISOString(),
    p_sent_device_time: (args.sentDeviceTime === undefined
      ? now.toISOString()
      : args.sentDeviceTime?.toISOString()) as string,
    p_elapsed_ms: (args.elapsedMs === undefined ? 0 : args.elapsedMs) as number,
    p_site_id: (args.site === undefined ? site : args.site) as string,
    p_latitude: point?.lat as number,
    p_longitude: point?.lng as number,
    p_accuracy_m: (args.accuracy === undefined ? 10 : args.accuracy) as number,
    p_outside_reason: (args.reason ?? null) as string,
    p_outside_note: (args.note ?? null) as string,
    p_has_selfie: args.selfie ?? true,
  });
}

interface Recorded {
  id: string;
  duplicate: boolean;
  recorded_at: string;
  geofence_result: string;
  distance_m: number | null;
  flags: string[];
  selfie_wanted: boolean;
}

async function recorded(w: Worker, args: PunchArgs = {}): Promise<Recorded> {
  const { data, error } = await punch(w, args);
  expect(error).toBeNull();
  return data as unknown as Recorded;
}

async function row(id: string) {
  const { rows } = await db.query(
    "select *, extensions.st_y(extensions.geometry(location)) as lat from public.punches where id = $1",
    [id],
  );
  return rows[0] as Record<string, unknown>;
}

/** A contract live from today at `site` with one post staffed all day today. */
async function liveAllDayPost(): Promise<string> {
  const today = lagosToday();
  const { data: id, error } = await staff.ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: "Clock guarding",
      type: "manned_post",
      start_date: today,
    } as Json,
    p_site_ids: [site],
  });
  expect(error).toBeNull();
  const card = await staff.ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: id!,
    p_effective_from: today,
    p_lines: [{ role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" }] as Json,
  });
  expect(card.error).toBeNull();
  const headcount = await staff.ops.client.from("headcount_requirements").insert({
    organisation_id: owner.orgId,
    contract_id: id!,
    site_id: site,
    role: "Guard",
    unit: "shift",
    days_of_week: EVERY_DAY,
    required_count: 5,
    post_name: "Gate A",
    band: "Day",
    start_time: "00:00",
    end_time: "23:45",
  } as never);
  expect(headcount.error).toBeNull();
  const live = await staff.ops.client.rpc("activate_contract", {
    p_organisation_id: owner.orgId,
    p_contract_id: id!,
    p_send_welcome: false,
  });
  expect(live.error).toBeNull();
  const post = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", id!)
    .eq("name", "Gate A · Day")
    .single();
  expect(post.error).toBeNull();
  return post.data!.id;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("pu-owner", "Punch Org");
  other = await createTenantUser("pu-other", "Other Punch Org");
  staff.admin = await createTestUser("pu-admin");
  staff.hr = await createTestUser("pu-hr");
  staff.finance = await createTestUser("pu-finance");
  staff.ops = await createTestUser("pu-ops");
  staff.lineManager = await createTestUser("pu-lm");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  await addMember(staff.lineManager, "line_manager");

  const client = await owner.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(client.error).toBeNull();
  clientId = client.data!;
  const sites = await admin
    .from("sites")
    .insert({
      organisation_id: owner.orgId,
      client_id: clientId,
      name: "Apapa Warehouse 3",
      centre: `SRID=4326;POINT(${CENTRE.lng} ${CENTRE.lat})`,
      radius_m: 100,
    } as never)
    .select("id")
    .single();
  expect(sites.error).toBeNull();
  site = sites.data!.id;
  const otherClient = await other.client.rpc("create_client", {
    p_organisation_id: other.orgId,
    p_name: "Elsewhere Ltd",
    p_contact_name: "Ada Obi",
    p_contact_email: "ops@elsewhere.example",
  });
  expect(otherClient.error).toBeNull();
  const otherSites = await admin
    .from("sites")
    .insert({
      organisation_id: other.orgId,
      client_id: otherClient.data!,
      name: "Other Gate",
      centre: `SRID=4326;POINT(${CENTRE.lng} ${CENTRE.lat})`,
    } as never)
    .select("id")
    .single();
  expect(otherSites.error).toBeNull();
  otherSite = otherSites.data!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("record_punch: who and where", () => {
  it("records the punch for the session's own worker and company", async () => {
    const w = await addWorker();
    const result = await recorded(w);
    expect(result.duplicate).toBe(false);
    expect(result.geofence_result).toBe("inside");
    const r = await row(result.id);
    expect(r).toMatchObject({
      organisation_id: owner.orgId,
      worker_id: w.id,
      recorded_by_user: w.userId,
      source: "self",
      kind: "in",
      site_id: site,
      selfie_expected: true,
    });
    expect(r.flags).toEqual(["no_shift"]);
  });

  it("refuses a queue that belongs to another worker or company (never recorded elsewhere)", async () => {
    const w = await addWorker();
    const colleague = await addWorker();
    const asOther = await punch(w, { org: other.orgId });
    expect(asOther.error?.code).toBe("MLPU9");
    const asColleague = await punch(w, { worker: colleague.id });
    expect(asColleague.error?.code).toBe("MLPU9");
    const { rows } = await db.query(
      "select count(*)::int as n from public.punches where worker_id = any($1)",
      [[w.id, colleague.id]],
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses a login that is not a worker", async () => {
    const { error } = await staff.ops.client.rpc("record_punch", {
      p_expected_organisation_id: owner.orgId,
      p_expected_worker_id: randomUUID(),
      p_client_event_id: randomUUID(),
      p_kind: "in",
      p_device_time: new Date().toISOString(),
      p_sent_device_time: new Date().toISOString(),
      p_elapsed_ms: 0,
      p_site_id: site,
      p_latitude: CENTRE.lat,
      p_longitude: CENTRE.lng,
      p_accuracy_m: 5,
      p_outside_reason: null as unknown as string,
      p_outside_note: null as unknown as string,
      p_has_selfie: false,
    });
    expect(error?.code).toBe("MLPU1");
    const anon = await anonClient().rpc("record_punch", {} as never);
    expect(anon.error).not.toBeNull();
  });

  it("refuses another company's site, and a site the worker isn't working at", async () => {
    const w = await addWorker();
    expect((await punch(w, { site: otherSite })).error?.code).toBe("MLPU7");
    const unmapped = await addWorker({ mappedTo: null });
    expect((await punch(unmapped)).error?.code).toBe("MLPU7");
    // With no site at all it is recorded, with nothing to check against.
    const free = await recorded(unmapped, { site: null });
    expect(free.geofence_result).toBe("unknown");
  });
});

describe("record_punch: idempotency", () => {
  it("the same event twice is one row", async () => {
    const w = await addWorker();
    const id = randomUUID();
    const deviceTime = new Date();
    const first = await recorded(w, { id, deviceTime });
    const again = await recorded(w, { id, deviceTime, elapsedMs: 5000 });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    const { rows } = await db.query(
      "select count(*)::int as n from public.punches where client_event_id = $1",
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a different punch under the same id is refused", async () => {
    const w = await addWorker();
    const id = randomUUID();
    const deviceTime = new Date();
    await recorded(w, { id, deviceTime });
    expect((await punch(w, { id, deviceTime, point: north(30) })).error?.code).toBe("MLPU2");
  });

  it("another worker's id is theirs alone: the same id is a new punch for someone else", async () => {
    const a = await addWorker();
    const b = await addWorker();
    const id = randomUUID();
    const deviceTime = new Date();
    const first = await recorded(a, { id, deviceTime });
    const second = await recorded(b, { id, deviceTime });
    expect(second.duplicate).toBe(false);
    expect(second.id).not.toBe(first.id);
  });
});

describe("record_punch: outside, consent, switches and limits", () => {
  it("records an outside punch with the flag, the distance and the reason", async () => {
    const w = await addWorker();
    const result = await recorded(w, {
      point: north(620),
      reason: "other",
      note: "Client asked me to wait at the gate",
    });
    expect(result.geofence_result).toBe("outside");
    expect(result.flags).toContain("outside");
    expect(result.distance_m).toBeGreaterThan(600);
    expect(await row(result.id)).toMatchObject({
      outside_reason: "other",
      outside_note: "Client asked me to wait at the gate",
    });
  });

  it("drops a reason on an inside punch and refuses a note with a phone number", async () => {
    const w = await addWorker();
    const inside = await recorded(w, { reason: "gate_locked" });
    expect((await row(inside.id)).outside_reason).toBeNull();
    const bad = await punch(w, { point: north(620), reason: "other", note: "call 08031234567" });
    expect(bad.error?.code).toBe("MLPU5");
  });

  it("refuses without location consent, and flags no selfie without selfie consent", async () => {
    const none = await addWorker({ consents: [] });
    expect((await punch(none)).error?.code).toBe("MLPU6");
    const locationOnly = await addWorker({ consents: ["location"] });
    const result = await recorded(locationOnly, { selfie: true });
    expect(result.selfie_wanted).toBe(false);
    expect(result.flags).toContain("no_selfie");
  });

  it("refuses when the company has Shifts switched off", async () => {
    const w = await addWorker({ orgId: other.orgId, mappedTo: otherSite, inviter: other });
    await db.query("update public.organisations set shifts_enabled = false where id = $1", [
      other.orgId,
    ]);
    try {
      expect((await punch(w, { site: otherSite })).error?.code).toBe("MLPU4");
    } finally {
      await db.query("update public.organisations set shifts_enabled = true where id = $1", [
        other.orgId,
      ]);
    }
    expect((await punch(w, { site: otherSite })).error).toBeNull();
  });

  it("refuses a worker who has left", async () => {
    const w = await addWorker();
    await db.query(
      "update public.workers set status = 'ended', end_date = current_date - 1 where id = $1",
      [w.id],
    );
    expect((await punch(w)).error?.code).toBe("MLPU3");
  });

  it("allows 20 punches an hour per worker", async () => {
    const w = await addWorker();
    for (let i = 0; i < 20; i += 1) {
      const { error } = await punch(w, { kind: i % 2 === 0 ? "in" : "out", selfie: false });
      expect(error).toBeNull();
    }
    expect((await punch(w)).error?.code).toBe("MLPU8");
  });
});

describe("record_punch: time, shift and sequence", () => {
  it("corrects the time from the elapsed time and flags a phone clock 10 minutes fast", async () => {
    const w = await addWorker();
    const before = Date.now();
    const result = await recorded(w, {
      deviceTime: new Date(before - 60_000 + 10 * 60_000),
      sentDeviceTime: new Date(before + 10 * 60_000),
      elapsedMs: 60_000,
    });
    const at = Date.parse(result.recorded_at);
    expect(at).toBeGreaterThan(before - 60_000 - 5_000);
    expect(at).toBeLessThan(Date.now() - 60_000 + 5_000);
    const r = await row(result.id);
    expect(r.time_source).toBe("elapsed");
    expect(Number(r.clock_drift_seconds)).toBeGreaterThan(590);
    expect(result.flags).toContain("clock_drift");
  });

  it("flags a punch sent more than 2 hours after it happened", async () => {
    const w = await addWorker();
    const result = await recorded(w, {
      elapsedMs: 3 * 3_600_000,
      deviceTime: new Date(Date.now() - 3 * 3_600_000),
    });
    expect(result.flags).toContain("late_sync");
    expect(result.flags).not.toContain("clock_drift");
  });

  it("flags a second clock-in and a clock-out without one", async () => {
    const w = await addWorker();
    await recorded(w, { elapsedMs: 120_000, deviceTime: new Date(Date.now() - 120_000) });
    expect((await recorded(w)).flags).toContain("double_in");
    const lone = await addWorker();
    expect((await recorded(lone, { kind: "out" })).flags).toContain("out_without_in");
  });

  it("matches today's assignment and flags a late clock-in", async () => {
    const post = await liveAllDayPost();
    const w = await addWorker();
    const assigned = await staff.ops.client.rpc("assign_worker_to_shift", {
      p_organisation_id: owner.orgId,
      p_post_id: post,
      p_shift_date: lagosToday(),
      p_worker_id: w.id,
    });
    expect(assigned.error).toBeNull();
    const assignment = String((assigned.data as { assignment_id: string }).assignment_id);
    const { data: shift } = await admin
      .from("shift_assignments")
      .select("starts_at, ends_at")
      .eq("id", assignment)
      .single();
    const start = Date.parse(shift!.starts_at);
    const end = Date.parse(shift!.ends_at);
    const result = await recorded(w);
    const r = await row(result.id);
    expect(r.shift_assignment_id).toBe(assignment);
    expect(result.flags).not.toContain("no_shift");
    // The grace is 10 minutes: now is late unless the day started under 10 minutes ago.
    if (Date.now() > start + 11 * 60_000) expect(result.flags).toContain("late");
    // A clock-out belongs to the same shift and is early (the shift ends at 23:45).
    const out = await recorded(w, { kind: "out" });
    expect((await row(out.id)).shift_assignment_id).toBe(assignment);
    if (Date.now() < end - 11 * 60_000) expect(out.flags).toContain("early_out");
    expect(out.flags).not.toContain("out_without_in");
  });
});

describe("punches are insert-only", () => {
  it("nobody updates, deletes or inserts directly, the database owner included", async () => {
    const w = await addWorker();
    const result = await recorded(w);
    await expect(
      db.query("update public.punches set kind = 'out' where id = $1", [result.id]),
    ).rejects.toMatchObject({ code: "MLPU0" });
    await expect(
      db.query("delete from public.punches where id = $1", [result.id]),
    ).rejects.toMatchObject({ code: "MLPU0" });
    await expect(db.query("truncate public.punches")).rejects.toBeTruthy();
    const direct = await w.client.from("punches").insert({
      organisation_id: owner.orgId,
      worker_id: w.id,
      kind: "in",
      recorded_by_user: w.userId,
      client_event_id: randomUUID(),
      device_time: new Date().toISOString(),
      recorded_at: new Date().toISOString(),
      time_source: "device",
      clock_drift_seconds: 0,
      geofence_result: "inside",
      payload_hash: "0".repeat(32),
    });
    expect(direct.error).not.toBeNull();
    const viaKey = await admin.from("punches").update({ kind: "out" }).eq("id", result.id);
    expect(viaKey.error).not.toBeNull();
    const delKey = await admin.from("punches").delete().eq("id", result.id);
    expect(delKey.error).not.toBeNull();
    expect((await row(result.id)).kind).toBe("in");
  });

  it("the staff ID hook sees punches", async () => {
    const w = await addWorker();
    const has = async () =>
      (
        await db.query<{ has: boolean }>("select private.worker_has_work_records($1, $2) as has", [
          owner.orgId,
          w.id,
        ])
      ).rows[0]!.has;
    expect(await has()).toBe(false);
    await recorded(w);
    expect(await has()).toBe(true);
  });
});

describe("who reads punches", () => {
  let mine: Worker;
  let reportee: Worker;
  let mineId: string;
  let reporteeId: string;

  beforeAll(async () => {
    const lm = await admin
      .from("memberships")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.lineManager.id)
      .single();
    mine = await addWorker();
    reportee = await addWorker({ fields: { line_manager_membership_id: lm.data!.id } });
    mineId = (await recorded(mine)).id;
    reporteeId = (await recorded(reportee)).id;
  });

  const ids = async (client: Client) => {
    const { data, error } = await client
      .from("punches")
      .select("id, geofence_result, distance_m")
      .in("id", [mineId, reporteeId]);
    expect(error).toBeNull();
    return (data ?? []).map((r) => r.id).sort();
  };

  it("owner, admin, ops_manager and hr read every punch; finance none", async () => {
    const both = [mineId, reporteeId].sort();
    expect(await ids(owner.client)).toEqual(both);
    expect(await ids(staff.admin.client)).toEqual(both);
    expect(await ids(staff.ops.client)).toEqual(both);
    expect(await ids(staff.hr.client)).toEqual(both);
    expect(await ids(staff.finance.client)).toEqual([]);
  });

  it("a line manager reads their reportees' punches only", async () => {
    expect(await ids(staff.lineManager.client)).toEqual([reporteeId]);
  });

  it("a worker reads their own only; another company nothing", async () => {
    expect(await ids(mine.client)).toEqual([mineId]);
    expect(await ids(other.client)).toEqual([]);
  });

  it("nobody reads the point through the table", async () => {
    for (const client of [owner.client, mine.client, staff.ops.client]) {
      const { error } = await client.from("punches").select("location").eq("id", mineId);
      expect(error?.code).toBe("42501");
    }
  });

  it("owner and admin read coordinates through punch_locations, audited; nobody else", async () => {
    const { data, error } = await owner.client.rpc("punch_locations", {
      p_organisation_id: owner.orgId,
      p_punch_ids: [mineId],
    });
    expect(error).toBeNull();
    expect(data![0]).toMatchObject({ punch_id: mineId });
    expect(data![0]!.latitude).toBeCloseTo(CENTRE.lat, 5);
    const audit = await admin
      .from("audit_log")
      .select("action")
      .eq("organisation_id", owner.orgId)
      .eq("action", "punch.location_viewed");
    expect(audit.data?.length).toBeGreaterThan(0);
    for (const client of [
      staff.ops.client,
      staff.hr.client,
      staff.lineManager.client,
      mine.client,
    ]) {
      const refused = await client.rpc("punch_locations", {
        p_organisation_id: owner.orgId,
        p_punch_ids: [mineId],
      });
      expect(refused.error?.code).toBe("42501");
    }
    const cross = await other.client.rpc("punch_locations", {
      p_organisation_id: owner.orgId,
      p_punch_ids: [mineId],
    });
    expect(cross.error?.code).toBe("42501");
  });

  it("the audit rows of punches leave the point out", async () => {
    const audit = await admin
      .from("audit_log")
      .select("after")
      .eq("entity", "punches")
      .eq("entity_id", mineId)
      .eq("action", "punches.insert")
      .single();
    expect(audit.error).toBeNull();
    expect(audit.data!.after).not.toHaveProperty("location");
    expect(audit.data!.after).toHaveProperty("geofence_result", "inside");
  });
});

describe("the SQL rules match src/lib/punches", () => {
  it("corrected time", async () => {
    const received = Date.UTC(2026, 10, 20, 8, 0, 0);
    const cases = [
      { deviceTime: received - 60_000, sentDeviceTime: received, elapsedMs: 60_000 },
      { deviceTime: received + 600_000, sentDeviceTime: received + 900_000, elapsedMs: null },
      { deviceTime: received + 3_600_000, sentDeviceTime: null, elapsedMs: -5 },
      { deviceTime: received - 40 * 86_400_000, sentDeviceTime: received, elapsedMs: null },
      { deviceTime: received - 1000, sentDeviceTime: received, elapsedMs: 8 * 86_400_000 },
    ];
    for (const c of cases) {
      const ts = correctedTime({ ...c, receivedAt: received });
      const { rows } = await db.query<{ recorded_at: Date; time_source: string }>(
        "select * from private.punch_corrected_time($1, $2, $3, $4)",
        [
          new Date(c.deviceTime),
          c.sentDeviceTime === null ? null : new Date(c.sentDeviceTime),
          c.elapsedMs,
          new Date(received),
        ],
      );
      expect(rows[0]!.time_source, JSON.stringify(c)).toBe(ts.source);
      expect(rows[0]!.recorded_at.getTime(), JSON.stringify(c)).toBe(ts.recordedAt);
    }
  });

  it("flags", async () => {
    const now = Date.UTC(2026, 10, 20, 8, 0, 0);
    const base: FlagInput = {
      kind: "in",
      geofence: "inside",
      hasLocation: true,
      selfieExpected: true,
      shiftStartsAt: now - 30 * 60_000,
      shiftEndsAt: now + 8 * 3_600_000,
      graceMinutes: 10,
      recordedAt: now,
      receivedAt: now + 3 * 3_600_000,
      clockDriftSeconds: 400,
      timeSource: "offset",
      previous: { kind: "in", recordedAt: now - 3_600_000 },
    };
    const cases: FlagInput[] = [
      base,
      { ...base, kind: "out", selfieExpected: false, previous: null, geofence: "near" },
      { ...base, hasLocation: false, geofence: "unknown", shiftStartsAt: null, shiftEndsAt: null },
      { ...base, timeSource: "device", clockDriftSeconds: 0, receivedAt: now, previous: null },
    ];
    for (const c of cases) {
      const { rows } = await db.query<{ flags: string[] }>(
        `select private.punch_flags($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) as flags`,
        [
          c.kind,
          c.geofence,
          c.hasLocation,
          c.selfieExpected,
          c.shiftStartsAt === null ? null : new Date(c.shiftStartsAt),
          c.shiftEndsAt === null ? null : new Date(c.shiftEndsAt),
          c.graceMinutes,
          new Date(c.recordedAt),
          new Date(c.receivedAt),
          c.clockDriftSeconds,
          c.timeSource,
          c.previous?.kind ?? null,
          c.previous ? new Date(c.previous.recordedAt) : null,
        ],
      );
      expect(rows[0]!.flags, JSON.stringify(c)).toEqual(punchFlags(c));
    }
  });
});

describe("selfies", () => {
  const BUCKET = "punch-photos";
  const jpeg = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes;
  };
  let w: Worker;
  let punchId: string;
  let path: string;

  beforeAll(async () => {
    w = await addWorker();
    punchId = (await recorded(w, { selfie: true })).id;
    const created = (await row(punchId)).created_at as Date;
    path = `${owner.orgId}/${created.toISOString().slice(0, 7)}/${punchId}.jpg`;
  });

  it("a worker can't upload to the bucket or attach a selfie", async () => {
    const upload = await w.client.storage
      .from(BUCKET)
      .upload(path, jpeg(1000), { contentType: "image/jpeg" });
    expect(upload.error).not.toBeNull();
    const attach = await w.client.rpc("attach_punch_selfie", {
      p_punch_id: punchId,
      p_actor: w.userId,
      p_path: path,
    });
    expect(attach.error).not.toBeNull();
  });

  it("the bucket refuses the wrong type and anything over 200 KB", async () => {
    const big = await admin.storage
      .from(BUCKET)
      .upload(`${owner.orgId}/2026-11/${randomUUID()}.jpg`, jpeg(210 * 1024), {
        contentType: "image/jpeg",
      });
    expect(big.error).not.toBeNull();
    const png = await admin.storage
      .from(BUCKET)
      .upload(`${owner.orgId}/2026-11/${randomUUID()}.jpg`, jpeg(1000), {
        contentType: "image/png",
      });
    expect(png.error).not.toBeNull();
  });

  it("attaches only at the punch's own path, for its own worker, once", async () => {
    const stray = `${owner.orgId}/2026-01/${randomUUID()}.jpg`;
    expect(
      (await admin.storage.from(BUCKET).upload(stray, jpeg(1000), { contentType: "image/jpeg" }))
        .error,
    ).toBeNull();
    const wrongPath = await admin.rpc("attach_punch_selfie", {
      p_punch_id: punchId,
      p_actor: w.userId,
      p_path: stray,
    });
    expect(wrongPath.error?.code).toBe("MLPS1");
    const notThere = await admin.rpc("attach_punch_selfie", {
      p_punch_id: punchId,
      p_actor: w.userId,
      p_path: path,
    });
    expect(notThere.error?.code).toBe("MLPS2");

    expect(
      (await admin.storage.from(BUCKET).upload(path, jpeg(3000), { contentType: "image/jpeg" }))
        .error,
    ).toBeNull();
    const colleague = await addWorker();
    const wrongActor = await admin.rpc("attach_punch_selfie", {
      p_punch_id: punchId,
      p_actor: colleague.userId,
      p_path: path,
    });
    expect(wrongActor.error?.code).toBe("MLPS1");
    const ok = await admin.rpc("attach_punch_selfie", {
      p_punch_id: punchId,
      p_actor: w.userId,
      p_path: path,
    });
    expect(ok.error).toBeNull();
    expect((await row(punchId)).selfie_path).toBe(path);
    const twice = await admin.rpc("attach_punch_selfie", {
      p_punch_id: punchId,
      p_actor: w.userId,
      p_path: path,
    });
    expect(twice.error?.code).toBe("MLPS1");
    // A clock-out never takes one.
    const out = await recorded(w, { kind: "out" });
    expect(out.selfie_wanted).toBe(false);
  });

  it("managers read it by signed URL; workers, finance, others and the public can't", async () => {
    const signed = await staff.ops.client.storage.from(BUCKET).createSignedUrl(path, 60);
    expect(signed.error).toBeNull();
    for (const client of [w.client, staff.finance.client, staff.hr.client, other.client]) {
      const refused = await client.storage.from(BUCKET).createSignedUrl(path, 60);
      expect(refused.error).not.toBeNull();
    }
    const anon = await anonClient().storage.from(BUCKET).download(path);
    expect(anon.error).not.toBeNull();
    const pub = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    expect((await fetch(pub)).ok).toBe(false);
  });

  it("the sweep's functions are for the server only, and keep a selfie under 90 days", async () => {
    for (const fn of ["punch_selfies_due", "punch_photo_orphans"] as const) {
      expect((await w.client.rpc(fn, {})).error).not.toBeNull();
    }
    expect(
      (await staff.ops.client.rpc("clear_punch_selfie", { p_punch_id: punchId })).error,
    ).not.toBeNull();
    const cleared = await admin.rpc("clear_punch_selfie", { p_punch_id: punchId });
    expect(cleared.error).toBeNull();
    expect(cleared.data).toBe(false);
    const due = await admin.rpc("punch_selfies_due", { p_limit: 1000 });
    expect(due.error).toBeNull();
    expect((due.data ?? []).some((d) => d.punch_id === punchId)).toBe(false);
  });
});
