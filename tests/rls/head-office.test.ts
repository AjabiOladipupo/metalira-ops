/**
 * Slice 6.11: a Head office site for non-service staff, against the real database
 * (migration 20261127090000_head_office):
 * - every company has exactly one "Head office" office site, backfilled and made with each new
 *   company; an office has no client and a client's site always has one; a site never changes
 *   kind; hr can't add an office, ops_manager can;
 * - an office is never on a contract (MLHO2), in headcount (MLHO3) or on a post (MLHO4), for the
 *   database owner too and with ordinary triggers off (the guards are ENABLE ALWAYS);
 * - mapping to Head office works from the single save and the bulk "Map to site and project", and
 *   projects for it are refused (MLHO5, MLBM3);
 * - office sites are absent from the client site reads;
 * - another company can't see, change or map to the office; an untrusted session gets 42501.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, lagosToday } from "@/lib/dates";
import { HEAD_OFFICE_NAME } from "@/lib/office-sites";
import {
  listClientSites,
  listOffices,
  listSitesWithoutGeofence,
  loadOfficeSite,
  loadSite,
  loadSitesSummary,
} from "@/server/sites/sites-data";
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

const DENIED = "42501";
const SINCE = "2025-01-06";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let ops: TestUser;
let clientId: string;
let apapa: string;
let headOffice: string;
let theirHeadOffice: string;
let project: string;
let staff = 0;

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function officeOf(orgId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id::text from public.sites
     where organisation_id = $1 and kind = 'office' and name = 'Head office'`,
    [orgId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function newWorker(by: Client = hr.client, orgId = owner.orgId): Promise<string> {
  staff += 1;
  const id = randomUUID();
  const { error } = await by.rpc("create_worker", {
    p_worker: {
      id,
      organisation_id: orgId,
      staff_id: `HO-${String(staff).padStart(4, "0")}`,
      first_name: "Ngozi",
      last_name: `Office ${staff}`,
      employment_type: "permanent",
      start_date: SINCE,
    },
  });
  expect(error).toBeNull();
  return id;
}

type AssignmentRow = {
  client_id: string | null;
  site_id: string | null;
  project_id: string | null;
  effective_to: string | null;
};

async function openRowsOf(workerId: string): Promise<AssignmentRow[]> {
  const { rows } = await db.query<AssignmentRow>(
    `select client_id::text, site_id::text, project_id::text, effective_to::text
     from public.worker_assignments
     where worker_id = $1 and (effective_to is null or effective_to > current_date)
     order by site_id nulls last, project_id nulls last`,
    [workerId],
  );
  return rows;
}

function save(workerId: string, site: string | null, projects: string[] = [], by = hr.client) {
  return by.rpc("save_worker_mapping", {
    p_organisation_id: owner.orgId,
    p_worker_id: workerId,
    p_site_id: site ?? undefined,
    p_project_ids: projects,
  });
}

function bulkMap(by: Client, ids: string[], site: string, projects: string[] = []) {
  return by.rpc("bulk_map_workers", {
    p_organisation_id: owner.orgId,
    p_worker_ids: ids,
    p_site_id: site,
    p_project_ids: projects,
    p_mode: "replace",
    p_dry_run: false,
  });
}

/** Runs `sql` as the database owner with ordinary triggers off; returns the SQLSTATE refused. */
async function refusedInReplica(sql: string, values: unknown[]): Promise<string | undefined> {
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(sql, values);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    await db.query("rollback");
  }
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("ho-owner", "Head Office Org");
  other = await createTenantUser("ho-other", "Other Office Org");
  hr = await createTestUser("ho-hr");
  ops = await createTestUser("ho-ops");
  await addMember(hr, "hr");
  await addMember(ops, "ops_manager");

  const created = await owner.client.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_site_name: "Apapa Warehouse 3",
  });
  expect(created.error).toBeNull();
  clientId = created.data!;
  const { data: sites } = await admin.from("sites").select("id").eq("client_id", clientId);
  apapa = sites![0]!.id;
  const projects = await hr.client
    .from("projects")
    .insert({ organisation_id: owner.orgId, client_id: clientId, name: "Night patrol" })
    .select("id")
    .single();
  expect(projects.error).toBeNull();
  project = projects.data!.id;

  headOffice = await officeOf(owner.orgId);
  theirHeadOffice = await officeOf(other.orgId);
});

afterAll(async () => {
  await db?.end();
});

