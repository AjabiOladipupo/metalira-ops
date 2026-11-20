/**
 * Slice 2.8: changes to a live contract, against the real database.
 * - change_post_requirement: raising Gate A · Night from 1 to 2 guards from next Monday shows 1
 *   before that day and 2 from it in required_shifts, and history keeps both versions. A change
 *   that hasn't started is replaced on the same date; refusals for past dates, nothing changing,
 *   a later change scheduled, a version that started today, dates past the end.
 * - add_post: the rate key must have a line on every version from its start; a client site is
 *   added with it only when asked, and only with a geofence; a draft or another company refused.
 * - close_post: last day inclusive, later requirements removed, reason kept off `posts`.
 * - add_contract_site, the contract_changes log (readers only, insert-only), roles, cross-company.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";
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
let clientId: string;
let otherClientId: string;
let apapa: string;
let gateB: string;

const today = lagosToday();
/** Next Monday (never today). */
const monday = addDays(today, 8 - isoWeekday(today));

const APAPA = { lat: 6.4474, lng: 3.3611 };
const point = (p: { lat: number; lng: number }) => `SRID=4326;POINT(${p.lng} ${p.lat})`;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

async function addMember(user: TestUser, role: "ops_manager" | "hr" | "finance") {
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

/** A Coastline contract live from today: Gate A Day and Night at Apapa, Patrol Night at Gate B. */
async function liveContract(options: { end?: string | null; activate?: boolean } = {}) {
  const { data: id, error } = await ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: "Coastline guarding",
      type: "manned_post",
      start_date: today,
      end_date: options.end ?? null,
    } as Json,
    p_site_ids: [apapa, gateB],
  });
  expect(error).toBeNull();
  const card = await ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: id!,
    p_effective_from: today,
    p_lines: [
      { role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" },
      { role: "Guard", band: "Night", unit: "shift", rate_kobo: "1500000" },
    ] as Json,
  });
  expect(card.error).toBeNull();
  const rows = [
    { site_id: apapa, post_name: "Gate A", band: "Day", start_time: "06:00", end_time: "18:00" },
    { site_id: apapa, post_name: "Gate A", band: "Night", start_time: "18:00", end_time: "06:00" },
    { site_id: gateB, post_name: "Patrol", band: "Night", start_time: "18:00", end_time: "06:00" },
  ];
  for (const row of rows) {
    const { error: rowError } = await ops.client.from("headcount_requirements").insert({
      organisation_id: owner.orgId,
      contract_id: id!,
      role: "Guard",
      unit: "shift",
      days_of_week: EVERY_DAY,
      required_count: 1,
      ...row,
    } as never);
    expect(rowError).toBeNull();
  }
  if (options.activate !== false) {
    const live = await ops.client.rpc("activate_contract", {
      p_organisation_id: owner.orgId,
      p_contract_id: id!,
      p_send_welcome: false,
    });
    expect(live.error).toBeNull();
  }
  return id!;
}

async function postId(contractId: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", contractId)
    .eq("name", name)
    .single();
  expect(error).toBeNull();
  return data!.id;
}

function change(
  post: string,
  from: string,
  count: number,
  by: Client = ops.client,
  extra: { days?: number[]; start?: string; end?: string; org?: string; note?: string } = {},
) {
  return by.rpc("change_post_requirement", {
    p_organisation_id: extra.org ?? owner.orgId,
    p_post_id: post,
    p_from: from,
    p_days: extra.days ?? EVERY_DAY,
    p_start: extra.start ?? "18:00",
    p_end: extra.end ?? "06:00",
    p_count: count,
    ...(extra.note ? { p_note: extra.note } : {}),
  });
}

