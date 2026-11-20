/**
 * Slice 3.3: publishing rosters against the real database.
 * - publish_roster inserts version 1, 2, ... with a snapshot of ids and times and the counts; its
 *   dry run writes nothing; a republish with nothing changed is refused (MLRP2); a week that has
 *   passed is refused (MLRP1); each publish is audited as roster.published.
 * - The diff names each affected worker once: added, removed (taken off every shift) or changed.
 *   A time change on the same shift is "changed" (roster_snapshot_diff).
 * - roster_publication_status lists the post-days changed since the latest version.
 * - Wrong roles, another company and anonymous callers are refused; publications are insert only.
 * - my_published_shifts gives a worker only their own shifts that are published and still
 *   assigned, with post and site names; nothing unpublished and nothing of anyone else's.
 * - From the 3.2 verification review: an untrusted password session, a finance member and a
 *   line manager of another company read no shifts or assignments.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";
import { toPublicationStatus, toPublishResult } from "@/lib/roster-publish";
import type { Database, Json } from "@/types/db";

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

const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let hr: TestUser;
let finance: TestUser;
let apapa: string;
let otherSite: string;
const post = {} as Record<"day" | "night", string>;
const worker = {} as Record<"a" | "b" | "c", string>;
let counter = 0;

const today = lagosToday();
/** Next Monday (never today). */
const monday = addDays(today, 8 - isoWeekday(today));
const day = (n: number) => addDays(monday, n);

async function addMember(orgId: string, user: TestUser, role: Role, workerId?: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId ?? null });
  expect(error).toBeNull();
}

async function addWorker(orgId: string, name: string, site: string | null): Promise<string> {
  counter += 1;
  const [first, last] = name.split(" ");
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `RP-${String(counter).padStart(4, "0")}`,
      first_name: first!,
      last_name: last!,
      employment_type: "permanent",
      start_date: "2025-01-06",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  if (site) {
    const map = await admin.from("worker_assignments").insert({
      organisation_id: orgId,
      worker_id: data!.id,
      site_id: site,
      effective_from: "2025-01-06",
    });
    expect(map.error).toBeNull();
  }
  return data!.id;
}

/** An invited worker who has set a PIN, with a session opened the way the server does it. */
async function workerSession(workerId: string): Promise<Client> {
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
  return client;
}

