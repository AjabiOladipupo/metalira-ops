/**
 * Slice 3.6: crew clock-in by a supervisor, against the real database.
 * - record_crew_punch: a worker-supervisor (the line manager of the crew, on shift at the site)
 *   and a line_manager login clock in their own crew only; every punch is source 'supervisor'
 *   with the supervisor's login and the batch, audited. Refused: another company, an untrusted
 *   session, a worker who supervises nobody, someone outside the crew, Shifts off, an ended
 *   worker or supervisor, a supervisor not on shift, a worker not on a shift at the site. A
 *   client_event_id is unique per worker: the same id for another worker is a new punch, the
 *   same id again for the same worker is refused. The same batch twice is one batch.
 * - The group photo is wanted only when everyone in the batch agreed to photos.
 * - crew_punch_batches is insert-only and read by owner, admin, ops_manager, hr and the
 *   supervisor who sent it; my_crew_context lists the crew on shift at the supervisor's site.
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

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"hr" | "ops" | "finance" | "lineManager", TestUser>;
let lineManagerMembership: string;
let clientId: string;
let site: string;
let otherSite: string;
let post: string;
let counter = 0;

interface Worker {
  id: string;
  org: string;
  userId: string;
  client: Client;
}

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** A worker, invited and signed in, with the consents given. */
async function addWorker(
  options: {
    orgId?: string;
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
      staff_id: `CR-${String(counter).padStart(4, "0")}`,
      first_name: "Ngozi",
      last_name: `Eze ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...options.fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const workerId = data!.id;
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

/** Assigns the worker to today's all-day shift at `site`. */
async function assign(workerId: string) {
  const { error } = await staff.ops.client.rpc("assign_worker_to_shift", {
    p_organisation_id: owner.orgId,
    p_post_id: post,
    p_shift_date: lagosToday(),
    p_worker_id: workerId,
  });
  expect(error).toBeNull();
}

/** A worker-supervisor on shift and `size` crew members on shift, all with consents. */
async function crewOf(size: number, consents?: ("location" | "selfie")[]) {
  const supervisor = await addWorker();
  await assign(supervisor.id);
  const crew: Worker[] = [];
  for (let i = 0; i < size; i += 1) {
    const w = await addWorker({
      fields: { line_manager_worker_id: supervisor.id },
      ...(consents ? { consents } : {}),
    });
    await assign(w.id);
    crew.push(w);
  }
  return { supervisor, crew };
}

interface CrewArgs {
  org?: string;
  actor: string;
  batch?: string;
  kind?: "in" | "out";
  site?: string;
  workers: string[];
  events?: string[];
  point?: { lat: number; lng: number } | null;
  photo?: boolean;
  deviceTime?: Date;
}

function crewPunch(client: Client, args: CrewArgs) {
  const now = args.deviceTime ?? new Date();
  return client.rpc("record_crew_punch", {
    p_expected_organisation_id: args.org ?? owner.orgId,
    p_expected_actor_id: args.actor,
    p_client_batch_id: args.batch ?? randomUUID(),
    p_kind: args.kind ?? "in",
    p_site_id: args.site ?? site,
    p_device_time: now.toISOString(),
    p_sent_device_time: now.toISOString(),
    p_elapsed_ms: 0,
    p_worker_ids: args.workers,
    p_client_event_ids: args.events ?? args.workers.map(() => randomUUID()),
    p_latitude: (args.point?.lat ?? null) as number,
    p_longitude: (args.point?.lng ?? null) as number,
    p_accuracy_m: (args.point ? 10 : null) as number,
    p_has_photo: args.photo ?? false,
  });
}

interface Recorded {
  batch_id: string;
  duplicate: boolean;
  count: number;
  photo_wanted: boolean;
  geofence_result: string;
  punches: { worker_id: string; id: string; flags: string[] }[];
}

async function punchesOf(workerIds: string[]) {
  const { rows } = await db.query(
    "select * from public.punches where worker_id = any($1) order by worker_id",
    [workerIds],
  );
  return rows as Record<string, unknown>[];
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("cr-owner", "Crew Org");
  other = await createTenantUser("cr-other", "Other Crew Org");
  staff.hr = await createTestUser("cr-hr");
  staff.ops = await createTestUser("cr-ops");
  staff.finance = await createTestUser("cr-finance");
  staff.lineManager = await createTestUser("cr-lm");
  await addMember(staff.hr, "hr");
  await addMember(staff.ops, "ops_manager");
  await addMember(staff.finance, "finance");
  lineManagerMembership = await addMember(staff.lineManager, "line_manager");

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

  // A contract live from today with one post staffed all day today.
  const today = lagosToday();
  const { data: contract, error } = await staff.ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: "Crew guarding",
      type: "manned_post",
      start_date: today,
    } as Json,
    p_site_ids: [site],
  });
  expect(error).toBeNull();
  const card = await staff.ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: contract!,
    p_effective_from: today,
    p_lines: [{ role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" }] as Json,
  });
  expect(card.error).toBeNull();
  const headcount = await staff.ops.client.from("headcount_requirements").insert({
    organisation_id: owner.orgId,
    contract_id: contract!,
    site_id: site,
    role: "Guard",
    unit: "shift",
    days_of_week: EVERY_DAY,
    required_count: 80,
    post_name: "Floor crew",
    band: "Day",
    start_time: "00:00",
    end_time: "23:45",
  } as never);
  expect(headcount.error).toBeNull();
  const live = await staff.ops.client.rpc("activate_contract", {
    p_organisation_id: owner.orgId,
    p_contract_id: contract!,
    p_send_welcome: false,
  });
  expect(live.error).toBeNull();
  const found = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", contract!)
    .eq("name", "Floor crew · Day")
    .single();
  expect(found.error).toBeNull();
  post = found.data!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("record_crew_punch: a worker-supervisor clocks in their crew", () => {
  it("records one supervisor punch per person, with the batch, the actor and the audit", async () => {
    const { supervisor, crew } = await crewOf(2);
    const ids = crew.map((w) => w.id);
    const { data, error } = await crewPunch(supervisor.client, { actor: supervisor.id, workers: ids });
    expect(error).toBeNull();
    const result = data as unknown as Recorded;
    expect(result).toMatchObject({ duplicate: false, count: 2, photo_wanted: false });
    const rows = await punchesOf(ids);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        organisation_id: owner.orgId,
        kind: "in",
        source: "supervisor",
        recorded_by_user: supervisor.userId,
        crew_batch_id: result.batch_id,
        site_id: site,
        selfie_expected: false,
        geofence_result: "unknown",
      });
      expect(r.shift_assignment_id).not.toBeNull();
      // No group photo and no location: both flagged.
      expect(r.flags).toEqual(expect.arrayContaining(["no_selfie", "no_location"]));
      expect(r.flags).not.toContain("no_shift");
    }
    const { rows: batches } = await db.query(
      "select * from public.crew_punch_batches where id = $1",
      [result.batch_id],
    );
    expect(batches[0]).toMatchObject({
      recorded_by_user: supervisor.userId,
      supervisor_worker_id: supervisor.id,
      worker_count: 2,
      photo_expected: false,
    });
    const { rows: audit } = await db.query(
      "select action, actor_id from public.audit_log where entity_id = $1 or (entity = 'punches' and entity_id = any($2)) order by at",
      [result.batch_id, rows.map((r) => r.id)],
    );
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["crew_punch_batches.insert", "crew.clocked_in", "punches.insert"]),
    );
    for (const a of audit) expect(a.actor_id).toBe(supervisor.userId);
  });

  it("records the supervisor's geofence result with their location consent, never the point", async () => {
    const { supervisor, crew } = await crewOf(1);
    const { data, error } = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [crew[0]!.id],
      point: CENTRE,
    });
    expect(error).toBeNull();
    const result = data as unknown as Recorded;
    expect(result.geofence_result).toBe("inside");
    const [row] = await punchesOf([crew[0]!.id]);
    expect(row).toMatchObject({ geofence_result: "inside", location: null });
    expect(row!.flags).not.toContain("no_location");
  });

  it("refuses a location from a supervisor who hasn't agreed to share it", async () => {
    const supervisor = await addWorker({ consents: [] });
    await assign(supervisor.id);
    const w = await addWorker({ fields: { line_manager_worker_id: supervisor.id } });
    await assign(w.id);
    const { error } = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [w.id],
      point: CENTRE,
    });
    expect(error?.code).toBe("MLPU6");
    // Without the location it is recorded: consent is never needed to clock in a crew.
    expect((await crewPunch(supervisor.client, { actor: supervisor.id, workers: [w.id] })).error).toBeNull();
  });

  it("clocks out a crew later, against their clock-in's shift", async () => {
    const { supervisor, crew } = await crewOf(1);
    const ids = [crew[0]!.id];
    expect((await crewPunch(supervisor.client, { actor: supervisor.id, workers: ids })).error).toBeNull();
    const { data, error } = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      kind: "out",
      workers: ids,
    });
    expect(error).toBeNull();
    const out = (data as unknown as Recorded).punches[0]!;
    expect(out.flags).not.toContain("out_without_in");
    const rows = await punchesOf(ids);
    expect(rows.map((r) => r.kind).sort()).toEqual(["in", "out"]);
    expect(rows[0]!.shift_assignment_id).toBe(rows[1]!.shift_assignment_id);
  });

  it("wants the group photo only when everyone in it agreed to photos", async () => {
    const { supervisor, crew } = await crewOf(1);
    const agreed = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [crew[0]!.id],
      photo: true,
    });
    expect(agreed.error).toBeNull();
    expect((agreed.data as unknown as Recorded).photo_wanted).toBe(true);
    expect((await punchesOf([crew[0]!.id]))[0]!.flags).not.toContain("no_selfie");

    const declined = await addWorker({
      consents: [],
      fields: { line_manager_worker_id: supervisor.id },
    });
    await assign(declined.id);
    const mixed = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [declined.id],
      photo: true,
    });
    expect(mixed.error).toBeNull();
    expect((mixed.data as unknown as Recorded).photo_wanted).toBe(false);
    expect((await punchesOf([declined.id]))[0]!.flags).toContain("no_selfie");
  });
});

describe("record_crew_punch: a line manager login", () => {
  it("clocks in their reportees on shift at the site, with no shift of their own", async () => {
    const reportee = await addWorker({ fields: { line_manager_membership_id: lineManagerMembership } });
    await assign(reportee.id);
    const { error } = await crewPunch(staff.lineManager.client, {
      actor: lineManagerMembership,
      workers: [reportee.id],
    });
    expect(error).toBeNull();
    const [row] = await punchesOf([reportee.id]);
    expect(row).toMatchObject({ source: "supervisor", recorded_by_user: staff.lineManager.id });

    const ctx = await staff.lineManager.client.rpc("my_crew_context", {
      p_organisation_id: owner.orgId,
    });
    expect(ctx.error).toBeNull();
    const value = ctx.data as { actor_kind: string; actor_id: string; sites: { id: string; crew: { worker_id: string; last_kind: string }[] }[] };
    expect(value).toMatchObject({ actor_kind: "line_manager", actor_id: lineManagerMembership });
    const here = value.sites.find((s) => s.id === site);
    expect(here?.crew.find((c) => c.worker_id === reportee.id)?.last_kind).toBe("in");
  });

  it("refuses an untrusted password session", async () => {
    const email = `rls-cr-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const { rows } = await db.query(
      "insert into public.memberships (organisation_id, user_id, role) values ($1, $2, 'line_manager') returning id",
      [owner.orgId, created.data.user!.id],
    );
    const membership = rows[0]!.id as string;
    const reportee = await addWorker({ fields: { line_manager_membership_id: membership } });
    await assign(reportee.id);
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const { error } = await crewPunch(client, { actor: membership, workers: [reportee.id] });
    expect(error?.code).toBe("42501");
    const ctx = await client.rpc("my_crew_context", { p_organisation_id: owner.orgId });
    expect(ctx.error?.code).toBe("MLCR1");
    expect(await punchesOf([reportee.id])).toEqual([]);
  });
});

