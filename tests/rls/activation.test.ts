/**
 * Slice 2.7: activation, posts, roster requirements, required shifts and ending a contract,
 * against the real database.
 * - activate_contract turns each headcount row into a post and a roster requirement from the
 *   go-live date, is idempotent (also when two run at once), and refuses with every missing item
 *   listed (MLCT1-MLCT8). Only owner, admin and ops_manager; another company can't.
 * - required_shifts for next week returns exactly the shifts the headcount describes (a night
 *   shift ends the next morning, a Mon-Fri post, an ended contract gives none).
 * - Posts and requirements are written by no role directly, never deleted or edited.
 * - end_contract closes posts, requirements and rate cards on the end date (cancelling what would
 *   start later); the daily job then ends the contract.
 * - New worker assignments to archived sites and clients are refused (owner decision).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";
import { loadImportContext } from "@/server/people/imports/context";
import type { Json } from "@/types/db";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let finance: TestUser;
let hr: TestUser;
let lineManager: TestUser;
let clientId: string;
let apapa: string;
let gateB: string;

const today = lagosToday();
/** Next Monday (never today), so the week under test is whole and in the future. */
const monday = addDays(today, 8 - isoWeekday(today));
const sunday = addDays(monday, 6);

const APAPA = { lat: 6.4474, lng: 3.3611 };
const point = (p: { lat: number; lng: number }) => `SRID=4326;POINT(${p.lng} ${p.lat})`;

async function addMember(user: TestUser, role: "ops_manager" | "hr" | "finance" | "line_manager") {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function newSite(name: string, client = clientId, fenced = true): Promise<string> {
  const { data, error } = await admin
    .from("sites")
    .insert({
      organisation_id: owner.orgId,
      client_id: client,
      name,
      ...(fenced ? { centre: point(APAPA), radius_m: 100 } : {}),
    } as never)
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

const COASTLINE_ROWS = (a: string, b: string) => [
  { site_id: a, post_name: "Gate A", band: "Day", start_time: "06:00", end_time: "18:00" },
  { site_id: a, post_name: "Gate A", band: "Night", start_time: "18:00", end_time: "06:00" },
  { site_id: b, post_name: "Patrol", band: "Night", start_time: "18:00", end_time: "06:00" },
  { site_id: b, post_name: "Warehouse floor", band: "Day", start_time: "06:00", end_time: "18:00" },
];

interface DraftOptions {
  client?: string;
  sites?: string[];
  start?: string;
  end?: string | null;
  type?: string;
  card?: boolean;
  rows?: Record<string, unknown>[];
}

/** A draft contract with a rate card (Guard Day and Night) and headcount, written as ops. */
async function draftContract(options: DraftOptions = {}): Promise<string> {
  const sites = options.sites ?? [apapa, gateB];
  const start = options.start ?? monday;
  const { data: id, error } = await ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: options.client ?? clientId,
      name: "Coastline guarding",
      type: options.type ?? "manned_post",
      start_date: start,
      end_date: options.end ?? null,
    } as Json,
    p_site_ids: sites,
  });
  expect(error).toBeNull();
  if (options.card !== false) {
    const card = await ops.client.rpc("save_draft_rate_card", {
      p_organisation_id: owner.orgId,
      p_contract_id: id!,
      p_effective_from: start,
      p_lines: [
        { role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" },
        { role: "Guard", band: "Night", unit: "shift", rate_kobo: "1500000" },
      ] as Json,
    });
    expect(card.error).toBeNull();
  }
  const rows = options.rows ?? (sites.length >= 2 ? COASTLINE_ROWS(sites[0]!, sites[1]!) : []);
  for (const row of rows) {
    const { error: rowError } = await ops.client.from("headcount_requirements").insert({
      organisation_id: owner.orgId,
      contract_id: id!,
      role: "Guard",
      unit: "shift",
      days_of_week: [1, 2, 3, 4, 5, 6, 7],
      required_count: 1,
      ...row,
    } as never);
    expect(rowError).toBeNull();
  }
  return id!;
}

function activate(contractId: string, by: Client = ops.client, goLive?: string, welcome = true) {
  return by.rpc("activate_contract", {
    p_organisation_id: owner.orgId,
    p_contract_id: contractId,
    ...(goLive ? { p_go_live_date: goLive } : {}),
    p_send_welcome: welcome,
  });
}