/** A client, site and contract live from today with Gate A · Day and Night, as `by`. */
async function liveSite(by: Client, orgId: string, siteName: string) {
  const client = await by.rpc("create_client", {
    p_organisation_id: orgId,
    p_name: `Coastline ${siteName}`,
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(client.error).toBeNull();
  const site = await admin
    .from("sites")
    .insert({
      organisation_id: orgId,
      client_id: client.data!,
      name: siteName,
      centre: CENTRE,
    } as never)
    .select("id")
    .single();
  expect(site.error).toBeNull();
  const siteId = site.data!.id;
  const { data: contractId, error } = await by.rpc("create_contract", {
    p_organisation_id: orgId,
    p_contract: {
      client_id: client.data!,
      name: "Coastline guarding",
      type: "manned_post",
      start_date: today,
    } as Json,
    p_site_ids: [siteId],
  });
  expect(error).toBeNull();
  const card = await by.rpc("save_draft_rate_card", {
    p_organisation_id: orgId,
    p_contract_id: contractId!,
    p_effective_from: today,
    p_lines: ["Day", "Night"].map((band) => ({
      role: "Guard",
      band,
      unit: "shift",
      rate_kobo: "1250000",
    })) as Json,
  });
  expect(card.error).toBeNull();
  for (const [band, start, end] of [
    ["Day", "06:00", "18:00"],
    ["Night", "18:00", "06:00"],
  ] as const) {
    const row = await by.from("headcount_requirements").insert({
      organisation_id: orgId,
      contract_id: contractId!,
      site_id: siteId,
      role: "Guard",
      unit: "shift",
      days_of_week: EVERY_DAY,
      required_count: 1,
      post_name: "Gate A",
      band,
      start_time: start,
      end_time: end,
    } as never);
    expect(row.error).toBeNull();
  }
  const live = await by.rpc("activate_contract", {
    p_organisation_id: orgId,
    p_contract_id: contractId!,
    p_send_welcome: false,
  });
  expect(live.error).toBeNull();
  const posts = await admin.from("posts").select("id, name").eq("contract_id", contractId!);
  expect(posts.error).toBeNull();
  const byName = (name: string) => posts.data!.find((p) => p.name === name)!.id;
  return { siteId, day: byName("Gate A · Day"), night: byName("Gate A · Night") };
}

function assign(postId: string, date: string, workerId: string, by: Client = ops.client) {
  return by.rpc("assign_worker_to_shift", {
    p_organisation_id: owner.orgId,
    p_post_id: postId,
    p_shift_date: date,
    p_worker_id: workerId,
  });
}

async function assigned(postId: string, date: string, workerId: string): Promise<string> {
  const { data, error } = await assign(postId, date, workerId);
  expect(error).toBeNull();
  return String((data as { assignment_id: string }).assignment_id);
}

function publish(
  opts: { week?: string; dryRun?: boolean; by?: Client; org?: string; site?: string } = {},
) {
  return (opts.by ?? ops.client).rpc("publish_roster", {
    p_organisation_id: opts.org ?? owner.orgId,
    p_site_id: opts.site ?? apapa,
    p_week_start: opts.week ?? monday,
    p_dry_run: opts.dryRun ?? false,
  });
}

async function publications(): Promise<number> {
  const { count } = await admin
    .from("roster_publications")
    .select("id", { count: "exact", head: true })
    .eq("site_id", apapa);
  return count ?? 0;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("rp-owner", "Publish Org");
  other = await createTenantUser("rp-other", "Other Publish Org");
  ops = await createTestUser("rp-ops", "Tunde Ops");
  hr = await createTestUser("rp-hr", "Hauwa HR");
  finance = await createTestUser("rp-finance", "Funmi Finance");
  await addMember(owner.orgId, ops, "ops_manager");
  await addMember(owner.orgId, hr, "hr");
  await addMember(owner.orgId, finance, "finance");

  const a = await liveSite(ops.client, owner.orgId, "Apapa Warehouse 3");
  apapa = a.siteId;
  post.day = a.day;
  post.night = a.night;
  worker.a = await addWorker(owner.orgId, "Musa Ibrahim", apapa);
  worker.b = await addWorker(owner.orgId, "Daniel Okafor", apapa);
  worker.c = await addWorker(owner.orgId, "Sule Musa", apapa);

  // Another company with a live site and one shift on it.
  const b = await liveSite(other.client, other.orgId, "Ikeja Depot");
  otherSite = b.siteId;
  const otherWorker = await addWorker(other.orgId, "Ade Bola", otherSite);
  const theirs = await other.client.rpc("assign_worker_to_shift", {
    p_organisation_id: other.orgId,
    p_post_id: b.day,
    p_shift_date: day(0),
    p_worker_id: otherWorker,
  });
  expect(theirs.error).toBeNull();
});

afterAll(async () => {
  await db?.end();
});

describe("publish_roster", () => {
  it("previews without writing, publishes version 1 with ids only, and refuses a republish with nothing changed", async () => {
    await assigned(post.day, day(0), worker.a);
    await assigned(post.night, day(0), worker.b);

    const preview = await publish({ dryRun: true });
    expect(preview.error).toBeNull();
    const p = toPublishResult(preview.data);
    expect(p).toMatchObject({
      dryRun: true,
      version: 1,
      previousVersion: null,
      publicationId: null,
      assigned: 2,
      open: 12,
      counts: { added: 2, removed: 0, changed: 0 },
    });
    expect(await publications()).toBe(0);

    const done = await publish();
    expect(done.error).toBeNull();
    const r = toPublishResult(done.data);
    expect(r).toMatchObject({ version: 1, assigned: 2, open: 12, siteName: "Apapa Warehouse 3" });
    expect(r.publicationId).not.toBeNull();
    expect(r.affected.map((x) => [x.workerId, x.kind]).sort()).toEqual(
      [
        [worker.a, "added"],
        [worker.b, "added"],
      ].sort(),
    );
    const musa = r.affected.find((x) => x.workerId === worker.a)!;
    expect(musa.shifts).toEqual([
      expect.objectContaining({ date: day(0), postName: "Gate A · Day" }),
    ]);
    expect(Date.parse(musa.shifts[0]!.startsAt)).toBe(
      new Date(`${day(0)}T06:00:00+01:00`).getTime(),
    );

    const row = await admin
      .from("roster_publications")
      .select("version, week_start, snapshot, assigned_count, open_count, published_by")
      .eq("id", r.publicationId!)
      .single();
    expect(row.data).toMatchObject({
      version: 1,
      week_start: monday,
      assigned_count: 2,
      open_count: 12,
      published_by: ops.id,
    });
    const snapshot = row.data!.snapshot as Record<string, unknown>[];
    expect(snapshot).toHaveLength(2);
    for (const item of snapshot) {
      expect(Object.keys(item).sort()).toEqual(["a", "d", "from", "p", "s", "to", "w"]);
    }

    const audit = await admin
      .from("audit_log")
      .select("after, actor_id, entity")
      .eq("organisation_id", owner.orgId)
      .eq("action", "roster.published")
      .eq("entity_id", r.publicationId!);
    expect(audit.data).toHaveLength(1);
    expect(audit.data![0]!).toMatchObject({ actor_id: ops.id, entity: "roster_publications" });
    expect(audit.data![0]!.after).toMatchObject({ version: 1, assigned: 2, open: 12 });

    const again = await publish();
    expect(again.error?.code).toBe("MLRP2");
    const dry = await publish({ dryRun: true });
    expect(toPublishResult(dry.data)).toMatchObject({ nothingChanged: true, affected: [] });
    expect(await publications()).toBe(1);
  });

  it("marks changes since publish, then republishes only the workers whose shifts changed", async () => {
    // Musa moves from the day shift to the night shift on day 1; Daniel is taken off; Sule joins.
    const { data: rows } = await admin
      .from("shift_assignments")
      .select("id, worker_id")
      .eq("organisation_id", owner.orgId)
      .eq("status", "assigned")
      .in("worker_id", [worker.a, worker.b]);
    for (const row of rows!) {
      const removed = await ops.client.rpc("remove_assignment", {
        p_organisation_id: owner.orgId,
        p_assignment_id: row.id,
      });
      expect(removed.error).toBeNull();
    }
    await assigned(post.night, day(1), worker.a);
    await assigned(post.day, day(2), worker.c);

    const status = await ops.client.rpc("roster_publication_status", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: monday,
    });
    expect(status.error).toBeNull();
    const s = toPublicationStatus(status.data);
    expect(s.version).toBe(1);
    expect(s.workersAffected).toBe(3);
    expect(new Set(s.changed)).toEqual(
      new Set([
        `${post.day}|${day(0)}`,
        `${post.night}|${day(0)}`,
        `${post.night}|${day(1)}`,
        `${post.day}|${day(2)}`,
      ]),
    );

    const done = await publish();
    expect(done.error).toBeNull();
    const r = toPublishResult(done.data);
    expect(r).toMatchObject({
      version: 2,
      previousVersion: 1,
      assigned: 2,
      counts: { added: 1, removed: 1, changed: 1 },
    });
    const kinds = Object.fromEntries(r.affected.map((x) => [x.workerId, x.kind]));
    expect(kinds).toEqual({ [worker.a]: "changed", [worker.b]: "removed", [worker.c]: "added" });
    expect(r.affected.find((x) => x.workerId === worker.b)!.shifts).toEqual([]);

    const after = toPublicationStatus(
      (
        await ops.client.rpc("roster_publication_status", {
          p_organisation_id: owner.orgId,
          p_site_id: apapa,
          p_week_start: monday,
        })
      ).data,
    );
    expect(after).toMatchObject({ version: 2, workersAffected: 0, changed: [] });
  });

  it("calls the same shift at a new time changed", async () => {
    const w = crypto.randomUUID();
    const s = crypto.randomUUID();
    const p = crypto.randomUUID();
    const item = (from: string) => ({ a: crypto.randomUUID(), w, s, p, d: day(3), from, to: "x" });
    const { rows } = await db.query<{ worker_id: string; kind: string }>(
      "select worker_id, kind from private.roster_snapshot_diff($1::jsonb, $2::jsonb)",
      [
        JSON.stringify([{ ...item(`${day(3)}T05:00:00Z`), to: `${day(3)}T17:00:00Z` }]),
        JSON.stringify([{ ...item(`${day(3)}T06:00:00Z`), to: `${day(3)}T18:00:00Z` }]),
      ],
    );
    expect(rows).toEqual([{ worker_id: w, kind: "changed" }]);
    const same = await db.query(
      "select * from private.roster_snapshot_diff($1::jsonb, $1::jsonb)",
      [JSON.stringify([{ ...item(`${day(3)}T05:00:00Z`), to: `${day(3)}T17:00:00Z` }])],
    );
    expect(same.rows).toEqual([]);
  });

  it("refuses a week that has passed and a day that isn't Monday", async () => {
    expect((await publish({ week: addDays(monday, -14) })).error?.code).toBe("MLRP1");
    expect((await publish({ week: addDays(monday, -14), dryRun: true })).error?.code).toBe("MLRP1");
    expect((await publish({ week: addDays(monday, 1) })).error?.code).toBe("22023");
  });

  it("refuses the wrong roles, another company and anonymous callers", async () => {
    const lm = await createTestUser("rp-lm");
    await addMember(owner.orgId, lm, "line_manager");
    for (const by of [hr.client, finance.client, lm.client, other.client]) {
      expect((await publish({ by })).error?.code).toBe("42501");
      expect((await publish({ by, dryRun: true })).error?.code).toBe("42501");
      const status = await by.rpc("roster_publication_status", {
        p_organisation_id: owner.orgId,
        p_site_id: apapa,
        p_week_start: monday,
      });
      expect(status.error?.code).toBe("42501");
      expect((await by.from("roster_publications").select("id")).data).toEqual([]);
    }
    // Its own organisation with our site: not found.
    expect((await publish({ by: other.client, org: other.orgId })).error?.code).toBe("P0002");
    expect((await publish({ by: anonClient() })).error).not.toBeNull();
    expect(await publications()).toBe(2);
  });

  it("keeps publications insert only, even for the database owner", async () => {
    const { data } = await admin
      .from("roster_publications")
      .select("id")
      .eq("site_id", apapa)
      .limit(1)
      .single();
    await expect(
      db.query("update public.roster_publications set open_count = 0 where id = $1", [data!.id]),
    ).rejects.toThrow(/never changes/);
    await expect(
      db.query("delete from public.roster_publications where id = $1", [data!.id]),
    ).rejects.toThrow(/never changes/);
    // TRUNCATE skips row triggers: a statement trigger refuses it (CASCADE gets past the
    // inbox_items foreign key and still stops there).
    await expect(db.query("truncate public.roster_publications cascade")).rejects.toThrow(
      /never changes/,
    );
    await expect(db.query("truncate public.roster_publications")).rejects.toThrow();
    // The secret key may insert (registry seeds) but not change, delete or truncate.
    const patched = await admin
      .from("roster_publications")
      .update({ open_count: 0 })
      .eq("id", data!.id);
    expect(patched.error?.code).toBe("42501");
    const deleted = await admin.from("roster_publications").delete().eq("id", data!.id);
    expect(deleted.error?.code).toBe("42501");
    const { rows } = await db.query<{ update: boolean; delete: boolean; truncate: boolean }>(
      `select has_table_privilege('service_role', 'public.roster_publications', 'UPDATE') as update,
              has_table_privilege('service_role', 'public.roster_publications', 'DELETE') as delete,
              has_table_privilege('service_role', 'public.roster_publications', 'TRUNCATE') as truncate`,
    );
    expect(rows[0]).toEqual({ update: false, delete: false, truncate: false });
    expect(await publications()).toBe(2);
    const write = await ops.client
      .from("roster_publications")
      .insert({ organisation_id: owner.orgId, site_id: apapa, week_start: monday, version: 9 });
    expect(write.error?.code).toBe("42501");
  });
});