describe("Head office for every company", () => {
  it("gives every company exactly one Head office, with no client", async () => {
    const { rows } = await db.query<{ id: string; n: number }>(
      `select o.id::text, count(s.id)::int as n
       from public.organisations o
       left join public.sites s
         on s.organisation_id = o.id and s.kind = 'office' and s.name = 'Head office'
       group by o.id
       having count(s.id) <> 1`,
    );
    expect(rows).toEqual([]);
    const { rows: office } = await db.query<{ client_id: string | null; status: string }>(
      "select client_id::text, status from public.sites where id = $1",
      [headOffice],
    );
    expect(office).toEqual([{ client_id: null, status: "active" }]);
  });

  it("refuses an office with a client and a client's site without one", async () => {
    const withClient = await admin.from("sites").insert({
      organisation_id: owner.orgId,
      kind: "office",
      client_id: clientId,
      name: "Ikeja branch",
    });
    expect(withClient.error?.code).toBe("23514");
    const withoutClient = await admin
      .from("sites")
      .insert({ organisation_id: owner.orgId, client_id: null, name: "Nowhere" });
    expect(withoutClient.error?.code).toBe("23514");
  });

  it("never changes a site's kind or client, even for the database owner with triggers off", async () => {
    expect(
      await refusedInReplica("update public.sites set kind = 'client' where id = $1", [headOffice]),
    ).toBe("MLHO1");
    expect(
      await refusedInReplica(
        "update public.sites set kind = 'office', client_id = null where id = $1",
        [apapa],
      ),
    ).toBe("MLHO1");
    expect(
      await refusedInReplica("update public.sites set client_id = null where id = $1", [apapa]),
    ).toBe("MLST5");
  });

  it("lets ops_manager add a branch office and refuses hr", async () => {
    const byHr = await hr.client
      .from("sites")
      .insert({ organisation_id: owner.orgId, kind: "office", name: "Hr branch" });
    expect(byHr.error?.code).toBe(DENIED);

    const byOps = await ops.client
      .from("sites")
      .insert({ organisation_id: owner.orgId, kind: "office", name: "Ikeja branch" })
      .select("id, kind, client_id")
      .single();
    expect(byOps.error).toBeNull();
    expect(byOps.data).toMatchObject({ kind: "office", client_id: null });

    const twice = await ops.client
      .from("sites")
      .insert({ organisation_id: owner.orgId, kind: "office", name: "ikeja BRANCH" });
    expect(twice.error?.code).toBe("23505");

    const audit = await db.query<{ action: string }>(
      "select action from public.audit_log where entity = 'sites' and entity_id = $1",
      [byOps.data!.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["sites.insert"]);
  });

  it("lets ops_manager set the office's address and geofence", async () => {
    const { error } = await ops.client
      .from("sites")
      .update({ address: "12 Adeola Odeku Street, Victoria Island", radius_m: 150 })
      .eq("id", headOffice);
    expect(error).toBeNull();
    const byHr = await hr.client
      .from("sites")
      .update({ address: "Somewhere else" })
      .eq("id", headOffice)
      .select("id");
    expect(byHr.data ?? []).toEqual([]);
  });
});

describe("an office is never a client's site", () => {
  it("refuses a contract on Head office (MLHO2)", async () => {
    const { error } = await ops.client.rpc("create_contract", {
      p_organisation_id: owner.orgId,
      p_contract: {
        client_id: clientId,
        name: "Office guarding",
        type: "manned_post",
        start_date: addDays(lagosToday(), 7),
      } as Json,
      p_site_ids: [apapa, headOffice],
    });
    expect(error?.code).toBe("MLHO2");
    const { rows } = await db.query("select 1 from public.contract_sites where site_id = $1", [
      headOffice,
    ]);
    expect(rows).toEqual([]);
  });

  it("refuses a contract site, headcount or post at an office for the database owner, triggers off", async () => {
    const contract = randomUUID();
    expect(
      await refusedInReplica(
        `insert into public.contract_sites (organisation_id, contract_id, site_id)
         values ($1, $2, $3)`,
        [owner.orgId, contract, headOffice],
      ),
    ).toBe("MLHO2");
    expect(
      await refusedInReplica(
        `insert into public.headcount_requirements
           (organisation_id, contract_id, site_id, role, unit, days_of_week, start_time,
            end_time, required_count)
         values ($1, $2, $3, 'Receptionist', 'shift', '{1,2,3,4,5}', '08:00', '17:00', 1)`,
        [owner.orgId, contract, headOffice],
      ),
    ).toBe("MLHO3");
    expect(
      await refusedInReplica(
        `insert into public.posts
           (organisation_id, contract_id, site_id, name, role, unit, opened_on)
         values ($1, $2, $3, 'Front desk', 'Receptionist', 'shift', current_date)`,
        [owner.orgId, contract, headOffice],
      ),
    ).toBe("MLHO4");
  });
});

describe("mapping to Head office", () => {
  it("maps one person with the single save, with no client and no projects", async () => {
    const id = await newWorker();
    const { data, error } = await save(id, headOffice);
    expect(error).toBeNull();
    expect((data as { changed: boolean }).changed).toBe(true);
    expect(await openRowsOf(id)).toEqual([
      { client_id: null, site_id: headOffice, project_id: null, effective_to: null },
    ]);
  });

  it("refuses projects for an office in the single save (MLHO5)", async () => {
    const id = await newWorker();
    const { error } = await save(id, headOffice, [project]);
    expect(error?.code).toBe("MLHO5");
    expect(await openRowsOf(id)).toEqual([]);
  });

  it("moves someone from a client's site and project to Head office, closing both", async () => {
    const id = await newWorker();
    const seeded = await hr.client.from("worker_assignments").insert([
      { organisation_id: owner.orgId, worker_id: id, site_id: apapa, effective_from: SINCE },
      { organisation_id: owner.orgId, worker_id: id, project_id: project, effective_from: SINCE },
    ]);
    expect(seeded.error).toBeNull();
    expect((await save(id, headOffice)).error).toBeNull();
    const open = (await openRowsOf(id)).filter((r) => r.effective_to === null);
    expect(open).toEqual([
      { client_id: null, site_id: headOffice, project_id: null, effective_to: null },
    ]);
  });

  it("bulk-maps three people to Head office and refuses projects for it (MLBM3)", async () => {
    const ids = [await newWorker(), await newWorker(), await newWorker()];
    const refused = await bulkMap(hr.client, ids, headOffice, [project]);
    expect(refused.error?.code).toBe("MLBM3");
    for (const id of ids) expect(await openRowsOf(id)).toEqual([]);

    const { data, error } = await bulkMap(hr.client, ids, headOffice);
    expect(error).toBeNull();
    expect(data).toMatchObject({ selected: 3, changed: 3 });
    for (const id of ids) {
      expect(await openRowsOf(id)).toEqual([
        { client_id: null, site_id: headOffice, project_id: null, effective_to: null },
      ]);
    }
  });

  it("refuses an office row naming a client or a project, and a project beside an office row", async () => {
    const id = await newWorker();
    const withClient = await hr.client.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: id,
      site_id: headOffice,
      client_id: clientId,
      effective_from: SINCE,
    });
    expect(withClient.error?.code).toBe("MLHO5");

    const atOffice = await hr.client.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: id,
      site_id: headOffice,
      effective_from: SINCE,
    });
    expect(atOffice.error).toBeNull();
    const projectToo = await hr.client.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: id,
      project_id: project,
      effective_from: SINCE,
    });
    expect(projectToo.error?.code).toBe("MLHO5");
    // The secret key is refused too (ENABLE ALWAYS).
    const viaAdmin = await admin.from("worker_assignments").insert({
      organisation_id: owner.orgId,
      worker_id: id,
      project_id: project,
      effective_from: SINCE,
    });
    expect(viaAdmin.error?.code).toBe("MLHO5");
  });
});

