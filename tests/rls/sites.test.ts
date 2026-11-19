/**
 * Slice 2.2: sites with a geofence and QR checkpoints.
 * - The geofence trigger: a pin becomes a radius_m circle; a drawn outline is checked (valid,
 *   200 corners or fewer, 4 km2 or less, in Nigeria) and gives the site its centre.
 * - private.site_geofence_check: inside, near (within the phone's accuracy) and outside.
 * - Roles: owner, admin and ops_manager write sites and checkpoints; hr inserts name-only sites;
 *   finance and line_manager read; a worker reads only the sites they are assigned to.
 * - QR tokens: never selectable by a signed-in user; site_checkpoint_tokens gives them to owner,
 *   admin and ops_manager only; rotate_checkpoint_qr swaps one, audited without the token.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

const PERMISSION_DENIED = "42501";
const APAPA = { lat: 6.4474, lng: 3.3611 };
const point = (p: { lat: number; lng: number }) => `SRID=4326;POINT(${p.lng} ${p.lat})`;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let hr: TestUser;
let finance: TestUser;
let lineManager: TestUser;
let worker: TestUser;
let clientId: string;
let siteId: string;
let otherSiteId: string;

async function addMember(user: TestUser, role: string, workerId: string | null = null) {
  const { error } = await admin.from("memberships").insert({
    organisation_id: owner.orgId,
    user_id: user.id,
    role: role as "worker",
    worker_id: workerId,
  });
  expect(error).toBeNull();
}

/** A square outline `side` metres across, south-west corner at `at`, as EWKT. */
function squareEwkt(side: number, at = APAPA): string {
  const dLat = side / 111_195;
  const dLng = side / (111_195 * Math.cos((at.lat * Math.PI) / 180));
  const ring = [
    [at.lng, at.lat],
    [at.lng + dLng, at.lat],
    [at.lng + dLng, at.lat + dLat],
    [at.lng, at.lat + dLat],
    [at.lng, at.lat],
  ];
  return `SRID=4326;POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(",")}))`;
}