function addPost(
  contractId: string,
  args: {
    site?: string;
    name?: string | null;
    role?: string;
    band?: string;
    from?: string;
    addSite?: boolean;
    by?: Client;
    org?: string;
  } = {},
) {
  return (args.by ?? ops.client).rpc("add_post", {
    p_organisation_id: args.org ?? owner.orgId,
    p_contract_id: contractId,
    p_site_id: args.site ?? apapa,
    p_post_name: args.name === undefined ? "Gate C" : (args.name ?? ""),
    p_role: args.role ?? "Guard",
    p_band: args.band ?? "Night",
    p_unit: "shift",
    p_from: args.from ?? monday,
    p_days: EVERY_DAY,
    p_start: "18:00",
    p_end: "06:00",
    p_count: 1,
    p_add_site: args.addSite ?? false,
  });
}

function closePost(post: string, lastDay: string, reason = "Client asked to stop the night gate.") {
  return ops.client.rpc("close_post", {
    p_organisation_id: owner.orgId,
    p_post_id: post,
    p_last_day: lastDay,
    p_reason: reason,
  });
}

/** Required people per post name on one day, from required_shifts as ops. */
async function requiredOn(day: string, contractId: string): Promise<Record<string, number>> {
  const { data, error } = await ops.client.rpc("required_shifts", {
    p_organisation_id: owner.orgId,
    p_from: day,
    p_to: day,
  });
  expect(error).toBeNull();
  const out: Record<string, number> = {};
  for (const row of data ?? []) {
    if (row.contract_id === contractId) out[row.post_name] = row.required_count;
  }
  return out;
}

async function versions(post: string) {
  const { data, error } = await admin
    .from("roster_requirements")
    .select("effective_from, effective_to, required_count")
    .eq("post_id", post)
    .order("effective_from");
  expect(error).toBeNull();
  return data ?? [];
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("live-owner", "Live Changes Org");
  other = await createTenantUser("live-other", "Other Live Org");
  ops = await createTestUser("live-ops", "Tunde Ops");
  finance = await createTestUser("live-fin", "Femi Finance");
  hr = await createTestUser("live-hr", "Hauwa HR");
  await addMember(ops, "ops_manager");
  await addMember(finance, "finance");
  await addMember(hr, "hr");

  const { data, error } = await owner.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@coastline.example",
  });
  expect(error).toBeNull();
  clientId = data!;
  const second = await owner.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Greenfield Estates",
  });
  expect(second.error).toBeNull();
  otherClientId = second.data!;
  apapa = await newSite("Apapa Warehouse 3");
  gateB = await newSite("Gate B");
});

afterAll(async () => {
  await db?.end();
});