describe("office sites are left out of the client site reads", () => {
  it("lists only the client's sites, counts no office and opens the office only as an office", async () => {
    const clientSites = await listClientSites(owner.client, owner.orgId, clientId);
    expect(clientSites.map((s) => s.id)).toEqual([apapa]);
    // Security review M1: an office with no geofence is listed (first, linking to its office
    // page) and counted, so it gets one; clients' sites keep their client.
    const without = await listSitesWithoutGeofence(owner.client, owner.orgId);
    const unfencedOffices = without.filter((s) => s.clientId === null);
    expect(unfencedOffices.map((s) => s.siteId)).toContain(headOffice);
    expect(unfencedOffices.every((s) => s.href === `/app/settings/offices/${s.siteId}`)).toBe(true);
    expect(without.slice(0, unfencedOffices.length)).toEqual(unfencedOffices);
    const clientRows = without.filter((s) => s.clientId !== null);
    expect(clientRows.map((s) => s.siteId)).toEqual([apapa]);
    const summary = await loadSitesSummary(owner.client, owner.orgId);
    // Apapa, Head office and the Ikeja branch added above, none with a geofence.
    expect(summary).toMatchObject({ active: 3, archived: 0, withoutGeofence: 3 });

    expect(await loadSite(owner.client, owner.orgId, clientId, headOffice)).toBeNull();
    const office = await loadOfficeSite(owner.client, owner.orgId, headOffice);
    expect(office).toMatchObject({ id: headOffice, kind: "office", clientId: null });
    expect(await loadOfficeSite(owner.client, owner.orgId, apapa)).toBeNull();

    const offices = await listOffices(owner.client, owner.orgId);
    expect(offices[0]).toMatchObject({ id: headOffice, name: HEAD_OFFICE_NAME });
    expect(offices.every((o) => o.kind === "office")).toBe(true);

    const { data: clients } = await owner.client
      .from("clients")
      .select("id, sites(id)")
      .eq("organisation_id", owner.orgId);
    expect(clients!.flatMap((c) => c.sites.map((s) => s.id))).not.toContain(headOffice);
  });
});

