/**
 * Slice 1.6 mapping, against the real database: public.save_worker_mapping closes the rows that
 * stop applying the day before the new ones start (tomorrow), keeps what is unchanged, never
 * removes a row that was in force, refuses overlapping assignments to the same site or project,
 * and is open to owner, admin and hr only. Cross-organisation isolation for worker_assignments
 * lives in isolation.test.ts (tables/people.ts).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const PERMISSION_DENIED = "42501";

/** YYYY-MM-DD in Africa/Lagos, the organisations' default timezone. */
function lagosDate(offsetDays = 0): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(at);
}

const TODAY = lagosDate();
const TOMORROW = lagosDate(1);
const IN_10 = lagosDate(10);
const SINCE = "2025-01-06";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let ops: TestUser;
let lineManager: TestUser;
let lineManagerMembership: string;
let departmentId: string;
let secondDepartmentId: string;
let siteA: string;
let siteB: string;
let projectP: string;
let projectQ: string;
let otherOrgSite: string;
let staffCounter = 0;

async function addMember(user: TestUser, role: Role, workerId: string | null = null) {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role, worker_id: workerId })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function newWorker(fields: Record<string, Json> = {}): Promise<string> {
  staffCounter += 1;
  const id = randomUUID();
  const { error } = await hr.client.rpc("create_worker", {
    p_worker: {
      id,
      organisation_id: owner.orgId,
      staff_id: `M-${String(staffCounter).padStart(4, "0")}`,
      first_name: "Musa",
      last_name: `Mapped ${staffCounter}`,
      employment_type: "permanent",
      start_date: SINCE,
      ...fields,
    },
  });
  expect(error).toBeNull();
  return id;
}

/** A worker already on site A and project P since SINCE (as an import would leave them). */
async function mappedWorker(): Promise<string> {
  const workerId = await newWorker({
    department_id: departmentId,
    line_manager_membership_id: lineManagerMembership,
  });
  const { error } = await hr.client.from("worker_assignments").insert([
    { organisation_id: owner.orgId, worker_id: workerId, site_id: siteA, effective_from: SINCE },
    {
      organisation_id: owner.orgId,
      worker_id: workerId,
      project_id: projectP,
      effective_from: SINCE,
    },
  ]);
  expect(error).toBeNull();
  return workerId;
}

interface Row {
  site: string | null;
  project: string | null;
  from: string;
  to: string | null;
}

async function rows(workerId: string): Promise<Row[]> {
  const { rows: found } = await db.query<Row>(
    `select site_id as site, project_id as project, effective_from::text as from,
            effective_to::text as to
     from public.worker_assignments where worker_id = $1
     order by effective_from, site_id nulls last, project_id`,
    [workerId],
  );
  return found;
}

