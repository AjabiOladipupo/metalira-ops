/**
 * Slice 4.0: line managers stop reading public.workers; they read their reportees through
 * public.my_reportees (docs/PHASE_4.md 4.0, the "team_members" read), safe columns only.
 * - workers_select: a line manager selecting bank_account_last4, nin_enc, tin or rsa_pin_last4
 *   gets no rows; a line manager with a worker record reads only their own row. Owner, hr,
 *   finance and ops_manager read as before.
 * - my_reportees: only the caller's reportees (by membership or by worker record), only the
 *   safe columns (a snapshot of the column list, checked against the function's definition), no
 *   rows for a line manager of another company, for another company's id, for other roles, for
 *   an untrusted password session; anon can't call it, nobody can call the private definer
 *   from outside.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  markPasswordTrusted,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

/**
 * The columns my_reportees returns, in order. Changing this list is a security decision: every
 * column here is visible to a line manager. Never add an _enc or _last4 column, bank name,
 * account name, bank code or check, TIN, tax state, PFA, NHF, rent, pay or next of kin.
 */
const SAFE_COLUMNS = [
  "id",
  "staff_id",
  "first_name",
  "last_name",
  "phone",
  "email",
  "job_title",
  "department_id",
  "department_name",
  "employment_type",
  "status",
  "start_date",
  "end_date",
  "line_manager_worker_id",
  "line_manager_membership_id",
  "line_manager_name",
  "usual_work_days",
  "supervisor_clock_in",
  "site_ids",
  "site_names",
];

const SENSITIVE = /(_enc|_last4|bank|account|tin|tax|pfa|nhf|rent|kobo|pay|rate|next_of_kin|nin|rsa|bvn|salary)/;

const CENTRE = "SRID=4326;POINT(3.3611 6.4474)";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const staff = {} as Record<"hr" | "finance" | "ops" | "lineManager" | "supervisor", TestUser>;
let otherLineManager: TestUser;
let lmMembershipId: string;
let departmentId: string;
let siteId: string;
let counter = 0;
const W = {} as Record<
  "reportee" | "ended" | "notMine" | "supervisor" | "viaWorker" | "otherReportee",
  string
>;