describe("the people import with a Head office (security review H1)", () => {
  it("commits an import in a company that has a Head office, and never maps a row to it", async () => {
    const batchId = randomUUID();
    const created = await hr.client.from("import_batches").insert({
      id: batchId,
      organisation_id: owner.orgId,
      file_name: "employees.csv",
      file_format: "csv",
      file_path: `${owner.orgId}/${batchId}.csv`,
    });
    expect(created.error).toBeNull();
    const rowId = randomUUID();
    const checked = await hr.client.rpc("save_import_check", {
      p_organisation_id: owner.orgId,
      p_batch_id: batchId,
      p_check: {
        columns: ["employee_id", "first_name"],
        file_notes: [],
        summary: { rows: 1 },
        rows_expected: 1,
      },
      p_rows: [
        {
          id: rowId,
          row_number: 2,
          raw: { first_name: "Imported", last_name: "Guard" },
          status: "ready",
        },
      ],
      p_final: true,
    });
    expect(checked.error).toBeNull();
    const workerId = randomUUID();
    const { data, error } = await hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: batchId,
      p_rows: [
        {
          row_id: rowId,
          worker: {
            id: workerId,
            staff_id: "HO-IMP-1",
            first_name: "Imported",
            last_name: "Guard",
            phone: null,
            employment_type: "permanent",
            start_date: "2024-03-03",
          },
          pay_rate: null,
          department: null,
          line_manager: null,
          client: { name: "Coastline Logistics" },
          site: { name: "Apapa Warehouse 3" },
          project: null,
        },
      ] as unknown as Json,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ created: 1, clients: 0, sites: 0 });
    expect(await openRowsOf(workerId)).toEqual([
      { client_id: clientId, site_id: apapa, project_id: null, effective_to: null },
    ]);
  });
});

describe("isolation and trust", () => {
  it("hides each company's office from the other, and refuses changing or mapping to it", async () => {
    const seen = await other.client.from("sites").select("id, kind").eq("id", headOffice);
    expect(seen.data ?? []).toEqual([]);
    const theirs = await other.client.from("sites").select("id, kind").eq("id", theirHeadOffice);
    expect(theirs.data).toEqual([{ id: theirHeadOffice, kind: "office" }]);

    const changed = await other.client
      .from("sites")
      .update({ name: "Hijacked" })
      .eq("id", headOffice)
      .select("id");
    expect(changed.data ?? []).toEqual([]);

    const planted = await other.client
      .from("sites")
      .insert({ organisation_id: owner.orgId, kind: "office", name: "Planted office" });
    expect(planted.error?.code).toBe(DENIED);

    const theirWorker = await newWorker(other.client, other.orgId);
    const mapped = await other.client.rpc("save_worker_mapping", {
      p_organisation_id: other.orgId,
      p_worker_id: theirWorker,
      p_site_id: headOffice,
    });
    expect(mapped.error?.code).toBe("MLAS4");
    const mine = await newWorker();
    expect((await bulkMap(hr.client, [mine], theirHeadOffice)).error?.code).toBe("MLBM3");
    expect(await openRowsOf(mine)).toEqual([]);
  });

  it("refuses an untrusted session with 42501, even with the HR or ops_manager role", async () => {
    const email = `rls-ho-untrusted-${randomUUID()}@example.test`;
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
    expect((await bulkMap(client, [id], headOffice)).error?.code).toBe(DENIED);
    expect(await openRowsOf(id)).toEqual([]);

    // An untrusted ops_manager can't add an office either (RLS's set helpers need trust).
    const untrustedOps = `rls-ho-untrusted-ops-${randomUUID()}@example.test`;
    const opsUser = await admin.auth.admin.createUser({
      email: untrustedOps,
      password,
      email_confirm: true,
    });
    expect(opsUser.error).toBeNull();
    const opsClient = anonClient();
    expect(
      (await opsClient.auth.signInWithPassword({ email: untrustedOps, password })).error,
    ).toBeNull();
    await addMember(
      { id: opsUser.data.user!.id, email: untrustedOps, client: opsClient },
      "ops_manager",
    );
    const office = await opsClient
      .from("sites")
      .insert({ organisation_id: owner.orgId, kind: "office", name: "Untrusted branch" });
    expect(office.error?.code).toBe(DENIED);
  });
});