function save(
  workerId: string,
  mapping: {
    department?: string;
    lineManagerWorker?: string;
    lineManagerMembership?: string;
    site?: string;
    projects?: string[];
  },
  by: Client = hr.client,
) {
  return by.rpc("save_worker_mapping", {
    p_organisation_id: owner.orgId,
    p_worker_id: workerId,
    p_department_id: mapping.department,
    p_line_manager_worker_id: mapping.lineManagerWorker,
    p_line_manager_membership_id: mapping.lineManagerMembership,
    p_site_id: mapping.site,
    p_project_ids: mapping.projects ?? [],
  });
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("m-owner", "Mapping Org");
  other = await createTenantUser("m-other", "Other Mapping Org");
  hr = await createTestUser("m-hr");
  ops = await createTestUser("m-ops");
  lineManager = await createTestUser("m-line-manager", "Kola Adebayo");
  await addMember(hr, "hr");
  await addMember(ops, "ops_manager");
  lineManagerMembership = await addMember(lineManager, "line_manager");

  const departments = await hr.client
    .from("departments")
    .insert([
      { organisation_id: owner.orgId, name: "Security services" },
      { organisation_id: owner.orgId, name: "Cleaning services" },
    ])
    .select("id, name");
  expect(departments.error).toBeNull();
  departmentId = departments.data!.find((d) => d.name === "Security services")!.id;
  secondDepartmentId = departments.data!.find((d) => d.name === "Cleaning services")!.id;

  const client = await hr.client
    .from("clients")
    .insert({ organisation_id: owner.orgId, name: "Coastline Logistics" })
    .select("id")
    .single();
  const clientId = client.data!.id;
  const sites = await hr.client
    .from("sites")
    .insert([
      { organisation_id: owner.orgId, client_id: clientId, name: "Apapa Warehouse 3" },
      { organisation_id: owner.orgId, client_id: clientId, name: "Lekki Estate Gate B" },
    ])
    .select("id, name");
  siteA = sites.data!.find((s) => s.name === "Apapa Warehouse 3")!.id;
  siteB = sites.data!.find((s) => s.name === "Lekki Estate Gate B")!.id;
  const projects = await hr.client
    .from("projects")
    .insert([
      { organisation_id: owner.orgId, client_id: clientId, name: "Guarding contract" },
      { organisation_id: owner.orgId, client_id: clientId, name: "Patrol contract" },
    ])
    .select("id, name");
  projectP = projects.data!.find((p) => p.name === "Guarding contract")!.id;
  projectQ = projects.data!.find((p) => p.name === "Patrol contract")!.id;

  const otherClient = await other.client
    .from("clients")
    .insert({ organisation_id: other.orgId, name: "Other client" })
    .select("id")
    .single();
  const otherSite = await other.client
    .from("sites")
    .insert({ organisation_id: other.orgId, client_id: otherClient.data!.id, name: "Other site" })
    .select("id")
    .single();
  otherOrgSite = otherSite.data!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("save_worker_mapping", () => {
  it("maps an unmapped worker from the next shift and reports before and after", async () => {
    const workerId = await newWorker();
    const { data, error } = await save(workerId, {
      department: departmentId,
      lineManagerMembership,
      site: siteA,
      projects: [projectP, projectQ],
    });
    expect(error).toBeNull();
    expect(await rows(workerId)).toEqual(
      expect.arrayContaining([
        { site: siteA, project: null, from: TOMORROW, to: null },
        { site: null, project: projectP, from: TOMORROW, to: null },
        { site: null, project: projectQ, from: TOMORROW, to: null },
      ]),
    );
    expect(await rows(workerId)).toHaveLength(3);

    const result = data as Record<string, Json>;
    expect(result).toMatchObject({
      changed: true,
      department_changed: true,
      line_manager_changed: true,
      assignments_changed: true,
      effective_from: TOMORROW,
      before: { department: null, line_manager: null, sites: [], projects: [] },
      after: {
        department: { id: departmentId, name: "Security services" },
        line_manager: { kind: "membership", id: lineManagerMembership, name: "Kola Adebayo" },
        sites: [{ id: siteA, name: "Apapa Warehouse 3" }],
        projects: [
          { id: projectP, name: "Guarding contract" },
          { id: projectQ, name: "Patrol contract" },
        ],
      },
    });

    const { data: worker } = await admin
      .from("workers")
      .select("department_id, line_manager_membership_id, line_manager_worker_id")
      .eq("id", workerId)
      .single();
    expect(worker).toEqual({
      department_id: departmentId,
      line_manager_membership_id: lineManagerMembership,
      line_manager_worker_id: null,
    });
  });

  it("remapping closes the old site the day before and keeps it as history", async () => {
    const workerId = await mappedWorker();
    const { data, error } = await save(workerId, {
      department: departmentId,
      lineManagerMembership,
      site: siteB,
      projects: [projectP],
    });
    expect(error).toBeNull();
    expect(await rows(workerId)).toEqual([
      { site: siteA, project: null, from: SINCE, to: TODAY },
      { site: null, project: projectP, from: SINCE, to: null },
      { site: siteB, project: null, from: TOMORROW, to: null },
    ]);
    expect(data).toMatchObject({
      department_changed: false,
      line_manager_changed: false,
      assignments_changed: true,
      before: { sites: [{ id: siteA }] },
      after: { sites: [{ id: siteB }], projects: [{ id: projectP }] },
    });

    // The closing is in the audit log with the before and after.
    const { data: audit } = await admin
      .from("audit_log")
      .select("action, before, after")
      .eq("organisation_id", owner.orgId)
      .eq("entity", "worker_assignments")
      .eq("action", "worker_assignments.update");
    const closing = (audit ?? []).find(
      (row) => (row.after as { worker_id?: string } | null)?.worker_id === workerId,
    );
    expect(closing?.before).toMatchObject({ site_id: siteA, effective_to: null });
    expect(closing?.after).toMatchObject({ site_id: siteA, effective_to: TODAY });
  });

  it("saving the same mapping again changes nothing", async () => {
    const workerId = await mappedWorker();
    const before = await rows(workerId);
    const { data, error } = await save(workerId, {
      department: departmentId,
      lineManagerMembership,
      site: siteA,
      projects: [projectP],
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ changed: false, assignments_changed: false });
    expect(await rows(workerId)).toEqual(before);
  });

  it("a second change on the same day replaces the one not yet in force", async () => {
    const workerId = await mappedWorker();
    expect((await save(workerId, { site: siteB, projects: [projectP] })).error).toBeNull();
    // Changed again before tomorrow: the row for site B never applied, so it goes; site A
    // stays closed from today.
    expect((await save(workerId, { site: siteA, projects: [projectQ] })).error).toBeNull();
    expect(await rows(workerId)).toEqual([
      { site: siteA, project: null, from: SINCE, to: TODAY },
      { site: null, project: projectP, from: SINCE, to: TODAY },
      { site: siteA, project: null, from: TOMORROW, to: null },
      { site: null, project: projectQ, from: TOMORROW, to: null },
    ]);
  });

  it("clearing the site leaves the worker without one from the next shift", async () => {
    const workerId = await mappedWorker();
    const { data, error } = await save(workerId, { department: departmentId, projects: [] });
    expect(error).toBeNull();
    expect(await rows(workerId)).toEqual([
      { site: siteA, project: null, from: SINCE, to: TODAY },
      { site: null, project: projectP, from: SINCE, to: TODAY },
    ]);
    expect(data).toMatchObject({ after: { sites: [], projects: [], line_manager: null } });
  });

  it("splits a row naming both a site and a project when only one stays", async () => {
    const workerId = await newWorker();
    const insert = await hr.client.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      site_id: siteA,
      project_id: projectP,
      effective_from: SINCE,
    });
    expect(insert.error).toBeNull();
    expect((await save(workerId, { site: siteA, projects: [] })).error).toBeNull();
    expect(await rows(workerId)).toEqual([
      { site: siteA, project: projectP, from: SINCE, to: TODAY },
      { site: siteA, project: null, from: TOMORROW, to: null },
    ]);
  });

  it("starts a worker who has not started yet on their start date", async () => {
    const workerId = await newWorker({ start_date: IN_10 });
    const { data, error } = await save(workerId, { site: siteA });
    expect(error).toBeNull();
    expect(data).toMatchObject({ effective_from: IN_10 });
    expect(await rows(workerId)).toEqual([{ site: siteA, project: null, from: IN_10, to: null }]);
  });

  it("takes a worker as line manager, and refuses a loop or both kinds at once", async () => {
    const manager = await newWorker();
    const workerId = await newWorker({ line_manager_worker_id: manager });
    const ok = await save(workerId, { lineManagerWorker: manager, site: siteA });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({
      line_manager_changed: false,
      after: { line_manager: { kind: "worker", id: manager } },
    });

    const loop = await save(manager, { lineManagerWorker: workerId });
    expect(loop.error?.code).toBe("MLLM1");
    const both = await save(workerId, { lineManagerWorker: manager, lineManagerMembership });
    expect(both.error?.code).toBe("22023");
  });

  it("refuses a site or project of another organisation, and an ended worker", async () => {
    const workerId = await newWorker();
    expect((await save(workerId, { site: otherOrgSite })).error?.code).toBe("MLAS4");
    expect((await save(workerId, { projects: [randomUUID()] })).error?.code).toBe("MLAS5");

    const ended = await newWorker();
    const end = await hr.client.rpc("end_employment", {
      p_organisation_id: owner.orgId,
      p_worker_id: ended,
      p_end_date: TODAY,
    });
    expect(end.error).toBeNull();
    expect((await save(ended, { site: siteA })).error?.code).toBe("MLAS2");
    expect(await rows(ended)).toEqual([]);
  });

  it("is open to owner, admin and hr only", async () => {
    const workerId = await newWorker({ line_manager_membership_id: lineManagerMembership });
    for (const caller of [ops, lineManager]) {
      const { error } = await save(workerId, { department: secondDepartmentId }, caller.client);
      expect(error?.code).toBe("P0002");
    }
    // Another organisation's owner can't reach this worker either.
    const cross = await other.client.rpc("save_worker_mapping", {
      p_organisation_id: owner.orgId,
      p_worker_id: workerId,
      p_department_id: secondDepartmentId,
    });
    expect(cross.error?.code).toBe("P0002");
    const { data } = await admin
      .from("workers")
      .select("department_id")
      .eq("id", workerId)
      .single();
    expect(data?.department_id).toBeNull();

    const byOwner = await save(workerId, { department: secondDepartmentId }, owner.client);
    expect(byOwner.error).toBeNull();
  });
});