describe("record_crew_punch: only the supervisor's own crew", () => {
  it("refuses someone outside the crew, and writes nothing for the rest", async () => {
    const { supervisor, crew } = await crewOf(1);
    const stranger = await addWorker();
    await assign(stranger.id);
    const { error } = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [crew[0]!.id, stranger.id],
    });
    expect(error?.code).toBe("MLCR1");
    expect(await punchesOf([crew[0]!.id, stranger.id])).toEqual([]);
  });

  it("refuses a worker who supervises nobody", async () => {
    const plain = await addWorker();
    await assign(plain.id);
    const colleague = await addWorker();
    await assign(colleague.id);
    const { error } = await crewPunch(plain.client, { actor: plain.id, workers: [colleague.id] });
    expect(error?.code).toBe("MLCR1");
    const ctx = await plain.client.rpc("my_crew_context", { p_organisation_id: owner.orgId });
    expect(ctx.error).toBeNull();
    expect((ctx.data as { crew_size: number }).crew_size).toBe(0);
  });

  it("refuses another company: its queue, its site and its supervisors", async () => {
    const { supervisor, crew } = await crewOf(1);
    const ids = [crew[0]!.id];
    // A queue that says it belongs to another company is never recorded under this login.
    expect(
      (await crewPunch(supervisor.client, { org: other.orgId, actor: supervisor.id, workers: ids }))
        .error?.code,
    ).toBe("MLPU9");
    // Another company's site.
    expect(
      (await crewPunch(supervisor.client, { actor: supervisor.id, workers: ids, site: otherSite }))
        .error?.code,
    ).toBe("MLPU7");
    // A supervisor in another company can't reach this crew.
    const outsider = await addWorker({ orgId: other.orgId, inviter: other });
    const { error } = await crewPunch(outsider.client, {
      org: other.orgId,
      actor: outsider.id,
      workers: ids,
      site: otherSite,
    });
    expect(error?.code).toBe("MLCR1");
    expect(await punchesOf(ids)).toEqual([]);
  });

  it("refuses a manager login that isn't a line manager", async () => {
    const { crew } = await crewOf(1);
    const { error } = await crewPunch(staff.ops.client, {
      actor: randomUUID(),
      workers: [crew[0]!.id],
    });
    expect(error?.code).toBe("MLCR1");
  });

  it("refuses a supervisor not on shift, and a worker not on a shift at the site", async () => {
    const offShift = await addWorker();
    const w = await addWorker({ fields: { line_manager_worker_id: offShift.id } });
    await assign(w.id);
    expect((await crewPunch(offShift.client, { actor: offShift.id, workers: [w.id] })).error?.code).toBe(
      "MLCR2",
    );

    const { supervisor } = await crewOf(0);
    const unrostered = await addWorker({ fields: { line_manager_worker_id: supervisor.id } });
    expect(
      (await crewPunch(supervisor.client, { actor: supervisor.id, workers: [unrostered.id] })).error
        ?.code,
    ).toBe("MLCR3");
  });
});