describe("change_post_requirement", () => {
  it("raising Gate A · Night from 1 to 2 guards from next Monday shows 1 before that day and 2 from it, and history keeps both versions", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    const { data, error } = await change(night, monday, 2, ops.client, {
      note: "Client asked for a second guard at night.",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ effective_from: monday, effective_to: null, replaced_id: null });

    expect((await requiredOn(addDays(monday, -1), id))["Gate A · Night"]).toBe(1);
    expect((await requiredOn(monday, id))["Gate A · Night"]).toBe(2);
    expect((await requiredOn(addDays(monday, 6), id))["Gate A · Night"]).toBe(2);
    // The other posts are untouched.
    expect((await requiredOn(monday, id))["Gate A · Day"]).toBe(1);

    expect(await versions(night)).toEqual([
      { effective_from: today, effective_to: addDays(monday, -1), required_count: 1 },
      { effective_from: monday, effective_to: null, required_count: 2 },
    ]);

    const { data: log } = await admin
      .from("contract_changes")
      .select("kind, effective_on, reason, created_by")
      .eq("post_id", night);
    expect(log).toEqual([
      {
        kind: "requirement_changed",
        effective_on: monday,
        reason: "Client asked for a second guard at night.",
        created_by: ops.id,
      },
    ]);
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, after")
      .eq("entity_id", night)
      .eq("action", "post.requirement_changed");
    expect(audit).toHaveLength(1);
    expect(audit![0]).toMatchObject({
      actor_id: ops.id,
      after: { count: 2, effective_from: monday },
    });
  });

  it("replaces a change that hasn't started when changed again from the same day", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    expect((await change(night, monday, 2)).error).toBeNull();
    const again = await change(night, monday, 3);
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ closed_id: null });
    expect((again.data as { replaced_id: string | null }).replaced_id).not.toBeNull();
    expect(await versions(night)).toEqual([
      { effective_from: today, effective_to: addDays(monday, -1), required_count: 1 },
      { effective_from: monday, effective_to: null, required_count: 3 },
    ]);
  });

  it("changes days and hours as a new version too", async () => {
    const id = await liveContract();
    const day = await postId(id, "Gate A · Day");
    const { error } = await change(day, monday, 1, ops.client, {
      days: [5, 1, 2, 3, 4, 1],
      start: "07:00",
      end: "15:00",
    });
    expect(error).toBeNull();
    const { data } = await admin
      .from("roster_requirements")
      .select("days_of_week, start_time, end_time, duration_minutes")
      .eq("post_id", day)
      .eq("effective_from", monday)
      .single();
    expect(data).toEqual({
      days_of_week: [1, 2, 3, 4, 5],
      start_time: "07:00:00",
      end_time: "15:00:00",
      duration_minutes: 480,
    });
    const saturday = addDays(monday, 5);
    expect((await requiredOn(saturday, id))["Gate A · Day"]).toBeUndefined();
  });

  it("refuses a past date, nothing changing, a version that started today and a later scheduled change", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    expect((await change(night, addDays(today, -1), 2)).error?.code).toBe("MLPC2");
    expect((await change(night, monday, 1)).error?.code).toBe("MLPC9");
    // A day already in progress never changes: tomorrow at the earliest.
    const startedToday = await change(night, today, 2);
    expect(startedToday.error?.code).toBe("MLPC2");
    expect(startedToday.error?.message).toContain("starts tomorrow or later");
    expect((await addPost(id, { from: today })).error?.code).toBe("MLPC2");
    // Notes and reasons never carry web addresses.
    expect(
      (await change(night, addDays(monday, 21), 2, ops.client, { note: "See https://x.example" }))
        .error?.code,
    ).toBe("MLPC7");
    expect((await change(night, addDays(monday, 7), 2)).error).toBeNull();
    const between = await change(night, monday, 3);
    expect(between.error?.code).toBe("MLPC3");
    // Values the table would refuse get a plain reason.
    expect((await change(night, addDays(monday, 14), 0)).error?.code).toBe("MLPC8");
    expect(
      (await change(night, addDays(monday, 14), 2, ops.client, { start: "18:10" })).error?.code,
    ).toBe("MLPC8");
    expect(
      (await change(night, addDays(monday, 14), 2, ops.client, { days: [] })).error?.code,
    ).toBe("MLPC8");
  });

  it("refuses dates past the end, and keeps a changed version inside an ending contract", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    const end = addDays(monday, 3);
    const ended = await ops.client.rpc("end_contract", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_end_date: end,
      p_reason: "Client gave notice.",
    });
    expect(ended.error).toBeNull();
    expect((await change(night, addDays(end, 1), 2)).error?.code).toBe("MLPC2");
    expect((await change(night, monday, 2)).error).toBeNull();
    expect(await versions(night)).toEqual([
      { effective_from: today, effective_to: addDays(monday, -1), required_count: 1 },
      { effective_from: monday, effective_to: end, required_count: 2 },
    ]);
  });

  it("refuses a draft contract, roles that can't edit, and another company", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    expect((await change(night, monday, 2, hr.client)).error?.code).toBe("42501");
    expect((await change(night, monday, 2, finance.client)).error?.code).toBe("42501");
    // Another company's owner: no role here, and in their own company the post isn't found.
    expect((await change(night, monday, 2, other.client)).error?.code).toBe("42501");
    expect((await change(night, monday, 2, other.client, { org: other.orgId })).error?.code).toBe(
      "P0002",
    );
    expect(await versions(night)).toHaveLength(1);

    const draft = await liveContract({ activate: false });
    expect((await addPost(draft)).error?.code).toBe("MLPC1");
  });
});

