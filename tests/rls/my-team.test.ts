/**
 * Slice 4.7: My team against the real database.
 * - A line manager assigns and removes only their reportees, only at their team's sites
 *   (private.line_manager_site_ids), never their own record; a non-reportee or another site is
 *   refused (42501). Publishing and copying a week stay with owner, admin and ops_manager.
 * - public.team_shifts lists only the reportees' assignments; public.team_open_shifts lists only
 *   post-days at the team's sites that still need people; both refuse other roles.
 * - public.team_leave_open_shifts lists, for step-1 requests the line manager decides, 4.5's
 *   shifts-to-open; nothing for another line manager.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";
import type { Database, Json } from "@/types/db";

import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

let admin: Client;
let owner: TenantUser;
let other: TenantUser;
let ops: TestUser;
let lineManager: TestUser;
let otherLineManager: TestUser;
let clientId: string;
const site = {} as Record<"apapa" | "ikoyi", string>;
const post = {} as Record<"apapaDay" | "ikoyiDay", string>;
const worker = {} as Record<"mine" | "notMine" | "theirs", string>;
let counter = 0;

const today = lagosToday();
/** Next Monday (never today). */
const monday = addDays(today, 8 - isoWeekday(today));
const day = (n: number) => addDays(monday, n);

async function addMember(user: TestUser, role: Role, orgId = owner.orgId): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function addWorker(
  name: string,
  fields: Partial<Database["public"]["Tables"]["workers"]["Insert"]>,
  mappedTo: string | null,
): Promise<string> {
  counter += 1;
  const [first, last] = name.split(" ");
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `MT-${String(counter).padStart(4, "0")}`,
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

/** A contract live from today at `siteId` with one 06:00 to 18:00 post every day for 1 person. */
async function liveContract(siteId: string, postName: string): Promise<string> {
  const { data: id, error } = await ops.client.rpc("create_contract", {
    p_organisation_id: owner.orgId,
    p_contract: {
      client_id: clientId,
      name: `${postName} guarding`,
      type: "manned_post",
      start_date: today,
    } as Json,
    p_site_ids: [siteId],
  });
  expect(error).toBeNull();
  const card = await ops.client.rpc("save_draft_rate_card", {
    p_organisation_id: owner.orgId,
    p_contract_id: id!,
    p_effective_from: today,
    p_lines: [{ role: "Guard", band: "Day", unit: "shift", rate_kobo: "1250000" }] as Json,
  });
  expect(card.error).toBeNull();
  const row = await ops.client.from("headcount_requirements").insert({
    organisation_id: owner.orgId,
    contract_id: id!,
    site_id: siteId,
    role: "Guard",
    unit: "shift",
    days_of_week: EVERY_DAY,
    required_count: 1,
    post_name: postName,
    band: "Day",
    start_time: "06:00",
    end_time: "18:00",
  } as never);
  expect(row.error).toBeNull();
  const live = await ops.client.rpc("activate_contract", {
    p_organisation_id: owner.orgId,
    p_contract_id: id!,
    p_send_welcome: false,
  });
  expect(live.error).toBeNull();
  const found = await admin
    .from("posts")
    .select("id")
    .eq("contract_id", id!)
    .eq("name", `${postName} · Day`)
    .single();
  expect(found.error).toBeNull();
  return found.data!.id;
}

function assign(postId: string, date: string, workerId: string, by: Client) {
  return by.rpc("assign_worker_to_shift", {
    p_organisation_id: owner.orgId,
    p_post_id: postId,
    p_shift_date: date,
    p_worker_id: workerId,
  });
}

function assignmentId(data: unknown): string {
  return String((data as { assignment_id: string }).assignment_id);
}

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("myteam-owner", "My Team Org");
  other = await createTenantUser("myteam-other", "Other My Team Org");
  ops = await createTestUser("myteam-ops", "Tunde Ops");
  lineManager = await createTestUser("myteam-lm", "Kola Adebayo");
  otherLineManager = await createTestUser("myteam-lm2", "Emeka Nwankwo");
  await addMember(ops, "ops_manager");
  const lmId = await addMember(lineManager, "line_manager");
  const lm2Id = await addMember(otherLineManager, "line_manager");

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
      ["Apapa Warehouse 3", "Ikoyi Tower"].map((name) => ({
        organisation_id: owner.orgId,
        client_id: clientId,
        name,
        centre: CENTRE,
      })) as never,
    )
    .select("id, name");
  expect(sites.error).toBeNull();
  site.apapa = sites.data!.find((s) => s.name === "Apapa Warehouse 3")!.id;
  site.ikoyi = sites.data!.find((s) => s.name === "Ikoyi Tower")!.id;
  post.apapaDay = await liveContract(site.apapa, "Gate A");
  post.ikoyiDay = await liveContract(site.ikoyi, "Lobby");

  worker.mine = await addWorker("Musa Ibrahim", { line_manager_membership_id: lmId }, site.apapa);
  worker.notMine = await addWorker("Daniel Okon", {}, site.apapa);
  // The other line manager's reportee works only at Ikoyi.
  worker.theirs = await addWorker(
    "Halima Bello",
    { line_manager_membership_id: lm2Id },
    site.ikoyi,
  );
});

afterAll(() => undefined);