function codesOf(error: { details: string | null } | null): string[] {
  const parsed = JSON.parse(error?.details ?? "[]") as { code: string }[];
  return parsed.map((i) => i.code);
}

async function count(table: "posts" | "roster_requirements", contractId: string) {
  const { count: n, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("contract_id", contractId);
  expect(error).toBeNull();
  return n ?? 0;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("act-owner", "Activation Org");
  other = await createTenantUser("act-other", "Other Activation Org");
  ops = await createTestUser("act-ops", "Tunde Ops");
  finance = await createTestUser("act-fin", "Femi Finance");
  hr = await createTestUser("act-hr", "Hauwa HR");
  lineManager = await createTestUser("act-lm", "Lara Line");
  await addMember(ops, "ops_manager");
  await addMember(finance, "finance");
  await addMember(hr, "hr");
  await addMember(lineManager, "line_manager");

  const { data, error } = await owner.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(error).toBeNull();
  clientId = data!;
  apapa = await newSite("Apapa Warehouse 3");
  gateB = await newSite("Gate B");
});

afterAll(async () => {
  await db?.end();
});

describe("activate_contract", () => {
  it("turns each headcount row into a post and a roster requirement from the go-live date", async () => {
    const id = await draftContract();
    const { data, error } = await activate(id);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: "active",
      go_live_date: monday,
      activated_now: true,
      send_welcome: true,
      posts: 4,
      requirements: 4,
    });

    const { data: contract } = await admin
      .from("contracts")
      .select("status, go_live_date, activated_by")
      .eq("id", id)
      .single();
    expect(contract).toEqual({ status: "active", go_live_date: monday, activated_by: ops.id });

    const { data: posts } = await admin
      .from("posts")
      .select(
        "name, site_id, role, band, unit, kind, status, opened_on, headcount_requirement_id, roster_requirements(effective_from, effective_to, days_of_week, start_time, end_time, duration_minutes, required_count)",
      )
      .eq("contract_id", id)
      .order("name");
    expect(posts?.map((p) => p.name)).toEqual([
      "Gate A · Day",
      "Gate A · Night",
      "Patrol · Night",
      "Warehouse floor · Day",
    ]);
    const night = posts!.find((p) => p.name === "Gate A · Night")!;
    expect(night).toMatchObject({
      site_id: apapa,
      role: "Guard",
      band: "Night",
      unit: "shift",
      kind: "shift",
      status: "open",
      opened_on: monday,
    });
    expect(night.roster_requirements).toEqual([
      {
        effective_from: monday,
        effective_to: null,
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: "18:00:00",
        end_time: "06:00:00",
        duration_minutes: 720,
        required_count: 1,
      },
    ]);

    const { data: audit } = await admin
      .from("audit_log")
      .select("action, actor_id, after")
      .eq("entity_id", id)
      .eq("action", "contract.activated");
    expect(audit).toHaveLength(1);
    expect(audit![0]).toMatchObject({
      actor_id: ops.id,
      after: { status: "active", posts: 4, requirements: 4, go_live_date: monday },
    });

    // The headcount is frozen now.
    const { error: frozen } = await ops.client
      .from("headcount_requirements")
      .update({ required_count: 2 })
      .eq("contract_id", id);
    expect(frozen?.code).toBe("MLHC1");
  });

  it("changes nothing when run again, and sends the welcome only the first time", async () => {
    const id = await draftContract();
    expect((await activate(id)).error).toBeNull();
    const again = await activate(id, owner.client);
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({
      status: "active",
      activated_now: false,
      send_welcome: false,
      posts: 4,
      requirements: 4,
    });
    expect(await count("posts", id)).toBe(4);
    const { data: audit } = await admin
      .from("audit_log")
      .select("id")
      .eq("entity_id", id)
      .eq("action", "contract.activated");
    expect(audit).toHaveLength(1);
  });

  it("gives one set of posts when two activations run at once", async () => {
    const id = await draftContract();
    const [a, b] = await Promise.all([activate(id), activate(id, owner.client)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const now = [a.data, b.data].map((d) => (d as { activated_now: boolean }).activated_now);
    expect(now.sort()).toEqual([false, true]);
    expect(await count("posts", id)).toBe(4);
    expect(await count("roster_requirements", id)).toBe(4);
  });

  it("goes live on a chosen later date, and copies the end date onto the requirements", async () => {
    const end = addDays(monday, 30);
    const id = await draftContract({ end });
    const goLive = addDays(monday, 3);
    const { data, error } = await activate(id, ops.client, goLive);
    expect(error).toBeNull();
    expect(data).toMatchObject({ go_live_date: goLive });
    const { data: reqs } = await admin
      .from("roster_requirements")
      .select("effective_from, effective_to")
      .eq("contract_id", id);
    expect(new Set(reqs?.map((r) => `${r.effective_from}/${r.effective_to}`))).toEqual(
      new Set([`${goLive}/${end}`]),
    );
  });

  it("refuses with every missing item listed, and creates nothing", async () => {
    const bare = (
      await owner.client.rpc("create_client", {
        p_organisation_id: owner.orgId,
        p_name: "Greenfield Estates",
      })
    ).data!;
    const fenced = await newSite("Lekki Gate", bare);
    const unfenced = await newSite("Ikoyi Gate", bare, false);
    const id = await draftContract({
      client: bare,
      sites: [fenced, unfenced],
      rows: [
        {
          site_id: fenced,
          post_name: "Gate",
          band: "Supervisor",
          start_time: "06:00",
          end_time: "18:00",
        },
      ],
    });
    const { error } = await activate(id);
    expect(error?.code).toBe("MLCT2");
    expect(codesOf(error)).toEqual(["MLCT2", "MLCT3", "MLCT5"]);
    expect(error?.message).toContain("The client has no billing contact.");
    expect(error?.message).toContain("No geofence at Ikoyi Gate.");
    expect(error?.message).toContain("No rate for Guard · Supervisor (shift).");
    expect(await count("posts", id)).toBe(0);
    const { data: contract } = await admin.from("contracts").select("status").eq("id", id).single();
    expect(contract?.status).toBe("draft");
  });

  it("refuses each missing item on its own", async () => {
    // MLCT3: no sites at all.
    const noSites = await draftContract({ sites: [], type: "per_job" });
    expect(codesOf((await activate(noSites)).error)).toEqual(["MLCT3"]);

    // MLCT4: no rate card in force on the go-live date.
    const noCard = await draftContract({ card: false });
    expect(codesOf((await activate(noCard)).error)).toEqual(["MLCT4"]);

    // MLCT6: a manned-post contract with no headcount.
    const noHeadcount = await draftContract({ rows: [] });
    expect(codesOf((await activate(noHeadcount)).error)).toEqual(["MLCT6"]);
    // ...which a fixed-monthly contract doesn't need.
    const fixed = await draftContract({ type: "fixed_monthly", rows: [] });
    expect((await activate(fixed)).error).toBeNull();

    // MLCT7: go-live before the start, in the past, or after the end.
    const dated = await draftContract({ end: addDays(monday, 10) });
    expect((await activate(dated, ops.client, addDays(monday, -1))).error?.code).toBe("MLCT7");
    expect((await activate(dated, ops.client, addDays(monday, 11))).error?.code).toBe("MLCT7");
    const started = await draftContract({ start: addDays(today, -10) });
    expect((await activate(started, ops.client, addDays(today, -1))).error?.code).toBe("MLCT7");
    // Left to the database, a contract that started earlier goes live today.
    const { data: live } = await activate(started);
    expect(live).toMatchObject({ go_live_date: today });

    // MLCT8: an archived site.
    const archivedSite = await newSite("Old Gate");
    const withArchived = await draftContract({ sites: [apapa, archivedSite] });
    await admin.from("sites").update({ status: "archived" }).eq("id", archivedSite);
    const refused = await activate(withArchived);
    expect(codesOf(refused.error)).toEqual(["MLCT8"]);
    expect(refused.error?.message).toContain("Archived sites: Old Gate.");

    // MLCT1: an ended contract.
    const ended = await draftContract();
    await db.query("update public.contracts set status = 'ended' where id = $1", [ended]);
    expect((await activate(ended)).error?.code).toBe("MLCT1");
  });

  it("is for owner, admin and ops_manager of the company only", async () => {
    const id = await draftContract();
    for (const who of [finance, hr, lineManager]) {
      const { error } = await activate(id, who.client);
      expect(error?.code, who.email).toBe("42501");
    }
    const { error } = await other.client.rpc("activate_contract", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
    });
    expect(error?.code).toBe("42501");
    const cross = await other.client.rpc("activate_contract", {
      p_organisation_id: other.orgId,
      p_contract_id: id,
    });
    expect(cross.error?.code).toBe("P0002");
    expect(await count("posts", id)).toBe(0);
  });
});