describe("add_post", () => {
  it("opens a new post from a date, staffed from that day", async () => {
    const id = await liveContract();
    const { data, error } = await addPost(id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ name: "Gate C · Night", opened_on: monday, site_added: false });
    expect((await requiredOn(addDays(monday, -1), id))["Gate C · Night"]).toBeUndefined();
    expect((await requiredOn(monday, id))["Gate C · Night"]).toBe(1);
    const { data: post } = await admin
      .from("posts")
      .select("headcount_requirement_id, status, role, band, unit")
      .eq("id", (data as { post_id: string }).post_id)
      .single();
    expect(post).toEqual({
      headcount_requirement_id: null,
      status: "open",
      role: "Guard",
      band: "Night",
      unit: "shift",
    });
    // The same name again at the same site is refused, ignoring case and spaces.
    expect((await addPost(id, { name: "  gate c " })).error?.code).toBe("MLPC8");
  });

  it("needs a rate line for its key on every rate card version from its start", async () => {
    const id = await liveContract();
    const none = await addPost(id, { role: "Supervisor", band: "Day" });
    expect(none.error?.code).toBe("MLPC4");
    expect(none.error?.message).toContain("No rate for Supervisor · Day (shift)");
    // Keys compare as rate_key_part does.
    expect(
      (await addPost(id, { role: "  GUARD ", band: "night", name: "Gate D" })).error,
    ).toBeNull();

    const later = addDays(monday, 14);
    const card = await ops.client.rpc("add_rate_card_version", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_effective_from: later,
      p_lines: [
        { role: "Guard", band: "Day", unit: "shift", rate_kobo: "1300000" },
        { role: "Guard", band: "Night", unit: "shift", rate_kobo: "1600000" },
        { role: "Dog handler", unit: "shift", rate_kobo: "2000000" },
      ] as Json,
    });
    expect(card.error).toBeNull();
    const gap = await addPost(id, { role: "Dog handler", band: "", name: "Kennel" });
    expect(gap.error?.code).toBe("MLPC4");
    expect(
      (await addPost(id, { role: "Dog handler", band: "", name: "Kennel", from: later })).error,
    ).toBeNull();
  });

  it("adds a client site with a geofence only when asked, and records it", async () => {
    const id = await liveContract();
    const lekki = await newSite("Lekki Gate");
    const notAsked = await addPost(id, { site: lekki });
    expect(notAsked.error?.code).toBe("MLPC5");
    const { data, error } = await addPost(id, { site: lekki, addSite: true });
    expect(error).toBeNull();
    expect(data).toMatchObject({ site_added: true });
    const { data: link } = await admin
      .from("contract_sites")
      .select("site_id")
      .eq("contract_id", id)
      .eq("site_id", lekki);
    expect(link).toHaveLength(1);
    const { data: log } = await admin
      .from("contract_changes")
      .select("kind")
      .eq("contract_id", id)
      .order("created_at");
    expect(log?.map((l) => l.kind)).toEqual(["site_added", "post_added"]);

    const unfenced = await newSite("Ikoyi Gate", clientId, false);
    const noFence = await addPost(id, { site: unfenced, addSite: true });
    expect(noFence.error?.code).toBe("MLPC5");
    expect(noFence.error?.message).toContain("No geofence at Ikoyi Gate");
    const elsewhere = await newSite("Greenfield Gate", otherClientId);
    expect((await addPost(id, { site: elsewhere, addSite: true })).error?.code).toBe("MLPC5");
    const archived = await newSite("Old Gate");
    await admin.from("sites").update({ status: "archived" }).eq("id", archived);
    expect((await addPost(id, { site: archived, addSite: true })).error?.code).toBe("MLPC5");
  });

  it("closes a post added to an ending contract with it, and refuses after the end", async () => {
    const id = await liveContract();
    const end = addDays(monday, 3);
    expect(
      (
        await ops.client.rpc("end_contract", {
          p_organisation_id: owner.orgId,
          p_contract_id: id,
          p_end_date: end,
          p_reason: "Client gave notice.",
        })
      ).error,
    ).toBeNull();
    expect((await addPost(id, { from: addDays(end, 1) })).error?.code).toBe("MLPC2");
    const { data, error } = await addPost(id);
    expect(error).toBeNull();
    const { data: post } = await admin
      .from("posts")
      .select("status, closed_on, roster_requirements(effective_to)")
      .eq("id", (data as { post_id: string }).post_id)
      .single();
    expect(post).toEqual({
      status: "closed",
      closed_on: end,
      roster_requirements: [{ effective_to: end }],
    });
  });

  it("refuses hr and another company", async () => {
    const id = await liveContract();
    expect((await addPost(id, { by: hr.client })).error?.code).toBe("42501");
    expect((await addPost(id, { by: other.client })).error?.code).toBe("42501");
    expect((await addPost(id, { by: other.client, org: other.orgId })).error?.code).toBe("P0002");
  });
});