describe("record_crew_punch: switches and leavers", () => {
  it("refuses when Shifts is off", async () => {
    const { supervisor, crew } = await crewOf(1);
    await db.query("update public.organisations set shifts_enabled = false where id = $1", [
      owner.orgId,
    ]);
    try {
      const { error } = await crewPunch(supervisor.client, {
        actor: supervisor.id,
        workers: [crew[0]!.id],
      });
      expect(error?.code).toBe("MLPU4");
    } finally {
      await db.query("update public.organisations set shifts_enabled = true where id = $1", [
        owner.orgId,
      ]);
    }
    expect(await punchesOf([crew[0]!.id])).toEqual([]);
  });

  it("refuses an ended worker and an ended supervisor", async () => {
    const { supervisor, crew } = await crewOf(2);
    await db.query(
      "update public.workers set status = 'ended', end_date = current_date - 1 where id = $1",
      [crew[1]!.id],
    );
    expect(
      (await crewPunch(supervisor.client, { actor: supervisor.id, workers: crew.map((w) => w.id) }))
        .error?.code,
    ).toBe("MLPU3");
    expect(await punchesOf(crew.map((w) => w.id))).toEqual([]);
    await db.query(
      "update public.workers set status = 'ended', end_date = current_date - 1 where id = $1",
      [supervisor.id],
    );
    expect(
      (await crewPunch(supervisor.client, { actor: supervisor.id, workers: [crew[0]!.id] })).error
        ?.code,
    ).toBe("MLPU3");
  });
});

