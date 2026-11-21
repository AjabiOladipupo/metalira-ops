/**
 * Slice 3.8: patrol checkpoint scans against the real database.
 * - record_checkpoint_scan: a punch of kind checkpoint for the session's own worker, at the
 *   checkpoint's site, on their shift there; the geofence worked out on the server.
 * - The token resolves only inside the session's company: another company's token, an unknown
 *   one, a retired checkpoint and a malformed token all get the same refusal (MLCK1, same
 *   message), so the answer never says whether a code exists.
 * - Refused: a worker not on a shift at that site (MLCK2), an untrusted session (42501), Shifts
 *   off (MLPU4), a leaver (MLPU3), no location consent (MLPU6), another login's queue (MLPU9).
 * - client_event_id is unique per worker: the same scan again is one row, a different scan
 *   under the same id is refused, another worker's same id is their own new row.
 * - Scans are insert-only and never confuse clock-in and clock-out.
 * - Reads: owner and ops see scans; a line manager only their reportees'; another company none.
 * - Nothing stores the token: not the punch row, not its audit row.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lagosToday } from "@/lib/dates";
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
const staff = {} as Record<"hr" | "ops" | "lineManager", TestUser>;
let clientId: string;
let site: string;
let secondSite: string;
let otherSite: string;
let post: string;
let gate: { id: string; token: string };
let tower: { id: string; token: string };
let farGate: { id: string; token: string };
let otherToken: string;
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

async function addCheckpoint(
  orgId: string,
  siteId: string,
  name: string,
  at?: { lat: number; lng: number },
): Promise<{ id: string; token: string }> {
  const { data, error } = await admin
    .from("site_checkpoints")
    .insert({
      organisation_id: orgId,
      site_id: siteId,
      name,
      ...(at ? { location: `SRID=4326;POINT(${at.lng} ${at.lat})` } : {}),
    } as never)
    .select("id")
    .single();
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  const { rows } = await db.query<{ qr_token: string }>(
    "select qr_token from public.site_checkpoints where id = $1",
    [id],
  );
  return { id, token: rows[0]!.qr_token };
}

/** A worker mapped to the site, signed in, with the consents given. */
async function addWorker(
  options: {
    orgId?: string;
    mappedTo?: string;
    consents?: ("location" | "selfie")[];
    inviter?: TestUser;
    fields?: Partial<Database["public"]["Tables"]["workers"]["Insert"]>;
  } = {},
): Promise<Worker> {
  const orgId = options.orgId ?? owner.orgId;
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `CK-${String(counter).padStart(4, "0")}`,
      first_name: "Peter",
      last_name: `Ade ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...options.fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const workerId = data!.id;
  const map = await admin.from("worker_assignments").insert({
    organisation_id: orgId,
    worker_id: workerId,
    site_id: options.mappedTo ?? site,
    effective_from: "2025-01-06",
  });
  expect(map.error).toBeNull();
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
  for (const kind of options.consents ?? ["location"]) {
    const consent = await client.rpc("accept_worker_consent", {
      p_organisation_id: orgId,
      p_kind: kind,
      p_notice_version: "1.0",
    });
    expect(consent.error).toBeNull();
  }
  return { id: workerId, org: orgId, userId: login.data.user!.id, client };
}

/** Puts the worker on today's all-day shift at `site`; returns the assignment. */
async function onShift(w: Worker): Promise<string> {
  const assigned = await staff.ops.client.rpc("assign_worker_to_shift", {
    p_organisation_id: owner.orgId,
    p_post_id: post,
    p_shift_date: lagosToday(),
    p_worker_id: w.id,
  });
  expect(assigned.error).toBeNull();
  return String((assigned.data as { assignment_id: string }).assignment_id);
}

/** A contract live from today at `site` with one post staffed all day today. */
async function liveAllDayPost(): Promise<string> {
  const today = lagosToday();
  const { data: id, error } = await staff.ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: "Patrol guarding",
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
    required_count: 20,
    post_name: "Patrol",
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
  const found = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", id!)
    .eq("name", "Patrol · Day")
    .single();
  expect(found.error).toBeNull();
  return found.data!.id;
}

interface ScanArgs {
  token?: string | null;
  id?: string;
  org?: string;
  worker?: string;
  point?: { lat: number; lng: number } | null;
  deviceTime?: Date;
  elapsedMs?: number;
}

function scan(w: Worker, args: ScanArgs = {}) {
  const now = new Date();
  const point = args.point === undefined ? CENTRE : args.point;
  return w.client.rpc("record_checkpoint_scan", {
    p_expected_organisation_id: args.org ?? w.org,
    p_expected_worker_id: args.worker ?? w.id,
    p_client_event_id: args.id ?? randomUUID(),
    p_token: (args.token === undefined ? gate.token : args.token) as string,
    p_device_time: (args.deviceTime ?? now).toISOString(),
    p_sent_device_time: now.toISOString(),
    p_elapsed_ms: args.elapsedMs ?? 0,
    p_latitude: (point?.lat ?? null) as number,
    p_longitude: (point?.lng ?? null) as number,
    p_accuracy_m: 10,
  });
}

interface Scanned {
  id: string;
  duplicate: boolean;
  recorded_at: string;
  geofence_result: string;
  distance_m: number | null;
  flags: string[];
  checkpoint_name: string | null;
  site_name: string | null;
}

async function scanned(w: Worker, args: ScanArgs = {}): Promise<Scanned> {
  const { data, error } = await scan(w, args);
  expect(error).toBeNull();
  return data as unknown as Scanned;
}

async function row(id: string) {
  const { rows } = await db.query("select * from public.punches where id = $1", [id]);
  return rows[0] as Record<string, unknown>;
}

async function countFor(workerId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from public.punches where worker_id = $1",
    [workerId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ck-owner", "Patrol Org");
  other = await createTenantUser("ck-other", "Other Patrol Org");
  staff.hr = await createTestUser("ck-hr");
  staff.ops = await createTestUser("ck-ops");
  staff.lineManager = await createTestUser("ck-lm");
  await addMember(staff.hr, "hr");
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
    .insert([
      {
        organisation_id: owner.orgId,
        client_id: clientId,
        name: "Apapa Warehouse 3",
        centre: `SRID=4326;POINT(${CENTRE.lng} ${CENTRE.lat})`,
        radius_m: 100,
      },
      {
        organisation_id: owner.orgId,
        client_id: clientId,
        name: "Ikeja Mall",
        centre: `SRID=4326;POINT(${CENTRE.lng} ${CENTRE.lat + 0.05})`,
        radius_m: 100,
      },
    ] as never)
    .select("id, name");
  expect(sites.error).toBeNull();
  const byName = new Map((sites.data as { id: string; name: string }[]).map((s) => [s.name, s.id]));
  site = byName.get("Apapa Warehouse 3")!;
  secondSite = byName.get("Ikeja Mall")!;

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

  gate = await addCheckpoint(owner.orgId, site, "Gate B", north(20));
  tower = await addCheckpoint(owner.orgId, site, "Water tower");
  farGate = await addCheckpoint(owner.orgId, secondSite, "Mall gate");
  otherToken = (await addCheckpoint(other.orgId, otherSite, "Their gate")).token;
  post = await liveAllDayPost();
});

afterAll(async () => {
  await db?.end();
});

describe("record_checkpoint_scan: a scan on shift", () => {
  it("records a checkpoint punch at the checkpoint's site, on the worker's shift", async () => {
    const w = await addWorker();
    const assignment = await onShift(w);
    const result = await scanned(w);
    expect(result).toMatchObject({
      duplicate: false,
      geofence_result: "inside",
      checkpoint_name: "Gate B",
      site_name: "Apapa Warehouse 3",
    });
    // From the checkpoint's own pin (20 m north), not the site centre.
    expect(result.distance_m).toBeGreaterThanOrEqual(15);
    expect(result.distance_m).toBeLessThanOrEqual(25);
    expect(result.flags).toEqual([]);
    expect(await row(result.id)).toMatchObject({
      organisation_id: owner.orgId,
      worker_id: w.id,
      recorded_by_user: w.userId,
      kind: "checkpoint",
      source: "self",
      checkpoint_id: gate.id,
      site_id: site,
      shift_assignment_id: assignment,
      selfie_expected: false,
      outside_reason: null,
    });
  });

  it("flags a scan made outside the site, worked out on the server", async () => {
    const w = await addWorker();
    await onShift(w);
    const result = await scanned(w, { token: tower.token, point: north(800) });
    expect(result.geofence_result).toBe("outside");
    expect(result.flags).toContain("outside");
    // No pin on this checkpoint: the distance is from the site centre.
    expect(result.distance_m).toBeGreaterThan(750);
    const none = await scanned(w, { token: tower.token, point: null });
    expect(none.geofence_result).toBe("unknown");
    expect(none.flags).toContain("no_location");
  });

  it("never stores the token: not on the punch, not in its audit row", async () => {
    const w = await addWorker();
    await onShift(w);
    const result = await scanned(w);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log
       where entity_id = $1 and (coalesce(after::text, '') like '%' || $2 || '%'
         or coalesce(before::text, '') like '%' || $2 || '%')`,
      [result.id, gate.token],
    );
    expect(rows[0]!.n).toBe(0);
    const audit = await db.query<{ n: number }>(
      "select count(*)::int as n from public.audit_log where entity_id = $1",
      [result.id],
    );
    expect(audit.rows[0]!.n).toBe(1);
    expect(JSON.stringify(await row(result.id))).not.toContain(gate.token);
  });
});