describe("close_post", () => {
  it("closes after the last day, removes later changes and keeps the reason off the post", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    expect((await change(night, addDays(monday, 7), 2)).error).toBeNull();
    const { data, error } = await closePost(night, monday);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      closed_on: monday,
      requirements_cancelled: 1,
      requirements_closed: 1,
    });
    expect(await versions(night)).toEqual([
      { effective_from: today, effective_to: monday, required_count: 1 },
    ]);
    expect((await requiredOn(monday, id))["Gate A · Night"]).toBe(1);
    expect((await requiredOn(addDays(monday, 1), id))["Gate A · Night"]).toBeUndefined();

    const { data: post } = await admin
      .from("posts")
      .select("status, closed_on, closed_reason")
      .eq("id", night)
      .single();
    expect(post).toEqual({ status: "closed", closed_on: monday, closed_reason: "Post closed" });
    // hr reads the post but not the reason; finance reads the reason.
    const hrPost = await hr.client.from("posts").select("closed_reason").eq("id", night).single();
    expect(hrPost.data?.closed_reason).toBe("Post closed");
    const hrLog = await hr.client.from("contract_changes").select("reason").eq("post_id", night);
    expect(hrLog.data).toEqual([]);
    const finLog = await finance.client
      .from("contract_changes")
      .select("reason")
      .eq("post_id", night)
      .eq("kind", "post_closed");
    expect(finLog.data).toEqual([{ reason: "Client asked to stop the night gate." }]);

    expect((await closePost(night, addDays(monday, 2))).error?.code).toBe("MLPC6");
    // A closed post takes no changes after its last day.
    expect((await change(night, addDays(monday, 1), 3)).error?.code).toBe("MLPC6");
  });

  it("refuses a past day, a missing reason and a day at or after the contract's end", async () => {
    const id = await liveContract({ end: addDays(monday, 20) });
    const day = await postId(id, "Gate A · Day");
    expect((await closePost(day, addDays(today, -1))).error?.code).toBe("MLPC2");
    expect((await closePost(day, monday, "  ")).error?.code).toBe("MLPC7");
    expect((await closePost(day, addDays(monday, 20))).error?.code).toBe("MLPC2");
    expect((await closePost(day, today)).error).toBeNull();
  });

  it("closes a post that hasn't opened as never staffed", async () => {
    const id = await liveContract();
    const added = await addPost(id, { from: addDays(monday, 7) });
    const post = (added.data as { post_id: string }).post_id;
    expect((await closePost(post, addDays(monday, 6))).error).toBeNull();
    expect(await versions(post)).toEqual([]);
    expect(
      (await closePost(await postId(id, "Gate A · Day"), today, "x".repeat(501))).error?.code,
    ).toBe("MLPC7");
  });
});

