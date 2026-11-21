/**
 * Slice 4.5: approved leave opens shifts (docs/PHASE_4.md 4.5) against the real database.
 * - HR's final approval takes the worker off exactly the range's assigned shifts (removed,
 *   removed_reason on_leave, removed_by the approver) and nothing outside it; its dry run lists
 *   them and changes nothing.
 * - Past days, and a shift today that has already started, are left as they are.
 * - The guard refuses an assignment onto approved leave (MLRSL, "On approved leave ..."), and
 *   copy_last_week lists those as skipped.
 * - A declined or cancelled request removes nothing.
 * - roster_leave and roster_leave_removals: roster builders only; worker ids and dates.
 * - Decision 13: publish and "Send notices again" leave out workers whose employment ended.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";
import { toPublishResult } from "@/lib/roster-publish";
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
const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let hr: TestUser;
let apapa: string;
let contractId: string;
let annual: string;
const post = {} as Record<"day" | "night", string>;
let counter = 0;

const today = lagosToday();
/** Next Monday (never today). */
const monday = addDays(today, 8 - isoWeekday(today));
const day = (n: number) => addDays(monday, n);
/** Every date the tests use stays inside this calendar year (a request lies inside one year). */
const roomInYear =
  day(20).slice(0, 4) === today.slice(0, 4) && addDays(today, -1).slice(0, 4) === today.slice(0, 4);

async function addMember(orgId: string, user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function addWorker(name: string): Promise<string> {
  counter += 1;
  const [first, last] = name.split(" ");
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `LR-${String(counter).padStart(4, "0")}-${randomUUID().slice(0, 4)}`,
      first_name: first!,
      last_name: last!,
      employment_type: "permanent",
      start_date: "2025-01-06",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const map = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: data!.id,
    site_id: apapa,
    effective_from: "2025-01-06",
  });
  expect(map.error).toBeNull();
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