async function addMember(
  user: TestUser,
  role: Role,
  orgId = owner.orgId,
  workerId?: string,
): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role, worker_id: workerId ?? null })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function addWorker(
  name: string,
  orgId = owner.orgId,
  extra: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
): Promise<string> {
  counter += 1;
  const [first, last] = name.split(" ");
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `MR-${String(counter).padStart(4, "0")}`,
      first_name: first!,
      last_name: last!,
      phone: `0803124${String(4400 + counter).padStart(4, "0")}`,
      email: `mr-${counter}@example.test`,
      job_title: "Guard",
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...extra,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

/** Bank, tax, NIN and RSA details, written as the database owner with triggers off. */
async function addSensitive(workerId: string): Promise<void> {
  await db.query("begin");
  try {
    await db.query("set local session_replication_role = replica");
    await db.query(
      `update public.workers
          set bank_name = 'Zenith Bank', account_name = 'Test Account', bank_account_last4 = '1234',
              bank_account_enc = '\\x01'::bytea, nin_enc = '\\x02'::bytea, tin = 'TIN-0001',
              tax_state = 'Lagos', pfa_name = 'Test PFA', rsa_pin_enc = '\\x03'::bytea,
              rsa_pin_last4 = '5678', nhf_opt_in = true, annual_rent_declared_kobo = 120000000,
              next_of_kin_name = 'Kin Name', next_of_kin_phone = '08031234567'
        where id = $1`,
      [workerId],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

async function reportees(client: Client, orgId = owner.orgId) {
  return client.rpc("my_reportees", { p_organisation_id: orgId });
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("mr-owner", "Reportees Owner Ltd");
  other = await createTenantUser("mr-other", "Reportees Other Ltd");
  staff.hr = await createTestUser("mr-hr");
  staff.finance = await createTestUser("mr-finance");
  staff.ops = await createTestUser("mr-ops");
  staff.lineManager = await createTestUser("mr-lm", "Chidi Okafor");
  staff.supervisor = await createTestUser("mr-supervisor");
  otherLineManager = await createTestUser("mr-other-lm");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  lmMembershipId = await addMember(staff.lineManager, "line_manager");

  const dept = await admin
    .from("departments")
    .insert({ organisation_id: owner.orgId, name: "Guarding" })
    .select("id")
    .single();
  expect(dept.error).toBeNull();
  departmentId = dept.data!.id;

  const { data: clientId, error: clientError } = await admin.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Apapa client",
    p_contact_name: "Ngozi Eze",
    p_contact_email: "accounts@client.example",
  });
  expect(clientError).toBeNull();
  const site = await admin
    .from("sites")
    .insert({
      organisation_id: owner.orgId,
      client_id: clientId!,
      name: "Apapa Warehouse 3",
      centre: CENTRE,
    } as never)
    .select("id")
    .single();
  expect(site.error).toBeNull();
  siteId = site.data!.id;

  W.reportee = await addWorker("Musa Bello", owner.orgId, {
    line_manager_membership_id: lmMembershipId,
    department_id: departmentId,
    supervisor_clock_in: true,
  });
  W.ended = await addWorker("Amaka Obi", owner.orgId, {
    line_manager_membership_id: lmMembershipId,
    status: "ended",
    end_date: "2026-10-31",
  });
  W.notMine = await addWorker("Tunde Ade");
  // A line manager who is also a worker, managing through their worker record.
  W.supervisor = await addWorker("Kemi Lawal");
  await addMember(staff.supervisor, "line_manager", owner.orgId, W.supervisor);
  W.viaWorker = await addWorker("Sade Ojo", owner.orgId, { line_manager_worker_id: W.supervisor });
  // Another company's line manager and reportee.
  const otherLm = await addMember(otherLineManager, "line_manager", other.orgId);
  W.otherReportee = await addWorker("Ife Musa", other.orgId, {
    line_manager_membership_id: otherLm,
  });

  for (const id of Object.values(W)) await addSensitive(id);

  const mapped = await admin.from("worker_assignments").insert({
    organisation_id: owner.orgId,
    worker_id: W.reportee,
    site_id: siteId,
    effective_from: "2025-01-06",
  });
  expect(mapped.error).toBeNull();
});

afterAll(async () => {
  await db?.end();
});

describe("workers_select without line-manager branches", () => {
  it("gives a line manager no reportee rows, whatever the columns", async () => {
    const client = staff.lineManager.client;
    for (const columns of ["bank_account_last4", "nin_enc", "tin", "rsa_pin_last4", "id"]) {
      const { data, error } = await client.from("workers").select(columns);
      expect(error, columns).toBeNull();
      expect(data, columns).toEqual([]);
    }
    const one = await client
      .from("workers")
      .select("bank_account_last4")
      .eq("id", W.reportee)
      .maybeSingle();
    expect(one.error).toBeNull();
    expect(one.data).toBeNull();
  });

  it("lets a line manager with a worker record read only their own row", async () => {
    const { data, error } = await staff.supervisor.client.from("workers").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([W.supervisor]);
  });

  it("leaves owner, hr, finance and ops_manager reading the company's workers", async () => {
    for (const reader of [owner, staff.hr, staff.finance, staff.ops]) {
      const { data, error } = await reader.client
        .from("workers")
        .select("id, bank_account_last4")
        .eq("id", W.reportee);
      expect(error).toBeNull();
      expect(data).toEqual([{ id: W.reportee, bank_account_last4: "1234" }]);
    }
  });
});

describe("my_reportees", () => {
  it("returns a line manager's reportees only, with their details", async () => {
    const { data, error } = await reportees(staff.lineManager.client);
    expect(error).toBeNull();
    expect(data!.map((r) => r.id).sort()).toEqual([W.reportee, W.ended].sort());
    const musa = data!.find((r) => r.id === W.reportee)!;
    expect(musa).toMatchObject({
      first_name: "Musa",
      last_name: "Bello",
      job_title: "Guard",
      department_id: departmentId,
      department_name: "Guarding",
      status: "active",
      line_manager_membership_id: lmMembershipId,
      line_manager_worker_id: null,
      line_manager_name: "Chidi Okafor",
      supervisor_clock_in: true,
      site_ids: [siteId],
      site_names: ["Apapa Warehouse 3"],
    });
    expect(musa.phone).toMatch(/^0803124\d{4}$/);
    const amaka = data!.find((r) => r.id === W.ended)!;
    expect(amaka).toMatchObject({ status: "ended", end_date: "2026-10-31", site_ids: [] });
  });

  it("returns the reportees of a line manager who manages through their worker record", async () => {
    const { data, error } = await reportees(staff.supervisor.client);
    expect(error).toBeNull();
    expect(data!.map((r) => r.id)).toEqual([W.viaWorker]);
    expect(data![0]).toMatchObject({
      line_manager_worker_id: W.supervisor,
      line_manager_name: "Kemi Lawal",
    });
  });

  it("returns exactly the safe columns and never a personal number", async () => {
    const { data } = await reportees(staff.lineManager.client);
    for (const row of data!) {
      expect(Object.keys(row)).toEqual(SAFE_COLUMNS);
      const values = JSON.stringify(row);
      for (const secret of ["1234", "5678", "TIN-0001", "Zenith", "Test PFA", "Kin Name"]) {
        expect(values).not.toContain(secret);
      }
    }
  });

  it("matches the column snapshot in the database definition", async () => {
    const { rows } = await db.query<{ schema: string; columns: string[] }>(
      `select n.nspname as schema,
              array(
                select a.name
                from unnest(p.proargnames, p.proargmodes) with ordinality as a (name, mode, i)
                where a.mode = 't'
                order by a.i
              ) as columns
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'my_reportees'
        order by n.nspname`,
    );
    expect(rows.map((r) => r.schema)).toEqual(["private", "public"]);
    for (const row of rows) {
      expect(row.columns, row.schema).toEqual(SAFE_COLUMNS);
      const leaked = row.columns.filter(
        (c) => SENSITIVE.test(c) && !["line_manager_name"].includes(c),
      );
      expect(leaked, row.schema).toEqual([]);
    }
  });

  it("returns usual_work_days once workers has the column (slice 4.1)", async () => {
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'workers' and column_name = 'usual_work_days'`,
    );
    if (rows.length === 0) {
      const { data } = await reportees(staff.lineManager.client);
      expect(data!.every((r) => r.usual_work_days === null)).toBe(true);
      return;
    }
    await db.query("update public.workers set usual_work_days = '{1,2,3}' where id = $1", [
      W.reportee,
    ]);
    const { data } = await reportees(staff.lineManager.client);
    expect(data!.find((r) => r.id === W.reportee)!.usual_work_days).toEqual([1, 2, 3]);
  });

  it("gives nothing for another company, to its line manager, or to other roles", async () => {
    // Our line manager asking about another company.
    const elsewhere = await reportees(staff.lineManager.client, other.orgId);
    expect(elsewhere.error).toBeNull();
    expect(elsewhere.data).toEqual([]);
    // Another company's line manager asking about ours, and about their own.
    const theirs = await reportees(otherLineManager.client);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toEqual([]);
    const own = await reportees(otherLineManager.client, other.orgId);
    expect(own.data!.map((r) => r.id)).toEqual([W.otherReportee]);
    // Roles with no reportees.
    for (const reader of [owner, staff.hr, staff.finance, staff.ops]) {
      const { data, error } = await reportees(reader.client);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it("gives an untrusted password session nothing until it is trusted", async () => {
    const email = `rls-mr-untrusted-${randomUUID()}@example.test`;
    const password = `${randomUUID()}a1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = anonClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const membership = await addMember(
      { id: created.data.user!.id, email, client },
      "line_manager",
    );
    await addWorker("Bisi Eze", owner.orgId, { line_manager_membership_id: membership });
    const untrusted = await reportees(client);
    expect(untrusted.error).toBeNull();
    expect(untrusted.data).toEqual([]);
    await markPasswordTrusted(created.data.user!.id);
    await client.auth.refreshSession();
    const trusted = await reportees(client);
    expect(trusted.data).toHaveLength(1);
  });

  it("can't be called by anon, and the definer isn't reachable from outside", async () => {
    expect((await reportees(anonClient())).error).not.toBeNull();
    const { rows } = await db.query(
      `select has_function_privilege('anon', 'public.my_reportees(uuid)', 'execute') as anon_public,
              has_function_privilege('anon', 'private.my_reportees(uuid)', 'execute') as anon_private,
              has_function_privilege('authenticated', 'public.my_reportees(uuid)', 'execute') as auth_public,
              (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'private' and p.proname = 'my_reportees') as definer,
              (select proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'private' and p.proname = 'my_reportees') as config`,
    );
    expect(rows[0]).toMatchObject({
      anon_public: false,
      anon_private: false,
      auth_public: true,
      definer: true,
      config: ['search_path=""'],
    });
  });
});