describe("review fixes: closing earlier, overlapping names, sites, reasons", () => {
  it("an earlier end_contract brings forward a post already closed later by close_post", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    expect((await closePost(night, addDays(monday, 10))).error).toBeNull();
    const end = addDays(monday, 3);
    const ended = await ops.client.rpc("end_contract", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_end_date: end,
      p_reason: "Client gave notice.",
    });
    expect(ended.error).toBeNull();
    const { data: post } = await admin
      .from("posts")
      .select("status, closed_on, closed_reason")
      .eq("id", night)
      .single();
    expect(post).toEqual({ status: "closed", closed_on: end, closed_reason: "Post closed" });
    expect(await versions(night)).toEqual([
      { effective_from: today, effective_to: end, required_count: 1 },
    ]);
    expect((await requiredOn(addDays(end, 1), id))["Gate A · Night"]).toBeUndefined();
  });

  it("close_post brings a post of an ending contract forward, never later", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    const end = addDays(monday, 10);
    expect(
      (
        await ops.client.rpc("end_contract", {
          p_organisation_id: owner.orgId,
          p_contract_id: id,
          p_end_date: end,
          p_reason: "Client gave notice.",
        })
      ).error,
    ).toBeNull();
    expect((await closePost(night, monday)).error).toBeNull();
    const { data: post } = await admin
      .from("posts")
      .select("closed_on, closed_reason")
      .eq("id", night)
      .single();
    expect(post).toEqual({ closed_on: monday, closed_reason: "Post closed" });
    expect(await versions(night)).toEqual([
      { effective_from: today, effective_to: monday, required_count: 1 },
    ]);
    // Never later again, and the database owner can't move it either outside the functions.
    expect((await closePost(night, addDays(monday, 2))).error?.code).toBe("MLPC6");
    await expect(
      db.query("update public.posts set closed_on = closed_on - 1 where id = $1", [night]),
    ).rejects.toMatchObject({ code: "MLPO1" });
  });

  it("refuses a post name still staffed on or after the new post's first day", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    expect((await closePost(night, addDays(monday, 5))).error).toBeNull();
    const clash = await addPost(id, { name: "Gate A", from: monday });
    expect(clash.error?.code).toBe("MLPC8");
    expect((await addPost(id, { name: "Gate A", from: addDays(monday, 6) })).error).toBeNull();
  });

  it("refuses a post at a contract site that has lost its geofence", async () => {
    const id = await liveContract();
    const yaba = await newSite("Yaba Annex");
    expect(
      (
        await ops.client.rpc("add_contract_site", {
          p_organisation_id: owner.orgId,
          p_contract_id: id,
          p_site_id: yaba,
        })
      ).error,
    ).toBeNull();
    await db.query("update public.sites set centre = null, boundary = null where id = $1", [yaba]);
    const refused = await addPost(id, { site: yaba });
    expect(refused.error?.code).toBe("MLPC5");
    expect(refused.error?.message).toContain("No geofence at Yaba Annex");
  });

  it("refuses web addresses in a closing reason", async () => {
    const id = await liveContract();
    const day = await postId(id, "Gate A · Day");
    expect((await closePost(day, monday, "Details at www.example.com")).error?.code).toBe("MLPC7");
  });
});