function assign(postId: string, date: string, workerId: string) {
  return ops.client.rpc("assign_worker_to_shift", {
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

/** The worker asks from the phone, the ops manager decides step 1 (no line manager). */
async function askAndPassStep1(workerId: string, from: string, to: string): Promise<string> {
  const phone = await workerSession(workerId);
  const { data, error } = await phone.rpc("request_leave", {
    p_organisation_id: owner.orgId,
    p_leave_type_id: annual,
    p_start_date: from,
    p_end_date: to,
  });
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  const step1 = await ops.client.rpc("decide_leave_line_manager", {
    p_organisation_id: owner.orgId,
    p_request_id: id,
    p_decision: "approved",
  });
  expect(step1.error).toBeNull();
  return id;
}

function decideHr(requestId: string, decision: "approved" | "declined", dryRun = false) {
  return hr.client.rpc("decide_leave_hr", {
    p_organisation_id: owner.orgId,
    p_request_id: requestId,
    p_decision: decision,
    p_note: decision === "declined" ? "Short of cover" : undefined,
    p_dry_run: dryRun,
  });
}

async function rows(ids: string[]) {
  const { data, error } = await admin
    .from("shift_assignments")
    .select("id, status, removed_reason, removed_by, shift_date")
    .in("id", ids);
  expect(error).toBeNull();
  return new Map(data!.map((r) => [r.id, r] as const));
}

/** A shift and assignment written in this transaction only with triggers off (past or started). */
async function seedAssignment(workerId: string, date: string, startsAt: Date, endsAt: Date) {
  const shift = randomUUID();
  const assignment = randomUUID();
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.shifts (id, organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1)
       on conflict (post_id, shift_date) do nothing`,
      [shift, owner.orgId, post.night, contractId, apapa, date, startsAt, endsAt],
    );
    const { rows: s } = await db.query<{ id: string }>(
      "select id from public.shifts where post_id = $1 and shift_date = $2",
      [post.night, date],
    );
    await db.query(
      `insert into public.shift_assignments (id, organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'assigned')`,
      [assignment, owner.orgId, s[0]!.id, apapa, date, workerId, startsAt, endsAt],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  return assignment;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("lr-owner", "Leave Roster Org");
  other = await createTenantUser("lr-other", "Other Leave Roster Org");
  ops = await createTestUser("lr-ops", "Tunde Ops");
  hr = await createTestUser("lr-hr", "Hauwa HR");
  await addMember(owner.orgId, ops, "ops_manager");
  await addMember(owner.orgId, hr, "hr");

  const preset = await owner.client.rpc("apply_leave_preset", {
    p_organisation_id: owner.orgId,
    p_preset: "B",
  });
  expect(preset.error).toBeNull();
  annual = (
    await admin
      .from("leave_types")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("code", "annual")
      .single()
  ).data!.id;

  const client = await ops.client.rpc("create_client", {
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
      centre: CENTRE,
    } as never)
    .select("id")
    .single();
  expect(site.error).toBeNull();
  apapa = site.data!.id;
  const contract = await ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: client.data!,
      name: "Coastline guarding",
      type: "manned_post",
      start_date: today,
    } as Json,
    p_site_ids: [apapa],
  });
  expect(contract.error).toBeNull();
  contractId = contract.data!;
  const card = await ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: contractId,
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
    const row = await ops.client.from("headcount_requirements").insert({
      organisation_id: owner.orgId,
      contract_id: contractId,
      site_id: apapa,
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
  const live = await ops.client.rpc("activate_contract", {
    p_organisation_id: owner.orgId,
    p_contract_id: contractId,
    p_send_welcome: false,
  });
  expect(live.error).toBeNull();
  const posts = await admin.from("posts").select("id, name").eq("contract_id", contractId);
  expect(posts.error).toBeNull();
  post.day = posts.data!.find((p) => p.name === "Gate A · Day")!.id;
  post.night = posts.data!.find((p) => p.name === "Gate A · Night")!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("HR's approval opens the range's shifts", () => {
  let musa: string;
  let ids: string[];
  let requestId: string;

  it("the dry run lists exactly the range's shifts and changes nothing", async () => {
    if (!roomInYear) return;
    musa = await addWorker("Musa Ibrahim");
    ids = [];
    for (let n = 0; n <= 4; n += 1) ids.push(await assigned(post.day, day(n), musa));
    requestId = await askAndPassStep1(musa, day(1), day(3));

    const dry = await decideHr(requestId, "approved", true);
    expect(dry.error).toBeNull();
    const open = (
      dry.data as { open_shifts: { assignment_id: string; post_name: string; site_name: string }[] }
    ).open_shifts;
    expect(open.map((s) => s.assignment_id).sort()).toEqual([ids[1], ids[2], ids[3]].sort());
    expect(open[0]!.post_name).toBe("Gate A · Day");
    expect(open[0]!.site_name).toBe("Apapa Warehouse 3");
    for (const r of (await rows(ids)).values()) expect(r.status).toBe("assigned");
  });

  it("approving removes exactly those, on_leave, by the approver; nothing outside the range", async () => {
    if (!roomInYear) return;
    const approved = await decideHr(requestId, "approved");
    expect(approved.error).toBeNull();
    expect((approved.data as { open_shifts: unknown[] }).open_shifts).toHaveLength(3);
    const after = await rows(ids);
    for (const id of [ids[1]!, ids[2]!, ids[3]!]) {
      expect(after.get(id)!.status).toBe("removed");
      expect(after.get(id)!.removed_reason).toBe("on_leave");
      expect(after.get(id)!.removed_by).toBe(hr.id);
    }
    expect(after.get(ids[0]!)!.status).toBe("assigned");
    expect(after.get(ids[4]!)!.status).toBe("assigned");

    const { rows: audit } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log
       where organisation_id = $1 and action = 'roster.opened_by_leave' and entity_id = $2`,
      [owner.orgId, requestId],
    );
    expect(audit[0]!.n).toBe(1);
  });

  it("the guard refuses an assignment onto the leave, with the dates", async () => {
    if (!roomInYear) return;
    const { error } = await assign(post.night, day(2), musa);
    expect(error?.code).toBe("MLRSL");
    expect(error?.message).toMatch(/^On approved leave \d+ (to \d+ )?\w{3}/);
    // The secret key goes through the guard too.
    const shift = await admin
      .from("shifts")
      .select("id")
      .eq("post_id", post.day)
      .eq("shift_date", day(2))
      .single();
    const direct = await admin.from("shift_assignments").insert({
      organisation_id: owner.orgId,
      shift_id: shift.data!.id,
      site_id: apapa,
      shift_date: day(2),
      worker_id: musa,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(direct.error?.code).toBe("MLRSL");
  });

  it("the roster reads show the leave and the opened shifts to roster builders only", async () => {
    if (!roomInYear) return;
    const leave = await ops.client.rpc("roster_leave", {
      p_organisation_id: owner.orgId,
      p_from: monday,
      p_to: day(6),
    });
    expect(leave.error).toBeNull();
    expect(leave.data).toContainEqual({
      worker_id: musa,
      start_date: day(1),
      end_date: day(3),
      status: "approved",
    });
    const removals = await ops.client.rpc("roster_leave_removals", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_from: monday,
      p_to: day(6),
    });
    expect(removals.error).toBeNull();
    expect(removals.data!.map((r) => r.assignment_id).sort()).toEqual(
      [ids[1], ids[2], ids[3]].sort(),
    );

    for (const caller of [hr.client, other.client]) {
      const refused = await caller.rpc("roster_leave", {
        p_organisation_id: owner.orgId,
        p_from: monday,
        p_to: day(6),
      });
      expect(refused.error?.code).toBe("42501");
    }
    const anon = await anonClient().rpc("roster_leave_removals", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_from: monday,
      p_to: day(6),
    });
    expect(anon.error).not.toBeNull();
  });
});