describe("record_checkpoint_scan: the token stays inside the company", () => {
  it("refuses another company's token, an unknown one, a retired one and garbage alike", async () => {
    const w = await addWorker();
    await onShift(w);
    const retired = await addCheckpoint(owner.orgId, site, "Old fence");
    const off = await staff.ops.client
      .from("site_checkpoints")
      .update({ status: "retired" })
      .eq("id", retired.id);
    expect(off.error).toBeNull();

    const answers = [];
    for (const token of [
      otherToken,
      "f".repeat(64),
      retired.token,
      "not-a-token",
      gate.token.toUpperCase(),
      null,
    ]) {
      const { error } = await scan(w, { token });
      answers.push({ code: error?.code, message: error?.message, details: error?.details ?? null });
    }
    // One answer for every miss: nothing says whether the code exists in another company.
    expect(answers[0]).toMatchObject({ code: "MLCK1" });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(await countFor(w.id)).toBe(0);
  });

  it("refuses a worker who isn't on a shift at that checkpoint's site now", async () => {
    // Mapped to the site but not rostered.
    const free = await addWorker();
    expect((await scan(free)).error?.code).toBe("MLCK2");
    // Rostered at Apapa, scanning a checkpoint at another site of the same company.
    const elsewhere = await addWorker();
    await onShift(elsewhere);
    expect((await scan(elsewhere, { token: farGate.token })).error?.code).toBe("MLCK2");
    // A scan long after the shift (the phone says yesterday) isn't on it either.
    const late = await scan(elsewhere, {
      deviceTime: new Date(Date.now() - 30 * 3_600_000),
      elapsedMs: 30 * 3_600_000,
    });
    expect(late.error?.code).toBe("MLCK2");
    expect(await countFor(free.id)).toBe(0);
    expect(await countFor(elsewhere.id)).toBe(0);
  });
});