describe("record_crew_punch: idempotency", () => {
  it("the same batch twice is one batch", async () => {
    const { supervisor, crew } = await crewOf(2);
    const args: CrewArgs = {
      actor: supervisor.id,
      batch: randomUUID(),
      workers: crew.map((w) => w.id),
      events: crew.map(() => randomUUID()),
      deviceTime: new Date(),
    };
    const first = await crewPunch(supervisor.client, args);
    expect(first.error).toBeNull();
    const again = await crewPunch(supervisor.client, args);
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({
      batch_id: (first.data as unknown as Recorded).batch_id,
      duplicate: true,
      count: 2,
    });
    expect(await punchesOf(crew.map((w) => w.id))).toHaveLength(2);
    // A different batch under the same id is refused.
    expect(
      (await crewPunch(supervisor.client, { ...args, workers: [crew[0]!.id], events: [args.events![0]!] }))
        .error?.code,
    ).toBe("MLPU2");
  });

  it("a client_event_id is per worker: another worker's id is a new punch, the same worker's is refused", async () => {
    const { supervisor, crew } = await crewOf(2);
    const [a, b] = crew as [Worker, Worker];
    const shared = randomUUID();
    const first = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [a.id],
      events: [shared],
    });
    expect(first.error).toBeNull();
    const forB = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [b.id],
      events: [shared],
    });
    expect(forB.error).toBeNull();
    expect(await punchesOf([a.id, b.id])).toHaveLength(2);
    const againForA = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      kind: "out",
      workers: [a.id],
      events: [shared],
    });
    expect(againForA.error?.code).toBe("MLPU2");
  });

  it("refuses a batch with the same person twice or no one", async () => {
    const { supervisor, crew } = await crewOf(1);
    const id = crew[0]!.id;
    expect(
      (await crewPunch(supervisor.client, { actor: supervisor.id, workers: [id, id] })).error?.code,
    ).toBe("MLPU5");
    expect((await crewPunch(supervisor.client, { actor: supervisor.id, workers: [] })).error?.code).toBe(
      "MLPU5",
    );
  });
});