describe("worker_line_manager_contact", () => {
  it("gives owner, admin and hr the line manager's address, and nobody else", async () => {
    const managed = await newWorker({ line_manager_membership_id: lineManagerMembership });
    const ask = (by: Client, org = owner.orgId) =>
      by.rpc("worker_line_manager_contact", { p_organisation_id: org, p_worker_id: managed });

    const forHr = await ask(hr.client);
    expect(forHr.error).toBeNull();
    expect(forHr.data).toEqual([
      { email: lineManager.email, name: "Kola Adebayo", user_id: lineManager.id },
    ]);

    for (const caller of [ops, lineManager]) {
      const { data, error } = await ask(caller.client);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    // Another organisation's owner, naming either organisation.
    expect((await ask(other.client)).data).toEqual([]);
    expect((await ask(other.client, other.orgId)).data).toEqual([]);
  });

  it("uses a worker line manager's own email, and nothing when they have none", async () => {
    const withEmail = await newWorker({ email: "kola.adebayo@example.test" });
    const withoutEmail = await newWorker();
    const a = await newWorker({ line_manager_worker_id: withEmail });
    const b = await newWorker({ line_manager_worker_id: withoutEmail });
    const unmanaged = await newWorker();
    const ask = (workerId: string) =>
      hr.client.rpc("worker_line_manager_contact", {
        p_organisation_id: owner.orgId,
        p_worker_id: workerId,
      });

    expect((await ask(a)).data).toEqual([
      { email: "kola.adebayo@example.test", name: expect.stringContaining("Musa"), user_id: null },
    ]);
    expect((await ask(b)).data).toEqual([
      { email: null, name: expect.stringContaining("Musa"), user_id: null },
    ]);
    expect((await ask(unmanaged)).data).toEqual([]);
  });
});

describe("worker_assignments rules", () => {
  it("refuses two overlapping rows for the same site or project", async () => {
    const workerId = await mappedWorker();
    for (const target of [{ site_id: siteA }, { project_id: projectP }]) {
      const { error } = await hr.client.from("worker_assignments").insert({
        organisation_id: owner.orgId,
        worker_id: workerId,
        effective_from: TOMORROW,
        ...target,
      });
      expect(error?.code).toBe("23P01");
    }
    // A different site on the same days is fine (the panel keeps one, the table allows more).
    const different = await hr.client.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      site_id: siteB,
      effective_from: TOMORROW,
    });
    expect(different.error).toBeNull();
  });

  it("never removes a row that was in force; a scheduled one may go", async () => {
    const workerId = await mappedWorker();
    const inForce = await hr.client
      .from("worker_assignments")
      .delete()
      .eq("worker_id", workerId)
      .eq("site_id", siteA)
      .select("id");
    expect(inForce.error?.code).toBe("MLAS3");

    const scheduled = await hr.client
      .from("worker_assignments")
      .insert({
        organisation_id: owner.orgId,
        worker_id: workerId,
        site_id: siteB,
        effective_from: IN_10,
      })
      .select("id")
      .single();
    expect(scheduled.error).toBeNull();
    const gone = await hr.client
      .from("worker_assignments")
      .delete()
      .eq("id", scheduled.data!.id)
      .select("id");
    expect(gone.error).toBeNull();
    expect(gone.data).toHaveLength(1);
  });

  it("read-only roles can't remove assignments", async () => {
    const workerId = await newWorker();
    const scheduled = await hr.client
      .from("worker_assignments")
      .insert({
        organisation_id: owner.orgId,
        worker_id: workerId,
        site_id: siteB,
        effective_from: IN_10,
      })
      .select("id")
      .single();
    const { data, error } = await ops.client
      .from("worker_assignments")
      .delete()
      .eq("id", scheduled.data!.id)
      .select("id");
    if (error) expect(error.code).toBe(PERMISSION_DENIED);
    else expect(data).toEqual([]);
    expect(await rows(workerId)).toHaveLength(1);
  });
});
