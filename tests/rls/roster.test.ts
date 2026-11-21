/**
 * Slice 3.2: the roster against the real database.
 * - assign_worker_to_shift makes the shift row on the first assignment, copies the requirement's
 *   times, and flags (never refuses) a worker not mapped to the site; remove_assignment keeps the
 *   row, marked removed with who and why. Rows are never deleted.
 * - Refusals: double-booking (an overnight shift included), more people than required, a worker
 *   who has left or hasn't started, a closed post, an archived site, nothing written directly.
 * - A later requirement change is read live: raising the count lets a second person on; a
 *   replaced version leaves the shift row with its old times and no requirement.
 * - copy_last_week: copies what it can, lists what it can't and why, counts what is already
 *   there, and its dry run writes nothing.
 * - Who reads what: owner, admin and ops_manager everything; a line manager their reportees'
 *   assignments and the shifts at their sites; a worker only their own rows; hr nothing; another
 *   company nothing, and it can't write.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";
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
let lineManager: TestUser;
let clientId: string;
let apapa: string;
let lekki: string;
let contractId: string;
const post = {} as Record<"day" | "night" | "early" | "patrol", string>;
const worker = {} as Record<"a" | "b" | "c" | "d" | "e" | "f" | "leaver" | "newcomer", string>;
let counter = 0;

const today = lagosToday();
/** Next Monday (never today): week one. */
const monday = addDays(today, 8 - isoWeekday(today));
const day = (n: number) => addDays(monday, n);
/** Lagos wall clock as a timestamp. */
const lagos = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`).getTime();

async function addMember(user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function addWorker(
  name: string,
  fields: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
  mappedTo: string | null = apapa,
): Promise<string> {
  counter += 1;
  const [first, last] = name.split(" ");
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `RS-${String(counter).padStart(4, "0")}`,
      first_name: first!,
      last_name: last!,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  if (mappedTo) {
    const map = await admin.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: data!.id,
      site_id: mappedTo,
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

/** A contract live from today at `site`, with the given headcount rows (every day, 1 person). */
async function liveContract(
  site: string,
  rows: { post_name: string; band: string; start_time: string; end_time: string }[],
): Promise<string> {
  const { data: id, error } = await ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: "Coastline guarding",
      type: "manned_post",
      start_date: today,
    } as Json,
    p_site_ids: [site],
  });
  expect(error).toBeNull();
  const bands = [...new Set(rows.map((r) => r.band))];
  const card = await ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: id!,
    p_effective_from: today,
    p_lines: bands.map((band) => ({
      role: "Guard",
      band,
      unit: "shift",
      rate_kobo: "1250000",
    })) as Json,
  });
  expect(card.error).toBeNull();
  for (const row of rows) {
    const { error: rowError } = await ops.client.from("headcount_requirements").insert({
      organisation_id: owner.orgId,
      contract_id: id!,
      site_id: site,
      role: "Guard",
      unit: "shift",
      days_of_week: EVERY_DAY,
      required_count: 1,
      ...row,
    } as never);
    expect(rowError).toBeNull();
  }
  const live = await ops.client.rpc("activate_contract", {
    p_organisation_id: owner.orgId,
    p_contract_id: id!,
    p_send_welcome: false,
  });
  expect(live.error).toBeNull();
  return id!;
}

async function postId(contract: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", contract)
    .eq("name", name)
    .single();
  expect(error).toBeNull();
  return data!.id;
}

function assign(
  postIdValue: string,
  date: string,
  workerId: string,
  by: Client = ops.client,
  org?: string,
) {
  return by.rpc("assign_worker_to_shift", {
    p_organisation_id: org ?? owner.orgId,
    p_post_id: postIdValue,
    p_shift_date: date,
    p_worker_id: workerId,
  });
}

async function assigned(postIdValue: string, date: string, workerId: string): Promise<string> {
  const { data, error } = await assign(postIdValue, date, workerId);
  expect(error).toBeNull();
  return String((data as { assignment_id: string }).assignment_id);
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("roster-owner", "Roster Org");
  other = await createTenantUser("roster-other", "Other Roster Org");
  ops = await createTestUser("roster-ops", "Tunde Ops");
  hr = await createTestUser("roster-hr", "Hauwa HR");
  lineManager = await createTestUser("roster-lm", "Lami Supervisor");
  await addMember(ops, "ops_manager");
  await addMember(hr, "hr");
  await addMember(lineManager, "line_manager");

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
    .insert(
      ["Apapa Warehouse 3", "Lekki Gate"].map((name) => ({
        organisation_id: owner.orgId,
        client_id: clientId,
        name,
        centre: CENTRE,
      })) as never,
    )
    .select("id, name");
  expect(sites.error).toBeNull();
  apapa = sites.data!.find((s) => s.name === "Apapa Warehouse 3")!.id;
  lekki = sites.data!.find((s) => s.name === "Lekki Gate")!.id;

  contractId = await liveContract(apapa, [
    { post_name: "Gate A", band: "Day", start_time: "06:00", end_time: "18:00" },
    { post_name: "Gate A", band: "Night", start_time: "18:00", end_time: "06:00" },
    { post_name: "Gate A", band: "Early", start_time: "05:00", end_time: "13:00" },
    { post_name: "Patrol", band: "Day", start_time: "08:00", end_time: "16:00" },
  ]);
  post.day = await postId(contractId, "Gate A · Day");
  post.night = await postId(contractId, "Gate A · Night");
  post.early = await postId(contractId, "Gate A · Early");
  post.patrol = await postId(contractId, "Patrol · Day");

  const lmMembership = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", lineManager.id)
    .single();
  worker.a = await addWorker("Musa Ibrahim", {
    line_manager_membership_id: lmMembership.data!.id,
  });
  worker.b = await addWorker("Daniel Okafor");
  worker.c = await addWorker("Peter Adams", { end_date: day(6) });
  worker.d = await addWorker("Sule Musa");
  worker.e = await addWorker("Ngozi Eze");
  worker.f = await addWorker("Kunle Ade", {}, null);
  worker.leaver = await addWorker("Bayo Kola", { end_date: day(1) });
  worker.newcomer = await addWorker("Ada Obi", { start_date: day(3) });
});

afterAll(async () => {
  await db?.end();
});

describe("assign and remove", () => {
  it("makes the shift on the first assignment with the requirement's times, then removes without deleting", async () => {
    const { data, error } = await assign(post.day, day(0), worker.a);
    expect(error).toBeNull();
    const result = data as { assignment_id: string; shift_id: string; mapped: boolean };
    expect(result.mapped).toBe(true);

    const shift = await admin
      .from("shifts")
      .select(
        "post_id, site_id, shift_date, starts_at, ends_at, required_count, status, requirement_id",
      )
      .eq("id", result.shift_id)
      .single();
    expect(shift.data).toMatchObject({
      post_id: post.day,
      site_id: apapa,
      shift_date: day(0),
      required_count: 1,
      status: "open",
    });
    expect(Date.parse(shift.data!.starts_at)).toBe(lagos(day(0), "06:00"));
    expect(Date.parse(shift.data!.ends_at)).toBe(lagos(day(0), "18:00"));
    expect(shift.data!.requirement_id).not.toBeNull();

    const row = await admin
      .from("shift_assignments")
      .select("status, assigned_by, starts_at, ends_at, site_id, shift_date")
      .eq("id", result.assignment_id)
      .single();
    expect(row.data).toMatchObject({ status: "assigned", assigned_by: ops.id, site_id: apapa });
    expect(Date.parse(row.data!.starts_at)).toBe(lagos(day(0), "06:00"));

    const removed = await ops.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: result.assignment_id,
      p_reason: "Swapped with the night team.",
    });
    expect(removed.error).toBeNull();
    const after = await admin
      .from("shift_assignments")
      .select("status, removed_by, removed_reason, removed_at")
      .eq("id", result.assignment_id)
      .single();
    expect(after.data).toMatchObject({
      status: "removed",
      removed_by: ops.id,
      removed_reason: "Swapped with the night team.",
    });
    expect(after.data!.removed_at).not.toBeNull();

    const again = await ops.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: result.assignment_id,
    });
    expect(again.error?.code).toBe("MLRS8");

    await expect(
      db.query("delete from public.shift_assignments where id = $1", [result.assignment_id]),
    ).rejects.toMatchObject({ code: "MLRS8" });
    await expect(
      db.query("delete from public.shifts where id = $1", [result.shift_id]),
    ).rejects.toMatchObject({ code: "MLRS1" });

    // Free again: the same worker can go back on.
    const back = await assign(post.day, day(0), worker.a);
    expect(back.error).toBeNull();
    expect((back.data as { shift_id: string }).shift_id).toBe(result.shift_id);
  });

  it("flags a worker not mapped to the site, but assigns them", async () => {
    const { data, error } = await assign(post.patrol, day(0), worker.f);
    expect(error).toBeNull();
    expect((data as { mapped: boolean }).mapped).toBe(false);
  });

  it("refuses reasons with web addresses", async () => {
    const id = await assigned(post.patrol, day(5), worker.e);
    const { error } = await ops.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: id,
      p_reason: "See www.example.com",
    });
    expect(error?.code).toBe("MLRS0");
  });
});

describe("refusals", () => {
  it("refuses double-booking, an overnight shift running into the next morning included", async () => {
    await assigned(post.night, day(1), worker.b);
    // Tuesday night 18:00 to Wednesday 06:00; Wednesday's early shift starts at 05:00.
    const clash = await assign(post.early, day(2), worker.b);
    expect(clash.error?.code).toBe("MLRS5");
    expect(clash.error?.message).toContain("Gate A · Night");
    // Back to back is fine: Wednesday's day shift starts at 06:00 as the night ends.
    expect((await assign(post.day, day(2), worker.b)).error).toBeNull();
  });

  it("refuses more people than the requirement asks for, and the same worker twice", async () => {
    await assigned(post.day, day(3), worker.d);
    const full = await assign(post.day, day(3), worker.e);
    expect(full.error?.code).toBe("MLRS4");
    const twice = await assign(post.day, day(3), worker.d);
    expect(twice.error?.code).toBe("MLRS7");
  });

  it("refuses a worker who has left or hasn't started by the day", async () => {
    expect((await assign(post.patrol, day(2), worker.leaver)).error?.code).toBe("MLRS2");
    expect((await assign(post.patrol, day(1), worker.leaver)).error).toBeNull();
    expect((await assign(post.patrol, day(2), worker.newcomer)).error?.code).toBe("MLRS2");

    const gone = await addWorker("Halima Bello", { status: "ended", end_date: today });
    const refused = await assign(post.night, day(4), gone);
    expect(refused.error?.code).toBe("MLRS2");
  });

  it("refuses a day the post isn't staffed", async () => {
    const before = await assign(post.day, addDays(today, -1), worker.e);
    expect(before.error?.code).toBe("MLRS1");
  });

  it("refuses a closed post after its last day, and an archived site", async () => {
    const second = await liveContract(lekki, [
      { post_name: "Barrier", band: "Day", start_time: "07:00", end_time: "19:00" },
      { post_name: "Barrier", band: "Night", start_time: "19:00", end_time: "07:00" },
    ]);
    const barrierDay = await postId(second, "Barrier · Day");
    const barrierNight = await postId(second, "Barrier · Night");
    const closed = await ops.client.rpc("close_post", {
      p_organisation_id: owner.orgId,
      p_post_id: barrierNight,
      p_last_day: day(1),
      p_reason: "Client stopped the night barrier.",
    });
    expect(closed.error).toBeNull();
    expect((await assign(barrierNight, day(1), worker.e)).error).toBeNull();
    const after = await assign(barrierNight, day(2), worker.f);
    expect(after.error?.code).toBe("MLRS1");
    expect(after.error?.message).toContain("closed after");

    const archived = await admin
      .from("sites")
      .update({ status: "archived" } as never)
      .eq("id", lekki);
    expect(archived.error).toBeNull();
    const refused = await assign(barrierDay, day(5), worker.f);
    expect(refused.error?.code).toBe("MLRS3");
    const copy = await ops.client.rpc("copy_last_week", {
      p_organisation_id: owner.orgId,
      p_site_id: lekki,
      p_week_start: addDays(monday, 7),
    });
    expect(copy.error).toBeNull();
  });

  it("allows no direct writes, from any signed-in role", async () => {
    const insert = await ops.client.from("shift_assignments").insert({
      organisation_id: owner.orgId,
      shift_id: "00000000-0000-0000-0000-000000000000",
      site_id: apapa,
      shift_date: day(0),
      worker_id: worker.a,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(insert.error?.code).toBe("42501");
    const update = await ops.client
      .from("shift_assignments")
      .update({ status: "removed" })
      .eq("organisation_id", owner.orgId);
    expect(update.error?.code).toBe("42501");
    const shift = await ops.client
      .from("shifts")
      .update({ status: "cancelled" })
      .eq("organisation_id", owner.orgId);
    expect(shift.error?.code).toBe("42501");
  });
});

describe("later requirement changes", () => {
  it("reads the requirement in force: a raised count lets a second person on, and a replaced version leaves the shift's copy", async () => {
    const weekThree = addDays(monday, 14);
    await assigned(post.day, weekThree, worker.d);
    expect((await assign(post.day, weekThree, worker.e)).error?.code).toBe("MLRS4");

    const raised = await ops.client.rpc("change_post_requirement", {
      p_organisation_id: owner.orgId,
      p_post_id: post.day,
      p_from: weekThree,
      p_days: EVERY_DAY,
      p_start: "06:00",
      p_end: "18:00",
      p_count: 2,
    });
    expect(raised.error).toBeNull();
    expect((await assign(post.day, weekThree, worker.e)).error).toBeNull();

    // A shift made under the new version, then that version replaced before it starts.
    const tuesday = addDays(weekThree, 1);
    const { data } = await assign(post.day, tuesday, worker.d);
    const shiftId = (data as { shift_id: string }).shift_id;
    const replaced = await ops.client.rpc("change_post_requirement", {
      p_organisation_id: owner.orgId,
      p_post_id: post.day,
      p_from: weekThree,
      p_days: EVERY_DAY,
      p_start: "07:00",
      p_end: "19:00",
      p_count: 2,
    });
    expect(replaced.error).toBeNull();
    const shift = await admin
      .from("shifts")
      .select("requirement_id, starts_at, required_count")
      .eq("id", shiftId)
      .single();
    expect(shift.data!.requirement_id).toBeNull();
    expect(Date.parse(shift.data!.starts_at)).toBe(lagos(tuesday, "06:00"));
    expect(shift.data!.required_count).toBe(2);
    // A new assignment takes today's hours.
    const { data: next } = await assign(post.day, tuesday, worker.e);
    const row = await admin
      .from("shift_assignments")
      .select("starts_at")
      .eq("id", (next as { assignment_id: string }).assignment_id)
      .single();
    expect(Date.parse(row.data!.starts_at)).toBe(lagos(tuesday, "07:00"));
  });
});

describe("copy_last_week", () => {
  const target = addDays(monday, 7);

  beforeAll(async () => {
    // Week one (source).
    await assigned(post.night, day(4), worker.a); // Fri night: next Fri night already full
    await assigned(post.early, day(0), worker.e); // Mon early: copies
    await assigned(post.early, day(2), worker.c); // Wed early: Peter leaves on day 6
    await assigned(post.patrol, day(3), worker.f); // Thu patrol: patrol closes on day 6
    await assigned(post.day, day(4), worker.a); // Fri day: next Fri already full
    await assigned(post.early, day(5), worker.b); // Sat early: Daniel on next Fri night
    await assigned(post.day, day(6), worker.e); // Sun day: already on next Sun

    const closed = await ops.client.rpc("close_post", {
      p_organisation_id: owner.orgId,
      p_post_id: post.patrol,
      p_last_day: day(6),
      p_reason: "Client ended the day patrol.",
    });
    expect(closed.error).toBeNull();

    // Week two (target), already partly filled.
    await assigned(post.day, addDays(target, 4), worker.d); // Fri day full
    await assigned(post.night, addDays(target, 4), worker.b); // Fri night to Sat 06:00
    await assigned(post.day, addDays(target, 6), worker.e); // Sun day: Ngozi already there
  });

  async function targetCounts() {
    const { rows } = await db.query<{ assignments: string; shifts: string; audit: string }>(
      `select
         (select count(*) from public.shift_assignments a
           where a.organisation_id = $1 and a.site_id = $2 and a.shift_date between $3 and $3::date + 6) as assignments,
         (select count(*) from public.shifts s
           where s.organisation_id = $1 and s.site_id = $2 and s.shift_date between $3 and $3::date + 6) as shifts,
         (select count(*) from public.audit_log l where l.organisation_id = $1) as audit`,
      [owner.orgId, apapa, target],
    );
    return rows[0]!;
  }

  it("previews without writing, then copies what it can and says why it skipped the rest", async () => {
    const before = await targetCounts();
    const preview = await ops.client.rpc("copy_last_week", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: target,
      p_dry_run: true,
    });
    expect(preview.error).toBeNull();
    expect(await targetCounts()).toEqual(before);

    const result = preview.data as {
      source: number;
      copied: number;
      already: number;
      dry_run: boolean;
      skipped: { worker_id: string; code: string; reason: string; shift_date: string }[];
    };
    expect(result.dry_run).toBe(true);
    const skipped = Object.fromEntries(
      result.skipped.map((s) => [`${s.worker_id}|${s.shift_date}`, s.code]),
    );
    expect(skipped).toMatchObject({
      [`${worker.c}|${addDays(target, 2)}`]: "MLRS2",
      [`${worker.f}|${addDays(target, 3)}`]: "MLRS1",
      [`${worker.a}|${addDays(target, 4)}`]: "MLRS4",
      [`${worker.b}|${addDays(target, 5)}`]: "MLRS5",
    });
    expect(result.already).toBeGreaterThanOrEqual(1);
    expect(result.copied).toBeGreaterThanOrEqual(2);
    expect(result.source).toBe(result.copied + result.already + result.skipped.length);
    for (const s of result.skipped) expect(s.reason.length).toBeGreaterThan(5);

    const copy = await ops.client.rpc("copy_last_week", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: target,
    });
    expect(copy.error).toBeNull();
    const done = copy.data as typeof result;
    expect(done.copied).toBe(result.copied);
    expect(done.skipped.map((s) => s.code).sort()).toEqual(
      result.skipped.map((s) => s.code).sort(),
    );
    const after = await targetCounts();
    expect(Number(after.assignments)).toBe(Number(before.assignments) + done.copied);

    const event = await admin
      .from("audit_log")
      .select("after")
      .eq("organisation_id", owner.orgId)
      .eq("action", "roster.week_copied")
      .eq("entity_id", apapa);
    expect(event.data).toHaveLength(1);
    expect(event.data![0]!.after).toMatchObject({ week_start: target, copied: done.copied });

    // Again: nothing new, everything already there or still refused.
    const again = await ops.client.rpc("copy_last_week", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: target,
    });
    expect((again.data as typeof result).copied).toBe(0);
    expect((again.data as typeof result).already).toBe(done.already + done.copied);
  });

  it("takes a Monday only", async () => {
    const { error } = await ops.client.rpc("copy_last_week", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_week_start: addDays(target, 1),
    });
    expect(error?.code).toBe("22023");
  });
});

describe("who reads and writes", () => {
  it("a worker sees only their own assignments and the shifts they are on, without who or why", async () => {
    // A shift Musa was taken off: it no longer shows on his phone.
    const gone = await assigned(post.early, addDays(monday, 21), worker.a);
    const removed = await ops.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: gone,
      p_reason: "Client asked for someone else.",
    });
    expect(removed.error).toBeNull();
    const { data: goneRow } = await admin
      .from("shift_assignments")
      .select("shift_id")
      .eq("id", gone)
      .single();

    const client = await workerSession(worker.a);
    const rows = await client.from("shift_assignments").select("worker_id, shift_id, status");
    expect(rows.error).toBeNull();
    expect(rows.data!.length).toBeGreaterThan(0);
    expect(new Set(rows.data!.map((r) => r.worker_id))).toEqual(new Set([worker.a]));
    const shifts = await client.from("shifts").select("id");
    const onShifts = new Set(
      rows.data!.filter((r) => r.status === "assigned").map((r) => r.shift_id),
    );
    expect(new Set(shifts.data!.map((s) => s.id))).toEqual(onShifts);
    expect(onShifts.has(goneRow!.shift_id)).toBe(false);

    // Who assigned or removed them, and why, stays with managers.
    for (const column of ["removed_reason", "assigned_by", "removed_by"]) {
      const hidden = await client.from("shift_assignments").select(column);
      expect(hidden.error?.code, column).toBe("42501");
    }
    const details = await client.rpc("roster_assignment_details", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_from: addDays(monday, 21),
      p_to: addDays(monday, 21),
    });
    expect(details.error?.code).toBe("42501");
    const forOps = await ops.client.rpc("roster_assignment_details", {
      p_organisation_id: owner.orgId,
      p_site_id: apapa,
      p_from: addDays(monday, 21),
      p_to: addDays(monday, 21),
    });
    expect(forOps.error).toBeNull();
    expect(forOps.data).toContainEqual(
      expect.objectContaining({
        id: gone,
        assigned_by: ops.id,
        removed_by: ops.id,
        removed_reason: "Client asked for someone else.",
      }),
    );

    // No writing.
    expect((await assign(post.night, day(6), worker.a, client)).error?.code).toBe("42501");
  });

  it("two assigns at once onto a one-person shift give one success and one MLRS4", async () => {
    const date = addDays(monday, 22);
    const results = await Promise.all([
      assign(post.night, date, worker.d, ops.client),
      assign(post.night, date, worker.e, owner.client),
    ]);
    const codes = results.map((r) => r.error?.code ?? "ok").sort();
    expect(codes).toEqual(["MLRS4", "ok"]);
    const { count } = await admin
      .from("shift_assignments")
      .select("id", { count: "exact", head: true })
      .eq("organisation_id", owner.orgId)
      .eq("shift_date", date)
      .eq("status", "assigned");
    expect(count).toBe(1);
  });

  it("a line manager reads their reportees' assignments and the shifts at their sites", async () => {
    const rows = await lineManager.client.from("shift_assignments").select("worker_id");
    expect(rows.error).toBeNull();
    expect(rows.data!.length).toBeGreaterThan(0);
    expect(new Set(rows.data!.map((r) => r.worker_id))).toEqual(new Set([worker.a]));
    const shifts = await lineManager.client.from("shifts").select("site_id");
    expect(new Set(shifts.data!.map((s) => s.site_id))).toEqual(new Set([apapa]));
    const all = await admin
      .from("shifts")
      .select("id", { count: "exact", head: true })
      .eq("site_id", apapa);
    expect(shifts.data!.length).toBe(all.count);
    // Slice 4.7: a line manager assigns only their reportees (tests/rls/team.test.ts covers the
    // rest); worker.b doesn't report to them.
    expect((await assign(post.night, day(6), worker.b, lineManager.client)).error?.code).toBe(
      "42501",
    );
  });

  it("hr reads nothing and can't assign", async () => {
    const rows = await hr.client.from("shift_assignments").select("id");
    expect(rows.data).toEqual([]);
    const shifts = await hr.client.from("shifts").select("id");
    expect(shifts.data).toEqual([]);
    expect((await assign(post.night, day(6), worker.a, hr.client)).error?.code).toBe("42501");
  });

  it("another company reads nothing and can't write", async () => {
    expect((await other.client.from("shift_assignments").select("id")).data).toEqual([]);
    expect((await other.client.from("shifts").select("id")).data).toEqual([]);
    expect((await assign(post.night, day(6), worker.a, other.client)).error?.code).toBe("42501");
    // Its own organisation with our post and worker: not found.
    const own = await assign(post.night, day(6), worker.a, other.client, other.orgId);
    expect(own.error?.code).toBe("P0002");
    const { data: victimRow } = await admin
      .from("shift_assignments")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("status", "assigned")
      .limit(1)
      .single();
    const remove = await other.client.rpc("remove_assignment", {
      p_organisation_id: other.orgId,
      p_assignment_id: victimRow!.id,
    });
    expect(remove.error?.code).toBe("P0002");
    const still = await admin
      .from("shift_assignments")
      .select("status")
      .eq("id", victimRow!.id)
      .single();
    expect(still.data!.status).toBe("assigned");
    const copy = await other.client.rpc("copy_last_week", {
      p_organisation_id: other.orgId,
      p_site_id: apapa,
      p_week_start: addDays(monday, 7),
    });
    expect(copy.error?.code).toBe("P0002");
    expect(
      (
        await anonClient().rpc("assign_worker_to_shift", {
          p_organisation_id: owner.orgId,
          p_post_id: post.night,
          p_shift_date: day(6),
          p_worker_id: worker.a,
        })
      ).error,
    ).not.toBeNull();
  });
});