describe("posts and roster requirements", () => {
  let contractId: string;
  let postId: string;
  let requirementId: string;

  beforeAll(async () => {
    contractId = await draftContract();
    expect((await activate(contractId)).error).toBeNull();
    const { data } = await admin
      .from("posts")
      .select("id, roster_requirements(id)")
      .eq("contract_id", contractId)
      .limit(1)
      .single();
    postId = data!.id;
    requirementId = data!.roster_requirements[0]!.id;
  });

  it("are read by every manager role, and by no other company", async () => {
    for (const who of [ops, finance, hr, lineManager]) {
      const { data } = await who.client.from("posts").select("id").eq("contract_id", contractId);
      expect(data, who.email).toHaveLength(4);
      const reqs = await who.client
        .from("roster_requirements")
        .select("id")
        .eq("contract_id", contractId);
      expect(reqs.data, who.email).toHaveLength(4);
    }
    const { data } = await other.client.from("posts").select("id").eq("contract_id", contractId);
    expect(data).toEqual([]);
  });

  it("are never written directly by any role", async () => {
    const insert = await owner.client.from("posts").insert({
      organisation_id: owner.orgId,
      contract_id: contractId,
      site_id: apapa,
      name: "Sneaky",
      role: "Guard",
      unit: "shift",
      opened_on: monday,
    } as never);
    expect(insert.error?.code).toBe("42501");
    const update = await owner.client
      .from("posts")
      .update({ name: "Renamed" } as never)
      .eq("id", postId);
    expect(update.error?.code).toBe("42501");
    const req = await ops.client
      .from("roster_requirements")
      .update({ required_count: 5 } as never)
      .eq("id", requirementId);
    expect(req.error?.code).toBe("42501");
    const del = await owner.client.from("posts").delete().eq("id", postId);
    expect(del.error?.code).toBe("42501");
  });

  it("refuse edits and deletes even for the database owner", async () => {
    await expect(
      db.query("delete from public.posts where id = $1", [postId]),
    ).rejects.toMatchObject({
      code: "MLPO1",
    });
    await expect(
      db.query("update public.posts set name = 'X' where id = $1", [postId]),
    ).rejects.toMatchObject({ code: "MLPO1" });
    await expect(
      db.query("update public.roster_requirements set required_count = 3 where id = $1", [
        requirementId,
      ]),
    ).rejects.toMatchObject({ code: "MLPO1" });
    // Overlapping versions of one post are refused.
    await expect(
      db.query(
        `insert into public.roster_requirements
           (organisation_id, post_id, contract_id, site_id, effective_from, days_of_week, start_time, end_time, required_count)
         select organisation_id, post_id, contract_id, site_id, effective_from + 1, days_of_week, start_time, end_time, 2
         from public.roster_requirements where id = $1`,
        [requirementId],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("keep a rate change from leaving out an open post's key", async () => {
    const { error } = await ops.client.rpc("add_rate_card_version", {
      p_organisation_id: owner.orgId,
      p_contract_id: contractId,
      p_effective_from: addDays(monday, 14),
      p_lines: [{ role: "Guard", band: "Day", unit: "shift", rate_kobo: "1300000" }] as Json,
    });
    expect(error?.code).toBe("MLRC5");
    expect(error?.message).toContain("Guard · Night (shift)");
  });
});

describe("required_shifts", () => {
  let coastline: string;
  let weekdays: string;
  let ended: string;

  beforeAll(async () => {
    const org = (
      await owner.client.rpc("create_client", {
        p_organisation_id: owner.orgId,
        p_name: "Shift Test Client",
        p_contact_email: "billing@shifttest.example",
      })
    ).data!;
    const s1 = await newSite("Shift Site 1", org);
    const s2 = await newSite("Shift Site 2", org);
    coastline = await draftContract({ client: org, sites: [s1, s2] });
    weekdays = await draftContract({
      client: org,
      sites: [s1],
      rows: [
        {
          site_id: s1,
          post_name: "Reception",
          band: "Day",
          days_of_week: [1, 2, 3, 4, 5],
          start_time: "08:00",
          end_time: "17:00",
          required_count: 2,
        },
      ],
    });
    ended = await draftContract({ client: org, sites: [s1, s2] });
    for (const id of [coastline, weekdays, ended]) expect((await activate(id)).error).toBeNull();
    await db.query("update public.contracts set status = 'ended' where id = $1", [ended]);
  });

  async function shifts(from: string, to: string, by: Client = ops.client) {
    const { data, error } = await by.rpc("required_shifts", {
      p_organisation_id: owner.orgId,
      p_from: from,
      p_to: to,
    });
    expect(error).toBeNull();
    return data ?? [];
  }

  it("returns exactly the shifts the headcount describes for next week", async () => {
    const week = await shifts(monday, sunday);
    const ofCoastline = week.filter((s) => s.contract_id === coastline);
    // 4 posts every day: 28 shifts of one person.
    expect(ofCoastline).toHaveLength(28);
    expect(ofCoastline.every((s) => s.required_count === 1)).toBe(true);
    for (const name of [
      "Gate A · Day",
      "Gate A · Night",
      "Patrol · Night",
      "Warehouse floor · Day",
    ]) {
      expect(ofCoastline.filter((s) => s.post_name === name).map((s) => s.shift_date)).toEqual(
        Array.from({ length: 7 }, (_, i) => addDays(monday, i)),
      );
    }
    // Lagos is UTC+1: a night shift on Monday runs 17:00Z Monday to 05:00Z Tuesday.
    const night = ofCoastline.find(
      (s) => s.post_name === "Gate A · Night" && s.shift_date === monday,
    )!;
    expect(new Date(night.starts_at).toISOString()).toBe(`${monday}T17:00:00.000Z`);
    expect(new Date(night.ends_at).toISOString()).toBe(`${addDays(monday, 1)}T05:00:00.000Z`);
    const day = ofCoastline.find((s) => s.post_name === "Gate A · Day" && s.shift_date === monday)!;
    expect(new Date(day.starts_at).toISOString()).toBe(`${monday}T05:00:00.000Z`);
    expect(new Date(day.ends_at).toISOString()).toBe(`${monday}T17:00:00.000Z`);

    // Mon-Fri reception, 2 people.
    const reception = week.filter((s) => s.contract_id === weekdays);
    expect(reception.map((s) => s.shift_date)).toEqual(
      Array.from({ length: 5 }, (_, i) => addDays(monday, i)),
    );
    expect(reception.every((s) => s.required_count === 2)).toBe(true);

    // An ended contract has no shifts.
    expect(week.filter((s) => s.contract_id === ended)).toEqual([]);
  });

  it("starts on the go-live date", async () => {
    const before = await shifts(addDays(monday, -3), addDays(monday, -1));
    expect(before.filter((s) => s.contract_id === coastline)).toEqual([]);
  });

  it("is read by line managers, not by another company, and capped at 62 days", async () => {
    expect((await shifts(monday, sunday, lineManager.client)).length).toBeGreaterThan(0);
    const { data } = await other.client.rpc("required_shifts", {
      p_organisation_id: owner.orgId,
      p_from: monday,
      p_to: sunday,
    });
    expect(data).toEqual([]);
    const { error } = await ops.client.rpc("required_shifts", {
      p_organisation_id: owner.orgId,
      p_from: monday,
      p_to: addDays(monday, 62),
    });
    expect(error?.code).toBe("22023");
    expect((await shifts(monday, addDays(monday, 61))).length).toBeGreaterThan(0);
  });
});

describe("end_contract", () => {
  function end(id: string, on: string, reason = "Client gave notice", by: Client = ops.client) {
    return by.rpc("end_contract", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_end_date: on,
      p_reason: reason,
    });
  }

  it("closes posts, requirements and the rate card on the end date, cancelling later changes", async () => {
    const id = await draftContract();
    expect((await activate(id)).error).toBeNull();
    // A rate change scheduled after the end date: cancelled with the ending.
    const later = await ops.client.rpc("add_rate_card_version", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: addDays(monday, 40),
      p_lines: [
        { role: "Guard", band: "Day", unit: "shift", rate_kobo: "1300000" },
        { role: "Guard", band: "Night", unit: "shift", rate_kobo: "1600000" },
      ] as Json,
    });
    expect(later.error).toBeNull();

    const last = addDays(monday, 20);
    const { data, error } = await end(id, last);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      changed: true,
      end_date: last,
      posts_closed: 4,
      requirements_closed: 4,
      rate_cards_cancelled: 1,
      rate_cards_closed: 1,
    });

    const { data: contract } = await admin
      .from("contracts")
      .select("status, end_date, end_reason")
      .eq("id", id)
      .single();
    expect(contract).toEqual({
      status: "active",
      end_date: last,
      end_reason: "Client gave notice",
    });
    const { data: posts } = await admin
      .from("posts")
      .select("status, closed_on, closed_reason")
      .eq("contract_id", id);
    expect(new Set(posts?.map((p) => `${p.status}/${p.closed_on}/${p.closed_reason}`))).toEqual(
      new Set([`closed/${last}/Contract ended: Client gave notice`]),
    );
    const { data: reqs } = await admin
      .from("roster_requirements")
      .select("effective_to")
      .eq("contract_id", id);
    expect(new Set(reqs?.map((r) => r.effective_to))).toEqual(new Set([last]));
    const { data: cards } = await admin
      .from("rate_cards")
      .select("effective_from, effective_to")
      .eq("contract_id", id);
    expect(cards).toEqual([{ effective_from: monday, effective_to: last }]);

    // Shifts stop after the last day.
    const { data: shifts } = await ops.client.rpc("required_shifts", {
      p_organisation_id: owner.orgId,
      p_from: addDays(last, -1),
      p_to: addDays(last, 2),
    });
    const dates = new Set(
      (shifts ?? []).filter((s) => s.contract_id === id).map((s) => s.shift_date),
    );
    expect([...dates].sort()).toEqual([addDays(last, -1), last]);

    // Again with the same date: nothing changes. Another date: refused.
    const again = await end(id, last);
    expect(again.data).toMatchObject({ changed: false });
    expect((await end(id, addDays(last, -1))).error?.code).toBe("MLCE4");

    const { data: audit } = await admin
      .from("audit_log")
      .select("action, reason, actor_id")
      .eq("entity_id", id)
      .eq("action", "contract.ended");
    expect(audit).toEqual([
      { action: "contract.ended", reason: "Client gave notice", actor_id: ops.id },
    ]);
  });

  it("refuses a past date, a date before go-live, a later end, a blank reason, a draft and other roles", async () => {
    const draft = await draftContract();
    expect((await end(draft, addDays(monday, 5))).error?.code).toBe("MLCE1");

    const id = await draftContract({ end: addDays(monday, 30) });
    expect((await activate(id)).error).toBeNull();
    expect((await end(id, addDays(today, -1))).error?.code).toBe("MLCE2");
    expect((await end(id, addDays(monday, -1))).error?.code).toBe("MLCE2");
    expect((await end(id, addDays(monday, 31))).error?.code).toBe("MLCE2");
    expect((await end(id, addDays(monday, 5), "  ")).error?.code).toBe("MLCE3");
    expect((await end(id, addDays(monday, 5), "x", finance.client)).error?.code).toBe("42501");
    expect((await end(id, addDays(monday, 5), "x", hr.client)).error?.code).toBe("42501");

    // A live contract's end date can't be moved by a plain update either.
    const { error } = await ops.client
      .from("contracts")
      .update({ end_date: addDays(monday, 5) })
      .eq("id", id);
    expect(error?.code).toBe("MLCO1");
  });

  it("ends the contract once the last day has passed (the daily job), freezing its rates", async () => {
    const id = await draftContract({ start: addDays(today, -5) });
    expect((await activate(id)).error).toBeNull();
    // Simulate an ending whose last day is behind us (end_contract only takes today or later).
    await db.query("begin");
    await db.query("select set_config('metalira.contract_ending', $1, true)", [id]);
    await db.query("update public.contracts set end_date = $2, end_reason = 'Done' where id = $1", [
      id,
      addDays(today, -1),
    ]);
    await db.query("commit");
    const { rows } = await db.query("select private.end_due_contracts($1) as n", [owner.orgId]);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    const { data: contract } = await admin
      .from("contracts")
      .select("status, ended_at")
      .eq("id", id)
      .single();
    expect(contract?.status).toBe("ended");
    expect(contract?.ended_at).not.toBeNull();
    const { data: posts } = await admin
      .from("posts")
      .select("status, closed_on")
      .eq("contract_id", id);
    expect(new Set(posts?.map((p) => `${p.status}/${p.closed_on}`))).toEqual(
      new Set([`closed/${addDays(today, -1)}`]),
    );
    const { error } = await ops.client.rpc("add_rate_card_version", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: addDays(today, 5),
      p_lines: [{ role: "Guard", band: "Day", unit: "shift", rate_kobo: "1" }] as Json,
    });
    expect(error?.code).toBe("MLRC6");
  });
});