describe("crew_punch_batches", () => {
  it("is insert-only for everyone, the database owner included", async () => {
    const { supervisor, crew } = await crewOf(1);
    const { data } = await crewPunch(supervisor.client, { actor: supervisor.id, workers: [crew[0]!.id] });
    const batch = (data as unknown as Recorded).batch_id;
    await expect(
      db.query("update public.crew_punch_batches set kind = 'out' where id = $1", [batch]),
    ).rejects.toMatchObject({ code: "MLPU0" });
    await expect(
      db.query("delete from public.crew_punch_batches where id = $1", [batch]),
    ).rejects.toMatchObject({ code: "MLPU0" });
    const viaKey = await admin.from("crew_punch_batches").update({ kind: "out" }).eq("id", batch);
    expect(viaKey.error).not.toBeNull();
    // A punch can't be moved into or out of a batch.
    const [row] = await punchesOf([crew[0]!.id]);
    await expect(
      db.query("update public.punches set crew_batch_id = null where id = $1", [row!.id]),
    ).rejects.toMatchObject({ code: "MLPU0" });
  });

  it("is read by owner, ops, hr and the supervisor who sent it; not by finance or a crew member", async () => {
    const { supervisor, crew } = await crewOf(1);
    const { data } = await crewPunch(supervisor.client, { actor: supervisor.id, workers: [crew[0]!.id] });
    const batch = (data as unknown as Recorded).batch_id;
    const sees = async (client: Client) =>
      ((await client.from("crew_punch_batches").select("id").eq("id", batch)).data ?? []).length;
    expect(await sees(owner.client)).toBe(1);
    expect(await sees(staff.ops.client)).toBe(1);
    expect(await sees(staff.hr.client)).toBe(1);
    expect(await sees(supervisor.client)).toBe(1);
    expect(await sees(staff.finance.client)).toBe(0);
    expect(await sees(crew[0]!.client)).toBe(0);
    expect(await sees(other.client)).toBe(0);
    // The crew member still reads their own punch.
    const own = await crew[0]!.client.from("punches").select("id, source, crew_batch_id");
    expect(own.data).toEqual([expect.objectContaining({ source: "supervisor", crew_batch_id: batch })]);
  });

  it("only the server attaches a group photo", async () => {
    const { supervisor, crew } = await crewOf(1);
    const { data } = await crewPunch(supervisor.client, {
      actor: supervisor.id,
      workers: [crew[0]!.id],
      photo: true,
    });
    const batch = (data as unknown as Recorded).batch_id;
    const asSupervisor = await supervisor.client.rpc("attach_crew_photo", {
      p_batch_id: batch,
      p_actor: supervisor.userId,
      p_path: `${owner.orgId}/2026-11/${batch}.webp`,
    });
    expect(asSupervisor.error).not.toBeNull();
    // The secret key with no such object in Storage: refused as not stated.
    const { rows } = await db.query(
      "select to_char(created_at at time zone 'UTC', 'YYYY-MM') as m from public.crew_punch_batches where id = $1",
      [batch],
    );
    const missing = await admin.rpc("attach_crew_photo", {
      p_batch_id: batch,
      p_actor: supervisor.userId,
      p_path: `${owner.orgId}/${rows[0]!.m}/${batch}.webp`,
    });
    expect(missing.error?.code).toBe("MLPS2");
    // Another login as the actor.
    const wrongActor = await admin.rpc("attach_crew_photo", {
      p_batch_id: batch,
      p_actor: crew[0]!.userId,
      p_path: `${owner.orgId}/${rows[0]!.m}/${batch}.webp`,
    });
    expect(wrongActor.error?.code).toBe("MLPS1");
  });
});