describe("record_checkpoint_scan: who may scan", () => {
  it("refuses an untrusted password session and writes nothing", async () => {
    // A worker record with a password login that was never trusted (no PIN, no magic link).
    const { data: worker, error: workerError } = await admin
      .from("workers")
      .insert({
        organisation_id: owner.orgId,
        staff_id: `CKU-${randomUUID().slice(0, 6)}`,
        first_name: "Untrusted",
        last_name: "Guard",
        employment_type: "permanent",
        start_date: "2025-01-06",
      })
      .select("id")
      .single();
    expect(workerError).toBeNull();
    const email = `rls-ck-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const membership = await admin.from("memberships").insert({
      organisation_id: owner.orgId,
      user_id: created.data.user!.id,
      role: "worker",
      worker_id: worker!.id,
    });
    expect(membership.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const { error } = await scan(
      { id: worker!.id, org: owner.orgId, userId: created.data.user!.id, client },
      {},
    );
    expect(error?.code).toBe("42501");
    expect(await countFor(worker!.id)).toBe(0);
    const anon = await anonClient().rpc("record_checkpoint_scan", {} as never);
    expect(anon.error).not.toBeNull();
  });

  it("refuses when the company has Shifts switched off", async () => {
    const w = await addWorker({ orgId: other.orgId, mappedTo: otherSite, inviter: other });
    await db.query("update public.organisations set shifts_enabled = false where id = $1", [
      other.orgId,
    ]);
    try {
      expect((await scan(w, { token: otherToken })).error?.code).toBe("MLPU4");
    } finally {
      await db.query("update public.organisations set shifts_enabled = true where id = $1", [
        other.orgId,
      ]);
    }
  });

  it("refuses a worker who has left", async () => {
    const w = await addWorker();
    await onShift(w);
    await db.query(
      "update public.workers set status = 'ended', end_date = current_date - 1 where id = $1",
      [w.id],
    );
    expect((await scan(w)).error?.code).toBe("MLPU3");
  });

  it("refuses without location consent", async () => {
    const w = await addWorker({ consents: [] });
    await onShift(w);
    expect((await scan(w)).error?.code).toBe("MLPU6");
  });

  it("refuses a queue saved by another worker or for another company", async () => {
    const w = await addWorker();
    const colleague = await addWorker();
    await onShift(w);
    expect((await scan(w, { worker: colleague.id })).error?.code).toBe("MLPU9");
    expect((await scan(w, { org: other.orgId })).error?.code).toBe("MLPU9");
    const { error } = await staff.ops.client.rpc("record_checkpoint_scan", {
      p_expected_organisation_id: owner.orgId,
      p_expected_worker_id: w.id,
      p_client_event_id: randomUUID(),
      p_token: gate.token,
      p_device_time: new Date().toISOString(),
      p_sent_device_time: new Date().toISOString(),
      p_elapsed_ms: 0,
      p_latitude: CENTRE.lat,
      p_longitude: CENTRE.lng,
      p_accuracy_m: 5,
    });
    expect(error?.code).toBe("MLPU1");
  });
});

describe("record_checkpoint_scan: client_event_id per worker", () => {
  it("the same scan twice is one row; a different one under the same id is refused", async () => {
    const w = await addWorker();
    await onShift(w);
    const id = randomUUID();
    const deviceTime = new Date();
    const first = await scanned(w, { id, deviceTime });
    const again = await scanned(w, { id, deviceTime });
    expect(again).toMatchObject({ id: first.id, duplicate: true, checkpoint_name: "Gate B" });
    expect((await scan(w, { id, deviceTime, token: tower.token })).error?.code).toBe("MLPU2");
    // A clock-in under a scan's id is a different punch too.
    const clock = await w.client.rpc("record_punch", {
      p_expected_organisation_id: w.org,
      p_expected_worker_id: w.id,
      p_client_event_id: id,
      p_kind: "in",
      p_device_time: deviceTime.toISOString(),
      p_sent_device_time: new Date().toISOString(),
      p_elapsed_ms: 0,
      p_site_id: site,
      p_latitude: CENTRE.lat,
      p_longitude: CENTRE.lng,
      p_accuracy_m: 10,
      p_outside_reason: null as unknown as string,
      p_outside_note: null as unknown as string,
      p_has_selfie: false,
    });
    expect(clock.error?.code).toBe("MLPU2");
  });

  it("another worker's duplicate id is their own new scan, never the first worker's row", async () => {
    const a = await addWorker();
    const b = await addWorker();
    await onShift(a);
    await onShift(b);
    const id = randomUUID();
    const deviceTime = new Date();
    const first = await scanned(a, { id, deviceTime });
    const second = await scanned(b, { id, deviceTime });
    expect(second.duplicate).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect((await row(second.id)).worker_id).toBe(b.id);
    expect((await row(first.id)).worker_id).toBe(a.id);
  });
});

describe("scans are punches: insert-only, and apart from clock-in and clock-out", () => {
  it("nobody edits or deletes a scan, the database owner included", async () => {
    const w = await addWorker();
    await onShift(w);
    const result = await scanned(w);
    await expect(
      db.query("update public.punches set checkpoint_id = $2 where id = $1", [result.id, tower.id]),
    ).rejects.toMatchObject({ code: "MLPU0" });
    await expect(
      db.query("delete from public.punches where id = $1", [result.id]),
    ).rejects.toMatchObject({ code: "MLPU0" });
    const viaKey = await admin.from("punches").delete().eq("id", result.id);
    expect(viaKey.error).not.toBeNull();
    expect((await row(result.id)).checkpoint_id).toBe(gate.id);
  });

  it("a checkpoint punch needs its checkpoint, and a clock punch can't carry one", async () => {
    const w = await addWorker();
    const insert = (kind: string, checkpoint: string | null) =>
      db.query(
        `insert into public.punches (
           organisation_id, worker_id, kind, recorded_by_user, client_event_id, site_id,
           checkpoint_id, device_time, recorded_at, time_source, clock_drift_seconds,
           geofence_result, payload_hash
         ) values ($1, $2, $3, $4, $5, $6, $7, now(), now(), 'elapsed', 0, 'unknown', md5('x'))`,
        [owner.orgId, w.id, kind, w.userId, randomUUID(), site, checkpoint],
      );
    await expect(insert("checkpoint", null)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("in", gate.id)).rejects.toMatchObject({ code: "23514" });
  });

  it("a scan is never the punch before a clock-out, nor the last punch on the clock screen", async () => {
    const w = await addWorker();
    await onShift(w);
    const clock = (kind: "in" | "out", elapsedMs: number) =>
      w.client.rpc("record_punch", {
        p_expected_organisation_id: w.org,
        p_expected_worker_id: w.id,
        p_client_event_id: randomUUID(),
        p_kind: kind,
        p_device_time: new Date(Date.now() - elapsedMs).toISOString(),
        p_sent_device_time: new Date().toISOString(),
        p_elapsed_ms: elapsedMs,
        p_site_id: site,
        p_latitude: CENTRE.lat,
        p_longitude: CENTRE.lng,
        p_accuracy_m: 10,
        p_outside_reason: null as unknown as string,
        p_outside_note: null as unknown as string,
        p_has_selfie: false,
      });
    expect((await clock("in", 120_000)).error).toBeNull();
    await scanned(w);
    const context = await w.client.rpc("my_clock_context", { p_organisation_id: owner.orgId });
    expect(context.error).toBeNull();
    expect((context.data as { last_punch: { kind: string } }).last_punch.kind).toBe("in");
    const out = await clock("out", 0);
    expect(out.error).toBeNull();
    expect((out.data as { flags: string[] }).flags).not.toContain("out_without_in");
  });
});

describe("who reads scans", () => {
  it("owner and ops read every scan, a line manager only their reportees', another company none", async () => {
    const lm = await admin
      .from("memberships")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("user_id", staff.lineManager.id)
      .single();
    const mine = await addWorker();
    const reportee = await addWorker({ fields: { line_manager_membership_id: lm.data!.id } });
    await onShift(mine);
    await onShift(reportee);
    const a = await scanned(mine);
    const b = await scanned(reportee);
    const read = async (client: Client) =>
      ((await client.from("punches").select("id, checkpoint_id").in("id", [a.id, b.id])).data ??
        []) as { id: string; checkpoint_id: string | null }[];
    expect((await read(owner.client)).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await read(staff.ops.client)).length).toBe(2);
    expect((await read(staff.lineManager.client)).map((r) => r.id)).toEqual([b.id]);
    expect(await read(other.client)).toEqual([]);
    expect((await read(owner.client))[0]!.checkpoint_id).toBe(gate.id);
  });
});
