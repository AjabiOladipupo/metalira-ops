/**
 * Slice U.3 bulk mapping, against the real database:
 * - public.bulk_map_workers runs the single mapping save for each person, so Replace and Add give
 *   exactly the rows public.save_worker_mapping gives for the same choice; department and line
 *   manager stay as they were.
 * - All or nothing: one leaver, one person of another company, or (Add) someone at another site
 *   refuses the batch with a reason per person (MLBM2), and nothing changes. The dry run changes
 *   nothing either.
 * - Another company's site or project, or a project of another client, is refused (MLBM3).
 * - Owner, admin and hr may (the single save's roles); ops_manager and line managers get 42501,
 *   and so does an untrusted session.
 * - The confirm acts only on the people and the choice the preview signed (MLLB3).
 * - One `people.mapping_saved` row per person, in the single save's shape, and one batch row.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ListChanged } from "@/server/identity/bulk-selection";
import { bulkMapSpec, previewBulkMapSpec } from "@/server/people/bulk-mapping";
import type { Database, Json } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  insertMembershipAsOwner,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const DENIED = "42501";
const SINCE = "2025-01-06";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let adminUser: TestUser;
let ops: TestUser;
let lineManager: TestUser;
let lineManagerMembership: string;
let departmentId: string;
let clientId: string;
let apapa: string;
let lekki: string;
let nightPatrol: string;
let dayPatrol: string;
let otherClientProject: string;
let theirSite: string;
let theirProject: string;
let staff = 0;

async function addMember(user: TestUser, role: Role): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function newWorker(fields: Record<string, Json> = {}, orgId?: string): Promise<string> {
  staff += 1;
  const id = randomUUID();
  const by = orgId && orgId !== owner.orgId ? other.client : hr.client;
  const { error } = await by.rpc("create_worker", {
    p_worker: {
      id,
      organisation_id: orgId ?? owner.orgId,
      staff_id: `BM-${String(staff).padStart(4, "0")}`,
      first_name: "Bimpe",
      last_name: `Mapped ${staff}`,
      employment_type: "permanent",
      start_date: SINCE,
      department_id: departmentId,
      line_manager_membership_id: lineManagerMembership,
      ...fields,
    },
  });
  expect(error).toBeNull();
  return id;
}

/** Puts a worker on a site and projects since SINCE (rows already in force). */
async function seed(workerId: string, site: string | null, projects: string[] = []) {
  const rows = [
    ...(site ? [{ organisation_id: owner.orgId, worker_id: workerId, site_id: site }] : []),
    ...projects.map((p) => ({ organisation_id: owner.orgId, worker_id: workerId, project_id: p })),
  ].map((r) => ({ ...r, effective_from: SINCE }));
  if (rows.length === 0) return;
  const { error } = await hr.client.from("worker_assignments").insert(rows);
  expect(error).toBeNull();
}

type AssignmentRow = {
  site_id: string | null;
  project_id: string | null;
  effective_from: string;
  effective_to: string | null;
};

/** A worker's assignment rows, in a stable order, without ids. */
async function rowsOf(workerId: string): Promise<AssignmentRow[]> {
  const { rows } = await db.query<AssignmentRow>(
    `select site_id::text, project_id::text, effective_from::text, effective_to::text
     from public.worker_assignments where worker_id = $1
     order by site_id nulls last, project_id nulls last, effective_from`,
    [workerId],
  );
  return rows;
}

async function workerRow(id: string) {
  const { rows } = await db.query<{ dept: string | null; lm: string | null; lmw: string | null }>(
    `select department_id::text as dept, line_manager_membership_id::text as lm,
            line_manager_worker_id::text as lmw
     from public.workers where id = $1`,
    [id],
  );
  return rows[0]!;
}

function bulkMap(
  by: Client,
  ids: string[],
  site: string,
  projects: string[] = [],
  mode: "replace" | "add" = "replace",
  options: { dryRun?: boolean; org?: string } = {},
) {
  return by.rpc("bulk_map_workers", {
    p_organisation_id: options.org ?? owner.orgId,
    p_worker_ids: ids,
    p_site_id: site,
    p_project_ids: projects,
    p_mode: mode,
    p_dry_run: options.dryRun ?? false,
  });
}