describe("my_crew_context", () => {
  it("lists the crew on shift at the supervisor's site, with consent and last punch", async () => {
    const { supervisor, crew } = await crewOf(2, ["location"]);
    expect((await crewPunch(supervisor.client, { actor: supervisor.id, workers: [crew[0]!.id] })).error).toBeNull();
    const { data, error } = await supervisor.client.rpc("my_crew_context", {
      p_organisation_id: owner.orgId,
    });
    expect(error).toBeNull();
    const ctx = data as {
      actor_kind: string;
      actor_id: string;
      crew_size: number;
      location_consent: boolean;
      sites: { id: string; shift: unknown; crew: { worker_id: string; selfie_consent: boolean; last_kind: string | null }[] }[];
    };
    expect(ctx).toMatchObject({ actor_kind: "worker", actor_id: supervisor.id, crew_size: 2, location_consent: true });
    expect(ctx.sites).toHaveLength(1);
    expect(ctx.sites[0]!.shift).not.toBeNull();
    const byId = new Map(ctx.sites[0]!.crew.map((c) => [c.worker_id, c]));
    expect(byId.get(crew[0]!.id)).toMatchObject({ selfie_consent: false, last_kind: "in" });
    expect(byId.get(crew[1]!.id)).toMatchObject({ last_kind: null });
  });
});