describe("my_published_shifts", () => {
  it("gives a worker only their own published, still-assigned shifts with post and site names", async () => {
    // After version 2: Musa on Gate A · Night day 1, Sule on Gate A · Day day 2.
    const musa = await workerSession(worker.a);
    const shifts = await musa.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(shifts.error).toBeNull();
    expect(shifts.data).toEqual([
      expect.objectContaining({
        organisation_id: owner.orgId,
        shift_date: day(1),
        post_name: "Gate A · Night",
        site_name: "Apapa Warehouse 3",
      }),
    ]);
    expect(Date.parse(shifts.data![0]!.starts_at)).toBe(
      new Date(`${day(1)}T18:00:00+01:00`).getTime(),
    );

    // Assigned after the publish: not on the phone until the next publish.
    const unpublished = await assigned(post.day, day(4), worker.a);
    const still = await musa.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(still.data!.map((r) => r.shift_date)).toEqual([day(1)]);
    expect(still.data!.map((r) => r.assignment_id)).not.toContain(unpublished);

    // Taken off the published shift: gone at once.
    const published = still.data![0]!.assignment_id;
    const removed = await ops.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: published,
    });
    expect(removed.error).toBeNull();
    const gone = await musa.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(gone.data).toEqual([]);

    // Republished: the day 4 shift shows.
    expect((await publish()).error).toBeNull();
    const now = await musa.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(now.data!.map((r) => [r.shift_date, r.post_name])).toEqual([[day(4), "Gate A · Day"]]);

    // Nothing else: no publications, no other worker's rows, no other company's.
    expect((await musa.from("roster_publications").select("id")).data).toEqual([]);
    const sule = await workerSession(worker.c);
    const theirs = await sule.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(theirs.data!.map((r) => r.shift_date)).toEqual([day(2)]);

    expect(
      (await musa.rpc("my_published_shifts", { p_from: monday, p_to: addDays(monday, 70) })).error
        ?.code,
    ).toBe("22023");
  });

  it("returns nothing to a manager with no worker record or to an anonymous caller", async () => {
    const mine = await ops.client.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(mine.error).toBeNull();
    expect(mine.data).toEqual([]);
    const anon = await anonClient().rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(anon.error).not.toBeNull();
  });
});