function single(workerId: string, site: string, projects: string[]) {
  return hr.client.rpc("save_worker_mapping", {
    p_organisation_id: owner.orgId,
    p_worker_id: workerId,
    p_department_id: departmentId,
    p_line_manager_membership_id: lineManagerMembership,
    p_site_id: site,
    p_project_ids: projects,
  });
}

function problems(details: string | null | undefined): { worker_id: string; reason: string }[] {
  return JSON.parse(details ?? "[]") as { worker_id: string; reason: string }[];
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("bm-owner", "Bulk Mapping Org");
  other = await createTenantUser("bm-other", "Other Mapping Org");
  hr = await createTestUser("bm-hr");
  adminUser = await createTestUser("bm-admin");
  ops = await createTestUser("bm-ops");
  lineManager = await createTestUser("bm-lm", "Kola Adebayo");
  await addMember(hr, "hr");
  await insertMembershipAsOwner(owner.orgId, adminUser.id, "admin");
  await addMember(ops, "ops_manager");
  lineManagerMembership = await addMember(lineManager, "line_manager");

  const department = await hr.client
    .from("departments")
    .insert({ organisation_id: owner.orgId, name: "Security services" })
    .select("id")
    .single();
  expect(department.error).toBeNull();
  departmentId = department.data!.id;

  const clients = await hr.client
    .from("clients")
    .insert([
      { organisation_id: owner.orgId, name: "Coastline Logistics" },
      { organisation_id: owner.orgId, name: "Harbour Foods" },
    ])
    .select("id, name");
  expect(clients.error).toBeNull();
  clientId = clients.data!.find((c) => c.name === "Coastline Logistics")!.id;
  const otherClient = clients.data!.find((c) => c.name === "Harbour Foods")!.id;

  const sites = await hr.client
    .from("sites")
    .insert([
      { organisation_id: owner.orgId, client_id: clientId, name: "Apapa Gate" },
      { organisation_id: owner.orgId, client_id: clientId, name: "Lekki Estate" },
    ])
    .select("id, name");
  expect(sites.error).toBeNull();
  apapa = sites.data!.find((s) => s.name === "Apapa Gate")!.id;
  lekki = sites.data!.find((s) => s.name === "Lekki Estate")!.id;

  const projects = await hr.client
    .from("projects")
    .insert([
      { organisation_id: owner.orgId, client_id: clientId, name: "Night patrol" },
      { organisation_id: owner.orgId, client_id: clientId, name: "Day patrol" },
      { organisation_id: owner.orgId, client_id: otherClient, name: "Cold store" },
    ])
    .select("id, name");
  expect(projects.error).toBeNull();
  nightPatrol = projects.data!.find((p) => p.name === "Night patrol")!.id;
  dayPatrol = projects.data!.find((p) => p.name === "Day patrol")!.id;
  otherClientProject = projects.data!.find((p) => p.name === "Cold store")!.id;

  const theirClient = await other.client
    .from("clients")
    .insert({ organisation_id: other.orgId, name: "Their client" })
    .select("id")
    .single();
  expect(theirClient.error).toBeNull();
  const site = await other.client
    .from("sites")
    .insert({ organisation_id: other.orgId, client_id: theirClient.data!.id, name: "Their site" })
    .select("id")
    .single();
  expect(site.error).toBeNull();
  theirSite = site.data!.id;
  const project = await other.client
    .from("projects")
    .insert({ organisation_id: other.orgId, client_id: theirClient.data!.id, name: "Theirs" })
    .select("id")
    .single();
  expect(project.error).toBeNull();
  theirProject = project.data!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("bulk_map_workers gives the single save's rows", () => {
  it("Replace: the same rows as save_worker_mapping, department and line manager unchanged", async () => {
    const viaBulk = [await newWorker(), await newWorker()];
    const viaSingle = await newWorker();
    for (const id of [...viaBulk, viaSingle]) await seed(id, lekki, [dayPatrol]);

    const { data, error } = await bulkMap(hr.client, viaBulk, apapa, [nightPatrol]);
    expect(error).toBeNull();
    expect(data).toMatchObject({ dry_run: false, mode: "replace", selected: 2, changed: 2 });
    expect((await single(viaSingle, apapa, [nightPatrol])).error).toBeNull();

    const expected = await rowsOf(viaSingle);
    // Lekki and Day patrol close; Apapa and Night patrol start from the next shift.
    expect(expected).toHaveLength(4);
    expect(
      expected.filter((r) => r.effective_to === null).map((r) => r.site_id ?? r.project_id),
    ).toEqual([apapa, nightPatrol]);
    for (const id of viaBulk) {
      expect(await rowsOf(id)).toEqual(expected);
      expect(await workerRow(id)).toEqual({
        dept: departmentId,
        lm: lineManagerMembership,
        lmw: null,
      });
    }
  });

  it("Add: keeps current projects and adds the chosen ones, as the single save would", async () => {
    const viaBulk = await newWorker();
    const viaSingle = await newWorker();
    const unmapped = await newWorker();
    const unmappedSingle = await newWorker();
    for (const id of [viaBulk, viaSingle]) await seed(id, apapa, [dayPatrol]);

    const { data, error } = await bulkMap(
      hr.client,
      [viaBulk, unmapped],
      apapa,
      [nightPatrol],
      "add",
    );
    expect(error).toBeNull();
    expect(data).toMatchObject({ mode: "add", selected: 2, changed: 2 });
    expect((await single(viaSingle, apapa, [dayPatrol, nightPatrol])).error).toBeNull();
    expect((await single(unmappedSingle, apapa, [nightPatrol])).error).toBeNull();

    expect(await rowsOf(viaBulk)).toEqual(await rowsOf(viaSingle));
    // Nothing closed: Apapa and Day patrol stay open, Night patrol is added.
    expect((await rowsOf(viaBulk)).every((r) => r.effective_to === null)).toBe(true);
    expect(await rowsOf(unmapped)).toEqual(await rowsOf(unmappedSingle));
  });

  it("Add refuses someone at another site (one site per person) and changes nobody", async () => {
    const fine = await newWorker();
    const elsewhere = await newWorker();
    await seed(elsewhere, lekki);
    const before = await rowsOf(elsewhere);

    const { error } = await bulkMap(hr.client, [fine, elsewhere], apapa, [], "add");
    expect(error?.code).toBe("MLBM2");
    const reasons = new Map(problems(error?.details).map((p) => [p.worker_id, p.reason]));
    expect(reasons.get(elsewhere)).toMatch(/^Works at Lekki Estate\. .*Replace/);
    expect(reasons.has(fine)).toBe(false);
    expect(await rowsOf(fine)).toEqual([]);
    expect(await rowsOf(elsewhere)).toEqual(before);
  });

  it("previews with a dry run that changes nothing and writes no audit rows", async () => {
    const id = await newWorker();
    await seed(id, lekki);
    const before = await rowsOf(id);
    const { data, error } = await bulkMap(hr.client, [id], apapa, [nightPatrol], "replace", {
      dryRun: true,
    });
    expect(error).toBeNull();
    const result = data as {
      dry_run: boolean;
      people: {
        worker_id: string;
        before: { sites: { id: string }[] };
        after: { sites: { id: string }[] };
      }[];
      refusals: unknown[];
    };
    expect(result.dry_run).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.people[0]!.before.sites.map((s) => s.id)).toEqual([lekki]);
    expect(result.people[0]!.after.sites.map((s) => s.id)).toEqual([apapa]);
    expect(await rowsOf(id)).toEqual(before);
    const { rows } = await db.query(
      "select 1 from public.audit_log where entity_id = $1 and action = 'people.mapping_saved'",
      [id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("all or nothing", () => {
  it("refuses the whole batch when one person has left", async () => {
    const fine = await newWorker();
    const leaver = await newWorker();
    const ended = await hr.client.rpc("end_employment", {
      p_organisation_id: owner.orgId,
      p_worker_id: leaver,
      p_end_date: SINCE,
    });
    expect(ended.error).toBeNull();

    const { error } = await bulkMap(hr.client, [fine, leaver], apapa, [nightPatrol]);
    expect(error?.code).toBe("MLBM2");
    expect(problems(error?.details)).toEqual([
      expect.objectContaining({
        worker_id: leaver,
        reason: "This employee has left, so their mapping can't change.",
      }),
    ]);
    expect(await rowsOf(fine)).toEqual([]);

    // The preview lists the same refusal without raising.
    const preview = await bulkMap(hr.client, [fine, leaver], apapa, [nightPatrol], "replace", {
      dryRun: true,
    });
    expect(preview.error).toBeNull();
    expect((preview.data as { refusals: { worker_id: string }[] }).refusals).toEqual([
      expect.objectContaining({ worker_id: leaver }),
    ]);
  });

  it("refuses another company's worker, site or project, and a project of another client", async () => {
    const mine = await newWorker();
    const theirs = await newWorker(
      { department_id: null, line_manager_membership_id: null },
      other.orgId,
    );

    const worker = await bulkMap(hr.client, [mine, theirs], apapa);
    expect(worker.error?.code).toBe("MLBM2");
    expect(problems(worker.error?.details)).toEqual([
      expect.objectContaining({ worker_id: theirs, reason: "Not found in this company." }),
    ]);
    expect((await bulkMap(hr.client, [mine], theirSite)).error?.code).toBe("MLBM3");
    expect((await bulkMap(hr.client, [mine], apapa, [theirProject])).error?.code).toBe("MLBM3");
    expect((await bulkMap(hr.client, [mine], apapa, [otherClientProject])).error?.code).toBe(
      "MLBM3",
    );
    expect(await rowsOf(mine)).toEqual([]);
    expect(await rowsOf(theirs)).toEqual([]);

    // A company the caller isn't in.
    const across = await bulkMap(hr.client, [theirs], theirSite, [], "replace", {
      org: other.orgId,
    });
    expect(across.error?.code).toBe(DENIED);
  });

  it("needs a mode, a site and at most 200 people", async () => {
    const id = await newWorker();
    expect((await bulkMap(hr.client, [id], apapa, [], "move" as "add")).error?.code).toBe("MLBM1");
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    expect((await bulkMap(hr.client, tooMany, apapa)).error?.code).toBe("MLBU1");
    expect((await bulkMap(hr.client, [], apapa)).error?.code).toBe("MLBU1");
    expect(await rowsOf(id)).toEqual([]);
  });
});

describe("roles", () => {
  it("lets owner, admin and hr map, as the single save does; ops and line managers can't", async () => {
    for (const user of [owner, adminUser, hr]) {
      const id = await newWorker();
      const { error } = await bulkMap(user.client, [id], apapa);
      expect(error).toBeNull();
      expect((await rowsOf(id)).map((r) => r.site_id)).toEqual([apapa]);
    }
    const reportee = await newWorker();
    for (const user of [ops, lineManager]) {
      expect((await bulkMap(user.client, [reportee], apapa)).error?.code).toBe(DENIED);
      expect(
        (await bulkMap(user.client, [reportee], apapa, [], "replace", { dryRun: true })).error
          ?.code,
      ).toBe(DENIED);
    }
    expect(await rowsOf(reportee)).toEqual([]);
  });

  it("refuses an untrusted session with 42501, even with the HR role", async () => {
    const email = `rls-bm-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const { error: memberError } = await admin
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: created.data.user!.id, role: "hr" });
    expect(memberError).toBeNull();

    const id = await newWorker();
    expect((await bulkMap(client, [id], apapa)).error?.code).toBe(DENIED);
    expect((await bulkMap(client, [id], apapa, [], "replace", { dryRun: true })).error?.code).toBe(
      DENIED,
    );
    expect(await rowsOf(id)).toEqual([]);
  });
});

describe("audit", () => {
  it("writes one people.mapping_saved row per person in the single save's shape, and one batch row", async () => {
    const ids = [await newWorker(), await newWorker()];
    await seed(ids[0]!, lekki);
    const { error } = await bulkMap(hr.client, ids, apapa, [nightPatrol]);
    expect(error).toBeNull();

    const { rows } = await db.query<{
      action: string;
      entity_id: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    }>(
      `select action, entity_id::text, before, after from public.audit_log
       where organisation_id = $1
         and action in ('people.mapping_saved', 'people.bulk_mapping_saved')
         and (entity_id = any($2::uuid[]) or (entity_id is null and after->'worker_ids' ?| $3::text[]))`,
      [owner.orgId, ids, ids],
    );
    const perPerson = rows.filter((r) => r.action === "people.mapping_saved");
    expect(perPerson.map((r) => r.entity_id).sort()).toEqual([...ids].sort());
    for (const row of perPerson) {
      expect(Object.keys(row.before!).sort()).toEqual([
        "department",
        "lineManager",
        "projects",
        "sites",
      ]);
      expect(row.after).toMatchObject({
        department: { id: departmentId },
        lineManager: { kind: "membership", id: lineManagerMembership },
        sites: [{ id: apapa, name: "Apapa Gate" }],
        projects: [{ id: nightPatrol, name: "Night patrol" }],
        bulk: true,
      });
      expect(row.after.assignmentsFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const moved = perPerson.find((r) => r.entity_id === ids[0])!;
    expect(moved.before).toMatchObject({ sites: [{ id: lekki, name: "Lekki Estate" }] });
    const batch = rows.filter((r) => r.action === "people.bulk_mapping_saved");
    expect(batch).toHaveLength(1);
    expect(batch[0]!.after).toMatchObject({
      count: 2,
      changed: 2,
      mode: "replace",
      site_id: apapa,
      project_ids: [nightPatrol],
    });
  });
});

describe("the selection guard", () => {
  const ctx = () => ({
    supabase: hr.client,
    organisationId: owner.orgId,
    userId: hr.id,
    role: "hr" as const,
  });

  it("acts only on the people and the choice the preview signed", async () => {
    const ids = [await newWorker(), await newWorker()];
    const extra = await newWorker();
    const choice = { siteId: apapa, projectIds: [nightPatrol], mode: "replace" as const };
    const preview = await previewBulkMapSpec.run({
      ...ctx(),
      data: { selection: { kind: "ids", ids }, ...choice },
    });
    expect(preview.selection.count).toBe(2);
    expect(preview.rows.every((r) => r.refusal === null && r.changed)).toBe(true);
    const signed = {
      workerIds: preview.selection.ids,
      actIds: preview.selection.act,
      expectedDigest: preview.selection.digest,
    };

    // Someone added to the list after the preview.
    await expect(
      bulkMapSpec.run({
        ...ctx(),
        data: {
          ...signed,
          workerIds: [...signed.workerIds, extra],
          actIds: [...signed.actIds, extra],
          ...choice,
        },
      }),
    ).rejects.toBeInstanceOf(ListChanged);
    // Another site than the preview's.
    await expect(
      bulkMapSpec.run({ ...ctx(), data: { ...signed, ...choice, siteId: lekki } }),
    ).rejects.toMatchObject({ refusal: "MLLB3" });
    // Add instead of Replace.
    await expect(
      bulkMapSpec.run({ ...ctx(), data: { ...signed, ...choice, mode: "add" } }),
    ).rejects.toMatchObject({ refusal: "MLLB3" });
    for (const id of [...ids, extra]) expect(await rowsOf(id)).toEqual([]);

    const done = await bulkMapSpec.run({ ...ctx(), data: { ...signed, ...choice } });
    expect(done.changed).toBe(2);
    expect(done.saved.map((s) => s.workerId).sort()).toEqual([...ids].sort());
    for (const s of done.saved) expect(s.after.sites.map((x) => x.id)).toEqual([apapa]);
    expect(await rowsOf(extra)).toEqual([]);
  });
});