describe("cancel_post_requirement_change", () => {
  function cancel(requirement: string, by: Client = ops.client) {
    return by.rpc("cancel_post_requirement_change", {
      p_organisation_id: owner.orgId,
      p_requirement_id: requirement,
      p_note: "Client changed their mind.",
    });
  }

  it("takes back a scheduled change and runs the version before it on", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    const changed = await change(night, monday, 2);
    expect(changed.error).toBeNull();
    const scheduled = (changed.data as { requirement_id: string }).requirement_id;
    expect((await cancel(scheduled, hr.client)).error?.code).toBe("42501");
    expect((await cancel(scheduled, other.client)).error?.code).toBe("42501");
    const { data, error } = await cancel(scheduled);
    expect(error).toBeNull();
    expect(data).toMatchObject({ cancelled_id: scheduled, effective_from: monday });
    expect(await versions(night)).toEqual([
      { effective_from: today, effective_to: null, required_count: 1 },
    ]);
    expect((await requiredOn(monday, id))["Gate A · Night"]).toBe(1);
    const { data: log } = await admin
      .from("contract_changes")
      .select("kind, effective_on")
      .eq("post_id", night)
      .order("created_at");
    expect(log?.map((l) => l.kind)).toEqual(["requirement_changed", "requirement_cancelled"]);
    expect((await cancel(scheduled)).error?.code).toBe("P0002");
  });

  it("refuses a change with a later one after it, and a post's first requirement", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    const first = await change(night, monday, 2);
    expect((await change(night, addDays(monday, 7), 3)).error).toBeNull();
    const refused = await cancel((first.data as { requirement_id: string }).requirement_id);
    expect(refused.error?.code).toBe("MLPC3");

    const added = await addPost(id, { from: addDays(monday, 7) });
    const { data: req } = await admin
      .from("roster_requirements")
      .select("id")
      .eq("post_id", (added.data as { post_id: string }).post_id)
      .single();
    const firstReq = await cancel(req!.id);
    expect(firstReq.error?.code).toBe("MLPC3");
    expect(firstReq.error?.message).toContain("Close the post instead");
  });
});

describe("add_contract_site and the change log", () => {
  it("adds a site to a live contract only through the function", async () => {
    const id = await liveContract();
    const yaba = await newSite("Yaba Depot");
    const direct = await ops.client
      .from("contract_sites")
      .insert({ organisation_id: owner.orgId, contract_id: id, site_id: yaba });
    expect(direct.error?.code).toBe("MLCO3");
    const { error } = await ops.client.rpc("add_contract_site", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_site_id: yaba,
      p_note: "New depot from January.",
    });
    expect(error).toBeNull();
    const again = await ops.client.rpc("add_contract_site", {
      p_organisation_id: owner.orgId,
      p_contract_id: id,
      p_site_id: yaba,
    });
    expect(again.error?.code).toBe("MLPC5");
    // A live contract's sites are never taken off.
    const remove = await ops.client
      .from("contract_sites")
      .delete()
      .eq("contract_id", id)
      .eq("site_id", yaba);
    expect(remove.error?.code).toBe("MLCO3");
    expect(
      (
        await hr.client.rpc("add_contract_site", {
          p_organisation_id: owner.orgId,
          p_contract_id: id,
          p_site_id: yaba,
        })
      ).error?.code,
    ).toBe("42501");
  });

  it("keeps the change log insert-only and unwritable by any role", async () => {
    const id = await liveContract();
    const night = await postId(id, "Gate A · Night");
    expect((await change(night, monday, 2)).error).toBeNull();
    const insert = await ops.client.from("contract_changes").insert({
      organisation_id: owner.orgId,
      contract_id: id,
      post_id: night,
      site_id: apapa,
      kind: "post_added",
      effective_on: monday,
    } as never);
    expect(insert.error?.code).toBe("42501");
    const { data: row } = await admin
      .from("contract_changes")
      .select("id")
      .eq("post_id", night)
      .single();
    await expect(
      db.query("update public.contract_changes set reason = 'x' where id = $1", [row!.id]),
    ).rejects.toMatchObject({ code: "MLPO1" });
    await expect(
      db.query("delete from public.contract_changes where id = $1", [row!.id]),
    ).rejects.toMatchObject({ code: "MLPO1" });
  });
});
