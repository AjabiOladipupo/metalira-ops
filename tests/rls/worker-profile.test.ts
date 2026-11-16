/**
 * Slice 1.10 against the real database: what a worker's own session can read for the Me screen
 * (its own row, department, site and project, its line manager by name only, and nothing of a
 * colleague's), "Request a change" (worker_change_requests: raised only by the worker for
 * themselves, no personal numbers, at most 5 open, insert-only, resolved by owner, admin or hr),
 * and a bank change raised from the worker's phone reaching HR. Cross-organisation isolation for
 * the new table lives in isolation.test.ts (tables/worker-profile.ts).
 */
import { randomBytes } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

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

const PERMISSION_DENIED = "42501";
const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
const staff = {} as Record<"hr" | "finance" | "ops" | "lineManager", TestUser>;
let counter = 0;

async function addMember(user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function membershipId(userId: string): Promise<string> {
  const { data } = await admin
    .from("memberships")
    .select("id")
    .eq("organisation_id", owner.orgId)
    .eq("user_id", userId)
    .single();
  return data!.id;
}

async function addWorker(
  fields: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
): Promise<string> {
  counter += 1;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: owner.orgId,
      staff_id: `WP-${String(counter).padStart(4, "0")}`,
      first_name: "Musa",
      last_name: `Ibrahim ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** An invited worker who has set a PIN, with a session opened the way the server does it. */
async function workerSession(workerId: string): Promise<Client> {
  const invite = await staff.hr.client.rpc("create_worker_invites", {
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

function request(client: Client, workerId: string, details = "My surname is spelt Adebayo") {
  return client
    .from("worker_change_requests")
    .insert({ organisation_id: owner.orgId, worker_id: workerId, topic: "name", details })
    .select("id, requested_by, status")
    .single();
}

let target: { client: string; site: string; otherSite: string; project: string; dept: string };
let me: string;
let colleague: string;
let meClient: Client;
let colleagueClient: Client;

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("wp-owner", "Worker Profile Org");
  staff.hr = await createTestUser("wp-hr");
  staff.finance = await createTestUser("wp-finance");
  staff.ops = await createTestUser("wp-ops");
  staff.lineManager = await createTestUser("wp-line-manager", "Kola Adebayo");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  await addMember(staff.lineManager, "line_manager");

  const client = await admin
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: "Coastline Logistics" })
    .select("id")
    .single();
  const sites = await admin
    .from("sites")
    .insert([
      { organisation_id: owner.orgId, client_id: client.data!.id, name: "Apapa Warehouse 3" },
      { organisation_id: owner.orgId, client_id: client.data!.id, name: "Ikeja Gate" },
    ])
    .select("id, name");
  const project = await admin
    .from("projects")
    .insert({ organisation_id: owner.orgId, client_id: client.data!.id, name: "Guarding" })
    .select("id")
    .single();
  const dept = await admin
    .from("departments")
    .insert({ organisation_id: owner.orgId, name: "Security services" })
    .select("id")
    .single();
  target = {
    client: client.data!.id,
    site: sites.data!.find((s) => s.name === "Apapa Warehouse 3")!.id,
    otherSite: sites.data!.find((s) => s.name === "Ikeja Gate")!.id,
    project: project.data!.id,
    dept: dept.data!.id,
  };

  const manager = await addWorker({ first_name: "Ngozi", last_name: "Okafor" });
  me = await addWorker({ department_id: target.dept, line_manager_worker_id: manager });
  colleague = await addWorker({
    line_manager_membership_id: await membershipId(staff.lineManager.id),
  });
  const assigned = await admin.from("worker_assignments").insert([
    {
      organisation_id: owner.orgId,
      worker_id: me,
      site_id: target.site,
      project_id: target.project,
      effective_from: "2025-01-06",
    },
    {
      organisation_id: owner.orgId,
      worker_id: colleague,
      site_id: target.otherSite,
      effective_from: "2025-01-06",
    },
  ]);
  expect(assigned.error).toBeNull();
  meClient = await workerSession(me);
  colleagueClient = await workerSession(colleague);
});

afterAll(async () => {
  await db?.end();
});

describe("the Me screen's reads with the worker's own session", () => {
  it("returns the worker's own row only, and only the site, project and department it points at", async () => {
    const workers = await meClient.from("workers").select("id");
    expect(workers.data).toEqual([{ id: me }]);
    const colleagueRow = await meClient.from("workers").select("id").eq("id", colleague);
    expect(colleagueRow.data).toEqual([]);
    const sites = await meClient.from("sites").select("name");
    expect(sites.data).toEqual([{ name: "Apapa Warehouse 3" }]);
    const projects = await meClient.from("projects").select("name");
    expect(projects.data).toEqual([{ name: "Guarding" }]);
    const departments = await meClient.from("departments").select("name");
    expect(departments.data).toEqual([{ name: "Security services" }]);
    const assignments = await meClient.from("worker_assignments").select("worker_id");
    expect(new Set(assignments.data?.map((a) => a.worker_id))).toEqual(new Set([me]));
  });

  it("gives the line manager's name only: a worker line manager or a manager-app user", async () => {
    const mine = await meClient.rpc("my_line_manager", { p_organisation_id: owner.orgId });
    expect(mine.error).toBeNull();
    expect(mine.data).toEqual([{ has_line_manager: true, name: "Ngozi Okafor" }]);
    const theirs = await colleagueClient.rpc("my_line_manager", {
      p_organisation_id: owner.orgId,
    });
    expect(theirs.data).toEqual([{ has_line_manager: true, name: "Kola Adebayo" }]);
  });

  it("answers nothing for a manager, another organisation or anonymous callers", async () => {
    const hr = await staff.hr.client.rpc("my_line_manager", { p_organisation_id: owner.orgId });
    expect(hr.data).toEqual([]);
    const elsewhere = await meClient.rpc("my_line_manager", {
      p_organisation_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(elsewhere.data).toEqual([]);
    const anon = await anonClient().rpc("my_line_manager", { p_organisation_id: owner.orgId });
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
  });
});

describe("worker change requests", () => {
  it("are raised by the worker for themselves, as requester, and audited", async () => {
    const { data, error } = await request(meClient, me);
    expect(error).toBeNull();
    expect(data!.status).toBe("open");
    const { data: login } = await meClient.auth.getUser();
    expect(data!.requested_by).toBe(login.user!.id);
    const audit = await admin
      .from("audit_log")
      .select("action, actor_id")
      .eq("entity", "worker_change_requests")
      .eq("entity_id", data!.id);
    expect(audit.data).toEqual([
      { action: "worker_change_requests.insert", actor_id: login.user!.id },
    ]);
  });

  it("can't be raised for a colleague, or by HR, finance or a line manager", async () => {
    expect((await request(meClient, colleague)).error?.code).toBe(PERMISSION_DENIED);
    for (const user of [staff.hr, staff.finance, staff.lineManager]) {
      expect((await request(user.client, me)).error?.code).toBe(PERMISSION_DENIED);
    }
    expect((await request(owner.client, me)).error?.code).toBe(PERMISSION_DENIED);
  });

  it("never hold a personal number, even split by spaces or dashes", async () => {
    for (const details of ["NIN 12345678901", "account 0123-457-712", "PEN100012344421"]) {
      const { error } = await request(meClient, me, details);
      expect(error?.code, details).toBe("23514");
    }
  });

  it("are limited to 5 open per worker", async () => {
    const worker = await addWorker();
    const client = await workerSession(worker);
    for (let i = 0; i < 5; i += 1) {
      expect((await request(client, worker, `Request number ${i}`)).error).toBeNull();
    }
    const sixth = await request(client, worker, "One more");
    expect(sixth.error?.code).toBe("MLCR2");
  });

  it("are shown to owner, admin and hr and the worker, not finance, operations or colleagues", async () => {
    const { data } = await request(meClient, me, "Please fix my next of kin");
    const id = data!.id;
    for (const client of [owner.client, staff.hr.client, meClient]) {
      const read = await client.from("worker_change_requests").select("id").eq("id", id);
      expect(read.data).toEqual([{ id }]);
    }
    for (const client of [
      staff.finance.client,
      staff.ops.client,
      staff.lineManager.client,
      colleagueClient,
    ]) {
      const read = await client.from("worker_change_requests").select("id").eq("id", id);
      expect(read.data).toEqual([]);
    }
  });

  it("are resolved by HR only; the worker can't resolve, edit or delete them", async () => {
    const { data } = await request(meClient, me, "Change my phone please");
    const id = data!.id;

    const byWorker = await meClient
      .from("worker_change_requests")
      .update({ status: "done" })
      .eq("id", id)
      .select();
    expect(byWorker.data ?? []).toEqual([]);
    const byFinance = await staff.finance.client
      .from("worker_change_requests")
      .update({ status: "done" })
      .eq("id", id)
      .select();
    expect(byFinance.data ?? []).toEqual([]);

    const edit = await staff.hr.client
      .from("worker_change_requests")
      .update({ details: "Something else" } as never)
      .eq("id", id);
    expect(edit.error?.code).toBe(PERMISSION_DENIED);

    const done = await staff.hr.client
      .from("worker_change_requests")
      .update({ status: "declined", resolution_note: "Bring a letter to HR" })
      .eq("id", id)
      .select("status, resolved_by, resolved_at, resolution_note")
      .single();
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({
      status: "declined",
      resolved_by: staff.hr.id,
      resolution_note: "Bring a letter to HR",
    });
    expect(done.data!.resolved_at).not.toBeNull();

    const again = await staff.hr.client
      .from("worker_change_requests")
      .update({ status: "done" })
      .eq("id", id);
    expect(again.error?.code).toBe("MLCR4");

    const removed = await owner.client
      .from("worker_change_requests")
      .delete()
      .eq("id", id)
      .select();
    expect(removed.data ?? []).toEqual([]);
    const { rowCount } = await db.query(
      "select 1 from public.worker_change_requests where id = $1",
      [id],
    );
    expect(rowCount).toBe(1);
  });
});

describe("a bank change from the worker's phone", () => {
  it("is raised by the worker for themselves and reaches HR's approvals, never decided by them", async () => {
    const worker = await addWorker();
    const client = await workerSession(worker);
    const raised = await client
      .from("bank_detail_changes")
      .insert({
        organisation_id: owner.orgId,
        worker_id: worker,
        bank_name: "GTBank",
        account_name: "Musa Ibrahim",
        bank_account_enc: `\\x${randomBytes(40).toString("hex")}`,
        bank_account_last4: "7712",
      })
      .select("id, raised_by_worker, status")
      .single();
    expect(raised.error).toBeNull();
    expect(raised.data).toMatchObject({ raised_by_worker: true, status: "pending" });

    const pending = await staff.hr.client
      .from("bank_detail_changes")
      .select("id")
      .eq("status", "pending")
      .eq("worker_id", worker);
    expect(pending.data).toEqual([{ id: raised.data!.id }]);

    const approve = await client
      .from("bank_detail_changes")
      .update({ status: "approved" })
      .eq("id", raised.data!.id)
      .select();
    expect(approve.error?.code).toBe(PERMISSION_DENIED);

    // A colleague's phone sees none of it.
    const seen = await colleagueClient
      .from("bank_detail_changes")
      .select("id")
      .eq("id", raised.data!.id);
    expect(seen.data).toEqual([]);
  });
});