describe("what approval leaves alone", () => {
  it("past days and a shift today that has started stay assigned", async () => {
    if (!roomInYear) return;
    const kemi = await addWorker("Kemi Ade");
    const hour = 3_600_000;
    const past = await seedAssignment(
      kemi,
      addDays(today, -1),
      new Date(Date.now() - 30 * hour),
      new Date(Date.now() - 18 * hour),
    );
    const started = await seedAssignment(
      kemi,
      today,
      new Date(Date.now() - hour),
      new Date(Date.now() + 11 * hour),
    );
    const future = await assigned(post.day, day(1), kemi);

    // A request starting yesterday can't be asked for; written as HR would find it.
    const { rows: req } = await db.query<{ id: string }>(
      `insert into public.leave_requests (organisation_id, worker_id, leave_type_id, leave_year,
         start_date, end_date, days, pay_percent)
       values ($1, $2, $3, $4, $5, $6, 3, 100) returning id`,
      [owner.orgId, kemi, annual, Number(today.slice(0, 4)), addDays(today, -1), day(1)],
    );
    await db.query("update public.leave_requests set status = 'pending_hr' where id = $1", [
      req[0]!.id,
    ]);
    const approved = await decideHr(req[0]!.id, "approved");
    expect(approved.error).toBeNull();
    const after = await rows([past, started, future]);
    expect(after.get(past)!.status).toBe("assigned");
    expect(after.get(started)!.status).toBe("assigned");
    expect(after.get(future)!.status).toBe("removed");
    expect(after.get(future)!.removed_reason).toBe("on_leave");
  });

  it("a declined request removes nothing", async () => {
    if (!roomInYear) return;
    const ada = await addWorker("Ada Obi");
    const a1 = await assigned(post.day, day(5), ada);
    const id = await askAndPassStep1(ada, day(5), day(5));
    const dry = await decideHr(id, "declined", true);
    expect((dry.data as { open_shifts: unknown[] }).open_shifts).toEqual([]);
    expect((await decideHr(id, "declined")).error).toBeNull();
    expect((await rows([a1])).get(a1)!.status).toBe("assigned");
    expect((await assign(post.night, day(6), ada)).error).toBeNull();
  });

  it("a cancelled request removes nothing and doesn't block assigning", async () => {
    if (!roomInYear) return;
    const yusuf = await addWorker("Yusuf Bello");
    const a1 = await assigned(post.night, day(4), yusuf);
    const id = await askAndPassStep1(yusuf, day(4), day(5));
    const cancel = await hr.client.rpc("cancel_leave_request", {
      p_organisation_id: owner.orgId,
      p_request_id: id,
      p_reason: "Plans changed",
    });
    expect(cancel.error).toBeNull();
    expect((await rows([a1])).get(a1)!.status).toBe("assigned");
    expect((await assign(post.night, day(5), yusuf)).error).toBeNull();
  });
});

describe("copy_last_week skips approved leave", () => {
  it("lists a worker on approved leave in the new week as skipped (MLRSL)", async () => {
    if (!roomInYear) return;
    const sule = await addWorker("Sule Musa");
    // Week one: Sule on the night post Tuesday and Wednesday (no one else is on those).
    await assigned(post.night, day(1), sule);
    await assigned(post.night, day(2), sule);
    // Approved leave on the same weekdays of week two.
    const id = await askAndPassStep1(sule, day(8), day(9));
    expect((await decideHr(id, "approved")).error).toBeNull();

    const dry = await ops.client.rpc("copy_last_week", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: day(7),
      p_dry_run: true,
    });
    expect(dry.error).toBeNull();
    const skipped = (
      dry.data as { skipped: { worker_id: string; code: string; reason: string }[] }
    ).skipped.filter((s) => s.worker_id === sule);
    expect(skipped.map((s) => s.code)).toEqual(["MLRSL", "MLRSL"]);
    expect(skipped[0]!.reason).toMatch(/^On approved leave /);
  });
});

describe("decision 13: publishing never tells a leaver", () => {
  it("leaves out a worker whose employment ended, in publish and in Send notices again", async () => {
    if (!roomInYear) return;
    const week = day(14);
    const tobi = await addWorker("Tobi Lawal");
    const bola = await addWorker("Bola Ade");
    await assigned(post.day, addDays(week, 0), tobi);
    const first = await ops.client.rpc("publish_roster", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: week,
      p_dry_run: false,
    });
    expect(first.error).toBeNull();

    // Tobi leaves after the publish; a change for both is published next.
    const ended = await hr.client.rpc("end_employment", {
      p_organisation_id: owner.orgId,
      p_worker_id: tobi,
      p_end_date: today,
    });
    expect(ended.error).toBeNull();
    await assigned(post.night, addDays(week, 1), bola);
    const tobiRow = await admin
      .from("shift_assignments")
      .select("id")
      .eq("worker_id", tobi)
      .eq("status", "assigned")
      .limit(1)
      .single();
    const removed = await ops.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: tobiRow.data!.id,
    });
    expect(removed.error).toBeNull();

    const second = await ops.client.rpc("publish_roster", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: week,
      p_dry_run: false,
    });
    expect(second.error).toBeNull();
    const affected = toPublishResult(second.data).affected.map((a) => a.workerId);
    expect(affected).toContain(bola);
    expect(affected).not.toContain(tobi);

    const again = await ops.client.rpc("roster_notice_targets", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: week,
    });
    expect(again.error).toBeNull();
    expect(toPublishResult(again.data).affected.map((a) => a.workerId)).not.toContain(tobi);
  });
});