async function geofenceOf(id: string) {
  const { rows } = await db.query<{
    area: number;
    set_at: Date | null;
    set_by: string | null;
    lat: number | null;
    lng: number | null;
  }>(
    `select extensions.st_area(geofence) as area, geofence_set_at as set_at, geofence_set_by as set_by,
       extensions.st_y(extensions.geometry(centre)) as lat, extensions.st_x(extensions.geometry(centre)) as lng
     from public.sites where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function check(id: string, p: { lat: number; lng: number }, accuracy: number, org?: string) {
  const { rows } = await db.query<{ answer: string | null }>(
    "select private.site_geofence_check($1, $2, $3::extensions.geography, $4) as answer",
    [org ?? owner.orgId, id, point(p), accuracy],
  );
  return rows[0]!.answer;
}

/** `metres` due north of `p`. */
const north = (p: { lat: number; lng: number }, metres: number) => ({
  lat: p.lat + metres / 111_195,
  lng: p.lng,
});

async function tokenOf(checkpointId: string): Promise<string> {
  const { rows } = await db.query<{ qr_token: string }>(
    "select qr_token from public.site_checkpoints where id = $1",
    [checkpointId],
  );
  return rows[0]!.qr_token;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("s-owner", "Sites Org");
  other = await createTenantUser("s-other", "Other Sites Org");
  ops = await createTestUser("s-ops", "Tunde Ops");
  hr = await createTestUser("s-hr", "Hauwa HR");
  finance = await createTestUser("s-finance", "Femi Finance");
  lineManager = await createTestUser("s-lm", "Lara Line");
  worker = await createTestUser("s-worker", "Musa Guard");
  await addMember(ops, "ops_manager");
  await addMember(hr, "hr");
  await addMember(finance, "finance");
  await addMember(lineManager, "line_manager");

  const { data, error } = await ops.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_site_name: "Apapa Warehouse 3",
  });
  expect(error).toBeNull();
  clientId = data!;
  const site = await admin.from("sites").select("id").eq("client_id", clientId).single();
  siteId = site.data!.id;

  const second = await ops.client
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: clientId, name: "Tin Can Island Gate" })
    .select("id")
    .single();
  expect(second.error).toBeNull();
  otherSiteId = second.data!.id;

  // A worker assigned to Apapa Warehouse 3 only.
  const workerId = randomUUID();
  const w = await admin.from("workers").insert({
    id: workerId,
    organisation_id: owner.orgId,
    staff_id: "ST-0001",
    first_name: "Musa",
    last_name: "Guard",
    employment_type: "permanent",
    start_date: "2025-01-06",
  });
  expect(w.error).toBeNull();
  const a = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: workerId,
    site_id: siteId,
    effective_from: "2025-01-06",
  });
  expect(a.error).toBeNull();
  await addMember(worker, "worker", workerId);
});

afterAll(async () => {
  await db?.end();
});

describe("site details", () => {
  it("lets ops_manager fill in an import-created name-only site", async () => {
    const { error } = await ops.client
      .from("sites")
      .update({ address: "Wharf Road, Apapa", state: "Lagos", landmark: "Gate 2" })
      .eq("id", siteId);
    expect(error).toBeNull();
  });

  it("lets hr add name-only sites, nothing more, and change none", async () => {
    const named = await hr.client
      .from("sites")
      .insert({ organisation_id: owner.orgId, client_id: clientId, name: "Imported site" })
      .select("id")
      .single();
    expect(named.error).toBeNull();
    const detailed = await hr.client.from("sites").insert({
      organisation_id: owner.orgId,
      client_id: clientId,
      name: "Detailed site",
      address: "1 Marina",
    });
    expect(detailed.error?.code).toBe(PERMISSION_DENIED);
    const update = await hr.client
      .from("sites")
      .update({ name: "Renamed by hr" })
      .eq("id", named.data!.id)
      .select("id");
    expect(update.data ?? []).toEqual([]);
  });

  it("refuses finance and line_manager writes; nobody deletes a site", async () => {
    for (const user of [finance, lineManager]) {
      const res = await user.client
        .from("sites")
        .update({ name: "Nope" })
        .eq("id", siteId)
        .select("id");
      expect(res.data ?? []).toEqual([]);
    }
    const del = await ops.client.from("sites").delete().eq("id", siteId);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
  });

  it("never moves a site to another client", async () => {
    const another = await admin
      .from("clients")
      .insert({ organisation_id: owner.orgId, name: "Greenfield Estates" })
      .select("id")
      .single();
    const res = await admin
      .from("sites")
      .update({ client_id: another.data!.id })
      .eq("id", otherSiteId);
    expect(res.error?.code).toBe("MLST5");
  });
});

describe("geofence", () => {
  it("turns a pin into a 100 m circle, recording who set it", async () => {
    const before = await geofenceOf(siteId);
    expect(before.area).toBeNull();
    expect(before.set_at).toBeNull();
    const { error } = await ops.client
      .from("sites")
      .update({ centre: point(APAPA) })
      .eq("id", siteId);
    expect(error).toBeNull();
    const after = await geofenceOf(siteId);
    // A 32-sided polygon a little inside the true circle (31,416 m2).
    expect(after.area).toBeGreaterThan(31_000);
    expect(after.area).toBeLessThan(31_416);
    expect(after.set_by).toBe(ops.id);
    expect(after.set_at).not.toBeNull();

    // Renaming leaves the geofence and its time alone.
    await ops.client.from("sites").update({ name: "Apapa Warehouse 3" }).eq("id", siteId);
    expect((await geofenceOf(siteId)).set_at).toEqual(after.set_at);

    // A wider radius widens it.
    await ops.client.from("sites").update({ radius_m: 200 }).eq("id", siteId);
    expect((await geofenceOf(siteId)).area).toBeGreaterThan(124_000);
    await ops.client.from("sites").update({ radius_m: 100 }).eq("id", siteId);
  });

  it("keeps the radius between 25 and 2,000 m", async () => {
    for (const radius of [24, 2001]) {
      const { error } = await ops.client
        .from("sites")
        .update({ radius_m: radius })
        .eq("id", siteId);
      expect(error?.code).toBe("23514");
    }
  });

  it("reports inside, near and outside", async () => {
    expect(await check(siteId, APAPA, 0)).toBe("inside");
    expect(await check(siteId, north(APAPA, 90), 0)).toBe("inside");
    // 115 m out: 15 m beyond the edge, within a 30 m fix but not a 5 m one.
    expect(await check(siteId, north(APAPA, 115), 30)).toBe("near");
    expect(await check(siteId, north(APAPA, 115), 5)).toBe("outside");
    expect(await check(siteId, north(APAPA, 500), 30)).toBe("outside");
    // Another company's id gets no answer, even as the database owner.
    expect(await check(siteId, APAPA, 0, other.orgId)).toBeNull();
    // No geofence yet: nothing to check against.
    expect(await check(otherSiteId, APAPA, 30)).toBeNull();
  });

  it("uses a drawn outline instead of the circle, and gives it a centre", async () => {
    const { error } = await ops.client
      .from("sites")
      .update({ centre: null, boundary: squareEwkt(300) })
      .eq("id", otherSiteId);
    expect(error).toBeNull();
    const g = await geofenceOf(otherSiteId);
    expect(g.area).toBeGreaterThan(89_000);
    expect(g.area).toBeLessThan(91_000);
    expect(g.lat).not.toBeNull();
    expect(await check(otherSiteId, north(APAPA, 250), 0)).toBe("inside");
    expect(await check(otherSiteId, north(APAPA, 350), 0)).toBe("outside");
  });

  it("refuses an outline that crosses itself, is too large or too detailed, or lies abroad", async () => {
    const bowTie = "SRID=4326;POLYGON((3.36 6.44,3.37 6.45,3.37 6.44,3.36 6.45,3.36 6.44))";
    const cases: [string, string][] = [
      [bowTie, "MLST1"],
      [squareEwkt(2100), "MLST3"],
      [squareEwkt(200, { lat: 51.5, lng: -0.12 }), "MLST4"],
    ];
    const ring = Array.from({ length: 202 }, (_, i) => {
      const t = (2 * Math.PI * i) / 202;
      return `${3.36 + 0.001 * Math.cos(t)} ${6.45 + 0.001 * Math.sin(t)}`;
    });
    cases.push([`SRID=4326;POLYGON((${[...ring, ring[0]].join(",")}))`, "MLST2"]);
    for (const [shape, code] of cases) {
      const { error } = await ops.client
        .from("sites")
        .update({ boundary: shape })
        .eq("id", otherSiteId);
      expect(error?.code, code).toBe(code);
    }
    const pin = await ops.client
      .from("sites")
      .update({ centre: point({ lat: 51.5, lng: -0.12 }) })
      .eq("id", siteId);
    expect(pin.error?.code).toBe("MLST4");
  });

  it("refuses an oversized outline on its corner count, before any geometry work", async () => {
    // 5,000 corners that also cross themselves: the count is what refuses it.
    const ring = Array.from({ length: 5000 }, (_, i) => {
      const t = (4 * Math.PI * i) / 5000;
      return `${3.36 + 0.001 * Math.cos(t)} ${6.45 + 0.0005 * Math.sin(2 * t)}`;
    });
    const started = Date.now();
    const { error } = await ops.client
      .from("sites")
      .update({ boundary: `SRID=4326;POLYGON((${[...ring, ring[0]].join(",")}))` })
      .eq("id", otherSiteId);
    expect(error?.code).toBe("MLST2");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses an outline with a hole", async () => {
    const outer = "3.36 6.44,3.37 6.44,3.37 6.45,3.36 6.45,3.36 6.44";
    const hole = "3.362 6.442,3.364 6.442,3.364 6.444,3.362 6.444,3.362 6.442";
    const { error } = await ops.client
      .from("sites")
      .update({ boundary: `SRID=4326;POLYGON((${outer}),(${hole}))` })
      .eq("id", otherSiteId);
    expect(error?.code).toBe("MLST1");
  });

  it("refuses an outline from anyone but the writers before checking it", async () => {
    const { error } = await hr.client.from("sites").insert({
      organisation_id: owner.orgId,
      client_id: clientId,
      name: "Outlined by hr",
      boundary: squareEwkt(100),
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
    const abroad = await other.client.from("sites").insert({
      organisation_id: owner.orgId,
      client_id: clientId,
      name: "Outlined by another company",
      boundary: squareEwkt(100),
    });
    expect(abroad.error?.code).toBe(PERMISSION_DENIED);
  });

  it("caps the accuracy tolerance at 5,000 m and only takes a point", async () => {
    // 6 km out with a claimed 1,000 km accuracy is still outside.
    expect(await check(siteId, north(APAPA, 6000), 1_000_000)).toBe("outside");
    expect(await check(siteId, north(APAPA, 4000), 1_000_000)).toBe("near");
    const { rows } = await db.query<{ answer: string | null }>(
      "select private.site_geofence_check($1, $2, $3::extensions.geography, 0) as answer",
      [owner.orgId, siteId, squareEwkt(10)],
    );
    expect(rows[0]!.answer).toBeNull();
  });

  it("can't be written directly", async () => {
    const { error } = await ops.client
      .from("sites")
      .update({ geofence: squareEwkt(100) })
      .eq("id", siteId);
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("is readable as numbers through site_geofences", async () => {
    const { data, error } = await finance.client.rpc("site_geofences", {
      p_organisation_id: owner.orgId,
      p_site_id: siteId,
    });
    expect(error).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({
        site_id: siteId,
        centre_lat: APAPA.lat,
        centre_lng: APAPA.lng,
        radius_m: 100,
        boundary: null,
      }),
    ]);
    const outsider = await other.client.rpc("site_geofences", { p_organisation_id: owner.orgId });
    expect(outsider.data ?? []).toEqual([]);
  });
});

describe("checkpoints", () => {
  const ids: string[] = [];

  beforeAll(async () => {
    for (const name of ["Gate A", "Warehouse floor", "Gate B"]) {
      const { data, error } = await ops.client
        .from("site_checkpoints")
        .insert({ organisation_id: owner.orgId, site_id: siteId, name })
        .select("id, sort_order")
        .single();
      expect(error).toBeNull();
      ids.push(data!.id);
    }
  });

  it("are numbered in the order added, each with a random 64-character token", async () => {
    const { rows } = await db.query<{ name: string; sort_order: number; qr_token: string }>(
      "select name, sort_order, qr_token from public.site_checkpoints where site_id = $1 order by sort_order",
      [siteId],
    );
    expect(rows.map((r) => [r.name, r.sort_order])).toEqual([
      ["Gate A", 0],
      ["Warehouse floor", 1],
      ["Gate B", 2],
    ]);
    for (const r of rows) expect(r.qr_token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(rows.map((r) => r.qr_token)).size).toBe(3);
  });

  it("never show the token to a signed-in user by select", async () => {
    for (const user of [owner, ops, hr, finance, lineManager, worker]) {
      const { error } = await user.client
        .from("site_checkpoints")
        .select("qr_token")
        .eq("site_id", siteId);
      expect(error?.code, user.email).toBe(PERMISSION_DENIED);
    }
    const insert = await ops.client.from("site_checkpoints").insert({
      organisation_id: owner.orgId,
      site_id: siteId,
      name: "Chosen token",
      qr_token: "0".repeat(64),
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
  });

  it("give the tokens to owner, admin and ops_manager only", async () => {
    for (const user of [owner, ops]) {
      const { data, error } = await user.client.rpc("site_checkpoint_tokens", {
        p_organisation_id: owner.orgId,
        p_site_id: siteId,
      });
      expect(error).toBeNull();
      expect(data?.map((c) => c.name)).toEqual(["Gate A", "Warehouse floor", "Gate B"]);
    }
    for (const user of [hr, finance, lineManager, worker, other]) {
      const { data } = await user.client.rpc("site_checkpoint_tokens", {
        p_organisation_id: owner.orgId,
        p_site_id: siteId,
      });
      expect(data ?? [], user.email).toEqual([]);
    }
  });

  it("let line managers, finance and hr read names, not change them", async () => {
    for (const user of [lineManager, finance, hr]) {
      const read = await user.client
        .from("site_checkpoints")
        .select("id, name")
        .eq("site_id", siteId);
      expect(read.data, user.email).toHaveLength(3);
      const write = await user.client
        .from("site_checkpoints")
        .update({ name: "Renamed" })
        .eq("site_id", siteId)
        .select("id");
      expect(write.data ?? []).toEqual([]);
      const add = await user.client
        .from("site_checkpoints")
        .insert({ organisation_id: owner.orgId, site_id: siteId, name: "Extra" });
      expect(add.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("rotate to a new token, audited without it", async () => {
    const id = ids[0]!;
    const before = await tokenOf(id);
    const { error } = await ops.client.rpc("rotate_checkpoint_qr", {
      p_organisation_id: owner.orgId,
      p_checkpoint_id: id,
    });
    expect(error).toBeNull();
    const after = await tokenOf(id);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);

    const { rows } = await db.query<{ action: string; actor_id: string; doc: string }>(
      "select action, actor_id, coalesce(before::text, '') || coalesce(after::text, '') as doc from public.audit_log where entity_id = $1",
      [id],
    );
    expect(rows.find((r) => r.action === "checkpoint.qr_rotated")?.actor_id).toBe(ops.id);
    for (const r of rows) {
      expect(r.doc).not.toContain(before);
      expect(r.doc).not.toContain(after);
    }
  });

  it("refuse rotation by other roles and other companies", async () => {
    for (const user of [hr, finance, lineManager, other]) {
      const { error } = await user.client.rpc("rotate_checkpoint_qr", {
        p_organisation_id: owner.orgId,
        p_checkpoint_id: ids[0]!,
      });
      expect(error?.code, user.email).toBe(PERMISSION_DENIED);
    }
  });

  it("move up and down the round", async () => {
    const { data, error } = await ops.client.rpc("move_site_checkpoint", {
      p_organisation_id: owner.orgId,
      p_checkpoint_id: ids[2]!,
      p_direction: "up",
    });
    expect(error).toBeNull();
    expect(data).toBe(2);
    const order = await admin
      .from("site_checkpoints")
      .select("name")
      .eq("site_id", siteId)
      .order("sort_order");
    expect(order.data?.map((c) => c.name)).toEqual(["Gate A", "Gate B", "Warehouse floor"]);
    const atTop = await ops.client.rpc("move_site_checkpoint", {
      p_organisation_id: owner.orgId,
      p_checkpoint_id: ids[0]!,
      p_direction: "up",
    });
    expect(atTop.data).toBe(0);
  });

  it("retire for good: no rotation, no change, no delete", async () => {
    const id = ids[1]!;
    const retire = await ops.client
      .from("site_checkpoints")
      .update({ status: "retired" })
      .eq("id", id)
      .select("retired_at, retired_by")
      .single();
    expect(retire.error).toBeNull();
    expect(retire.data?.retired_by).toBe(ops.id);
    const rotate = await ops.client.rpc("rotate_checkpoint_qr", {
      p_organisation_id: owner.orgId,
      p_checkpoint_id: id,
    });
    expect(rotate.error?.code).toBe("MLCP1");
    const revive = await ops.client
      .from("site_checkpoints")
      .update({ status: "active" })
      .eq("id", id);
    expect(revive.error?.code).toBe("MLCP1");
    const del = await ops.client.from("site_checkpoints").delete().eq("id", id);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    // The name is free again for a new checkpoint.
    const again = await ops.client
      .from("site_checkpoints")
      .insert({ organisation_id: owner.orgId, site_id: siteId, name: "Warehouse floor" });
    expect(again.error).toBeNull();
  });

  it("can't be added to an archived site", async () => {
    await ops.client.from("sites").update({ status: "archived" }).eq("id", otherSiteId);
    const { error } = await ops.client
      .from("site_checkpoints")
      .insert({ organisation_id: owner.orgId, site_id: otherSiteId, name: "Gate C" });
    expect(error?.code).toBe("MLCP2");
    await ops.client.from("sites").update({ status: "active" }).eq("id", otherSiteId);
  });
});

describe("checkpoint cap", () => {
  it("stops at 200 active checkpoints a site", async () => {
    await db.query(
      `insert into public.site_checkpoints (organisation_id, site_id, name)
       select $1, $2, 'Post ' || g from generate_series(1, 200) g`,
      [owner.orgId, otherSiteId],
    );
    const { error } = await ops.client
      .from("site_checkpoints")
      .insert({ organisation_id: owner.orgId, site_id: otherSiteId, name: "Post 201" });
    expect(error?.code).toBe("MLCP5");
  });
});

describe("a worker", () => {
  it("reads only the site they are assigned to, and its checkpoints", async () => {
    const sites = await worker.client.from("sites").select("id").eq("organisation_id", owner.orgId);
    expect(sites.data?.map((s) => s.id)).toEqual([siteId]);
    const checkpoints = await worker.client
      .from("site_checkpoints")
      .select("site_id")
      .eq("organisation_id", owner.orgId);
    expect(checkpoints.data?.length).toBeGreaterThan(0);
    expect(new Set(checkpoints.data?.map((c) => c.site_id))).toEqual(new Set([siteId]));
  });

  it("changes nothing", async () => {
    const res = await worker.client
      .from("sites")
      .update({ name: "Mine now" })
      .eq("id", siteId)
      .select("id");
    expect(res.data ?? []).toEqual([]);
  });
});

describe("another company", () => {
  it("sees none of these sites or checkpoints", async () => {
    const sites = await other.client.from("sites").select("id").eq("organisation_id", owner.orgId);
    expect(sites.data ?? []).toEqual([]);
    const cps = await other.client
      .from("site_checkpoints")
      .select("id")
      .eq("organisation_id", owner.orgId);
    expect(cps.data ?? []).toEqual([]);
  });
});