describe("line managers assign within their crews", () => {
  it("assigns and removes a reportee at their team's site", async () => {
    const { data, error } = await assign(post.apapaDay, day(0), worker.mine, lineManager.client);
    expect(error).toBeNull();
    const id = assignmentId(data);
    const row = await admin
      .from("shift_assignments")
      .select("status, assigned_by, site_id")
      .eq("id", id)
      .single();
    expect(row.data).toMatchObject({
      status: "assigned",
      assigned_by: lineManager.id,
      site_id: site.apapa,
    });
    const removed = await lineManager.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: id,
      p_reason: "Swapped with Daniel.",
    });
    expect(removed.error).toBeNull();
    const after = await admin
      .from("shift_assignments")
      .select("status, removed_by")
      .eq("id", id)
      .single();
    expect(after.data).toMatchObject({ status: "removed", removed_by: lineManager.id });
    // Audited by the row trigger.
    const audit = await admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", id);
    expect(audit.count).toBeGreaterThanOrEqual(2);
  });

  it("refuses a worker who doesn't report to them", async () => {
    const { error } = await assign(post.apapaDay, day(1), worker.notMine, lineManager.client);
    expect(error?.code).toBe("42501");
    expect(error?.message).toBe(
      "You can assign only people who report to you, at your team's sites.",
    );
  });

  it("refuses a reportee at a site outside their team's", async () => {
    const { error } = await assign(post.ikoyiDay, day(1), worker.mine, lineManager.client);
    expect(error?.code).toBe("42501");
  });

  it("can't take off someone who doesn't report to them", async () => {
    const { data, error } = await assign(post.apapaDay, day(2), worker.notMine, ops.client);
    expect(error).toBeNull();
    const removed = await lineManager.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: assignmentId(data),
    });
    expect(removed.error?.code).toBe("42501");
  });

  it("can't take a reportee off a shift at a site outside their team's", async () => {
    const { data, error } = await assign(post.ikoyiDay, day(5), worker.mine, ops.client);
    expect(error).toBeNull();
    const removed = await lineManager.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: assignmentId(data),
    });
    expect(removed.error?.code).toBe("42501");
  });

  it("can't take a reportee off a shift that has started (ops still can)", async () => {
    const { data, error } = await assign(post.apapaDay, day(6), worker.mine, lineManager.client);
    expect(error).toBeNull();
    const id = assignmentId(data);
    // Move the shift into the past as the database owner, triggers off for this statement only.
    const db = await pgClient();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query(
        "update public.shift_assignments set starts_at = now() - interval '1 hour', ends_at = now() + interval '11 hours' where id = $1",
        [id],
      );
      await db.query("commit");
    } finally {
      await db.end();
    }
    const removed = await lineManager.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: id,
    });
    expect(removed.error?.code).toBe("MLRS6");
    const byOps = await ops.client.rpc("remove_assignment", {
      p_organisation_id: owner.orgId,
      p_assignment_id: id,
    });
    expect(byOps.error).toBeNull();
  });

  it("can't publish or copy a week", async () => {
    const publish = await lineManager.client.rpc("publish_roster", {
      p_organisation_id: owner.orgId,
      p_site_id: site.apapa,
      p_week_start: monday,
      p_dry_run: false,
    });
    expect(publish.error?.code).toBe("42501");
    const copy = await lineManager.client.rpc("copy_last_week", {
      p_organisation_id: owner.orgId,
      p_site_id: site.apapa,
      p_week_start: monday,
      p_dry_run: true,
    });
    expect(copy.error?.code).toBe("42501");
  });

  it("refuses another company's line manager", async () => {
    const stranger = await createTestUser("myteam-stranger", "Bayo Kareem");
    await addMember(stranger, "line_manager", other.orgId);
    const { error } = await assign(post.apapaDay, day(3), worker.mine, stranger.client);
    expect(error?.code).toBe("42501");
  });
});

describe("My team reads", () => {
  it("team_shifts lists only the reportees' assignments", async () => {
    const mine = await assign(post.apapaDay, day(4), worker.mine, lineManager.client);
    expect(mine.error).toBeNull();
    const { data, error } = await lineManager.client.rpc("team_shifts", {
      p_organisation_id: owner.orgId,
      p_from: today,
      p_to: addDays(today, 30),
    });
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(new Set(data!.map((r) => r.worker_id))).toEqual(new Set([worker.mine]));
    expect(data!.every((r) => r.post_name.length > 0 && r.site_name.length > 0)).toBe(true);
    // The other line manager sees none of them.
    const theirs = await otherLineManager.client.rpc("team_shifts", {
      p_organisation_id: owner.orgId,
      p_from: today,
      p_to: addDays(today, 30),
    });
    expect(theirs.error).toBeNull();
    expect(theirs.data!.some((r) => r.worker_id === worker.mine)).toBe(false);
  });

  it("team_open_shifts lists only the team's sites, with counts and no names", async () => {
    const { data, error } = await lineManager.client.rpc("team_open_shifts", {
      p_organisation_id: owner.orgId,
      p_from: today,
      p_to: addDays(today, 13),
    });
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(new Set(data!.map((r) => r.site_id))).toEqual(new Set([site.apapa]));
    expect(data!.every((r) => r.assigned_count < r.required_count)).toBe(true);
    // day(4) is now full (1 of 1).
    expect(data!.some((r) => r.shift_date === day(4))).toBe(false);
    expect(Object.keys(data![0]!)).not.toContain("worker_id");
  });

  it("refuses the reads to other roles", async () => {
    for (const fn of ["team_shifts", "team_open_shifts"] as const) {
      const res = await ops.client.rpc(fn, {
        p_organisation_id: owner.orgId,
        p_from: today,
        p_to: addDays(today, 13),
      });
      expect(res.error?.code, fn).toBe("42501");
    }
    const leave = await ops.client.rpc("team_leave_open_shifts", {
      p_organisation_id: owner.orgId,
    });
    expect(leave.error?.code).toBe("42501");
  });
});