describe("who reads shifts (3.2 verification review)", () => {
  async function untrusted(label: string) {
    const email = `rls-${label}-${crypto.randomUUID()}@example.test`;
    const password = `${crypto.randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    return { id: created.data.user!.id, email, client };
  }

  async function counts(client: Client) {
    const shifts = (await client.from("shifts").select("id")).data ?? [];
    const rows = (await client.from("shift_assignments").select("id")).data ?? [];
    return { shifts: shifts.length, assignments: rows.length };
  }

  it("an untrusted password session sees no shifts or assignments until it is trusted", async () => {
    const manager = await untrusted("rp-untrusted-ops");
    await addMember(owner.orgId, manager, "ops_manager");
    const guard = await addWorker(owner.orgId, "Bayo Kola", apapa);
    await assigned(post.night, day(3), guard);
    const own = await untrusted("rp-untrusted-worker");
    await addMember(owner.orgId, own, "worker", guard);
    expect(await counts(manager.client)).toEqual({ shifts: 0, assignments: 0 });
    expect(await counts(own.client)).toEqual({ shifts: 0, assignments: 0 });
    const published = await own.client.rpc("my_published_shifts", {
      p_from: monday,
      p_to: day(6),
    });
    expect(published.data).toEqual([]);

    // Positive control: the same tokens read once the password is trusted.
    await markPasswordTrusted(manager.id);
    await markPasswordTrusted(own.id);
    expect((await counts(manager.client)).assignments).toBeGreaterThan(0);
    expect((await counts(own.client)).assignments).toBeGreaterThan(0);
  });

  it("an untrusted ops manager can't publish, preview or read the status", async () => {
    const manager = await untrusted("rp-untrusted-publisher");
    await addMember(owner.orgId, manager, "ops_manager");
    expect((await publish({ by: manager.client })).error?.code).toBe("42501");
    expect((await publish({ by: manager.client, dryRun: true })).error?.code).toBe("42501");
    const status = await manager.client.rpc("roster_publication_status", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: monday,
    });
    expect(status.error?.code).toBe("42501");
    const targets = await manager.client.rpc("roster_notice_targets", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: monday,
    });
    expect(targets.error?.code).toBe("42501");
  });

  it("a finance member sees none", async () => {
    expect(await counts(finance.client)).toEqual({ shifts: 0, assignments: 0 });
  });

  it("a line manager whose own worker is mapped to a site here sees no other company's shifts", async () => {
    const lmWorker = await addWorker(owner.orgId, "Lami Supervisor", apapa);
    const lm = await createTestUser("rp-lm-mapped");
    await addMember(owner.orgId, lm, "line_manager", lmWorker);
    const shifts = await lm.client.from("shifts").select("organisation_id, site_id");
    expect(shifts.error).toBeNull();
    expect(shifts.data!.length).toBeGreaterThan(0);
    expect(new Set(shifts.data!.map((s) => s.organisation_id))).toEqual(new Set([owner.orgId]));
    expect(shifts.data!.map((s) => s.site_id)).not.toContain(otherSite);
    const rows = await lm.client.from("shift_assignments").select("organisation_id");
    expect(rows.data!.every((r) => r.organisation_id === owner.orgId)).toBe(true);
  });
});

describe("roster_notice_targets (send notices again)", () => {
  function targets(by: Client = ops.client, week = monday) {
    return by.rpc("roster_notice_targets", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: week,
    });
  }

  it("lists the latest version's affected workers with no message for it, and skips those told", async () => {
    const first = toPublishResult((await targets()).data);
    const { data: latest } = await admin
      .from("roster_publications")
      .select("id, version")
      .eq("site_id", apapa)
      .eq("week_start", monday)
      .order("version", { ascending: false })
      .limit(1)
      .single();
    expect(first.publicationId).toBe(latest!.id);
    expect(first.version).toBe(latest!.version);
    expect(first.affected.length).toBeGreaterThan(0);

    // Tell the first one; they drop off. A second message for the same version is refused.
    const told = first.affected[0]!.workerId;
    await db.query(
      "insert into public.inbox_items (organisation_id, worker_id, kind, title, body, roster_publication_id) values ($1, $2, 'shift_published', 'Your shifts', 'Ready', $3)",
      [owner.orgId, told, latest!.id],
    );
    const second = toPublishResult((await targets()).data);
    expect(second.affected.map((a) => a.workerId)).not.toContain(told);
    expect(second.affected).toHaveLength(first.affected.length - 1);
    await expect(
      db.query(
        "insert into public.inbox_items (organisation_id, worker_id, kind, title, body, roster_publication_id) values ($1, $2, 'shift_published', 'Again', 'Again', $3)",
        [owner.orgId, told, latest!.id],
      ),
    ).rejects.toThrow(/inbox_items_publication_worker_key/);
  });

  it("refuses a week never published, the wrong roles and another company", async () => {
    expect((await targets(ops.client, addDays(monday, 7))).error?.code).toBe("MLRP3");
    for (const by of [hr.client, finance.client, other.client]) {
      expect((await targets(by)).error?.code).toBe("42501");
    }
    expect((await targets(anonClient())).error).not.toBeNull();
  });
});

describe("my_published_shifts when the worker or the company stops", () => {
  it("gives a worker ended through end_employment nothing, while the shift is still published", async () => {
    const kemi = await addWorker(owner.orgId, "Kemi Ade", apapa);
    const assignment = await assigned(post.day, day(5), kemi);
    expect((await publish()).error).toBeNull();
    const phone = await workerSession(kemi);
    const before = await phone.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(before.data!.map((r) => r.assignment_id)).toEqual([assignment]);

    const ended = await hr.client.rpc("end_employment", {
      p_organisation_id: owner.orgId,
      p_worker_id: kemi,
      p_end_date: today,
    });
    expect(ended.error).toBeNull();
    const { data: row } = await admin
      .from("shift_assignments")
      .select("status")
      .eq("id", assignment)
      .single();
    expect(row!.status).toBe("assigned");
    const after = await phone.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(after.data).toEqual([]);
  });

  it("gives nothing while the company has Shifts switched off", async () => {
    const tobi = await addWorker(owner.orgId, "Tobi Lawal", apapa);
    await assigned(post.night, day(6), tobi);
    expect((await publish()).error).toBeNull();
    const sule = await workerSession(tobi);
    const on = await sule.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
    expect(on.data!.length).toBeGreaterThan(0);
    await db.query("update public.organisations set shifts_enabled = false where id = $1", [
      owner.orgId,
    ]);
    try {
      const off = await sule.rpc("my_published_shifts", { p_from: monday, p_to: day(6) });
      expect(off.error).toBeNull();
      expect(off.data).toEqual([]);
    } finally {
      await db.query("update public.organisations set shifts_enabled = true where id = $1", [
        owner.orgId,
      ]);
    }
  });
});