describe("assignments to archived sites and clients (owner decision, 19 Nov 2026)", () => {
  let staff = 0;

  async function newWorker(): Promise<string> {
    staff += 1;
    const id = randomUUID();
    const { error } = await hr.client.rpc("create_worker", {
      p_worker: {
        id,
        organisation_id: owner.orgId,
        staff_id: `ACT-${String(staff).padStart(4, "0")}`,
        first_name: "Musa",
        last_name: `Archived ${staff}`,
        employment_type: "permanent",
        start_date: today,
      },
    });
    expect(error).toBeNull();
    return id;
  }

  function assign(workerId: string, values: Record<string, unknown>) {
    return hr.client
      .from("worker_assignments")
      .insert({
        organisation_id: owner.orgId,
        worker_id: workerId,
        effective_from: today,
        ...values,
      } as never)
      .select("id")
      .single();
  }

  it("refuses new assignments to an archived site or client, and leaves existing ones alone", async () => {
    const client = (
      await owner.client.rpc("create_client", {
        p_organisation_id: owner.orgId,
        p_name: "Archive Test Client",
      })
    ).data!;
    const site = await newSite("Archive Site", client);
    const kept = await newSite("Kept Site", client);
    const worker = await newWorker();
    const existing = await assign(worker, { site_id: site });
    expect(existing.error).toBeNull();

    await admin.from("sites").update({ status: "archived" }).eq("id", site);
    const second = await newWorker();
    const refused = await assign(second, { site_id: site });
    expect(refused.error?.code).toBe("MLAS6");
    expect(refused.error?.message).toBe(
      "That site is archived. Restore it before assigning people to it.",
    );

    // The existing assignment still closes normally.
    const close = await hr.client
      .from("worker_assignments")
      .update({ effective_to: addDays(today, 1) })
      .eq("id", existing.data!.id);
    expect(close.error).toBeNull();

    // An archived client refuses its sites too, and client-only assignments.
    await admin.from("clients").update({ status: "archived" }).eq("id", client);
    expect((await assign(second, { site_id: kept })).error?.code).toBe("MLAS7");
    expect((await assign(second, { client_id: client })).error?.code).toBe("MLAS7");

    // The people import reads the same statuses, so it holds such rows back before the database
    // would refuse them ("Client archived" / "Site archived", src/server/people/import/validate.ts).
    const context = await loadImportContext(hr.client, owner.orgId);
    expect(context.clients?.find((c) => c.id === client)).toMatchObject({ archived: true });
    expect(context.sites?.find((x) => x.id === site)).toMatchObject({ archived: true });
    expect(context.sites?.find((x) => x.id === apapa)).toMatchObject({ archived: false });

    // Moving an existing row onto an archived site is refused for the database owner too.
    const free = await newSite("Free Site");
    const row = await assign(second, { site_id: free });
    expect(row.error).toBeNull();
    await expect(
      db.query(
        "update public.worker_assignments set site_id = $2, client_id = null where id = $1",
        [row.data!.id, site],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^MLAS[67]$/) });
  });
});
