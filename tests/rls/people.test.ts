/**
 * Slice 1.3 people schema, against the real database: pay-rate versioning (insert new, close
 * old, reject overlap, reject past edit), the worker constraints (staff ID, line manager,
 * needs_pay_details, bank columns), the personal-data audit, and who sees what by role.
 * Cross-organisation isolation for these tables lives in isolation.test.ts (tables/people.ts).
 */
import { randomBytes, randomUUID } from "node:crypto";

import type { PostgrestError } from "@supabase/supabase-js";
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
const YESTERDAY = lagosDate(-1);
const IN_30 = lagosDate(30);
const IN_60 = lagosDate(60);

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const people = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager", TestUser>;
let departmentId: string;
let otherDepartmentId: string;
let clientId: string;
let otherClientId: string;
let siteId: string;
let projectId: string;

async function addMember(user: TestUser, role: Role, workerId: string | null = null) {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role, worker_id: workerId })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

let staffCounter = 0;

/** A worker created through public.create_worker as `by` (hr unless said otherwise). */
async function createWorker(
  fields: Record<string, Json> = {},
  payRate: Record<string, Json> | null = null,
  by: Client = people.hr.client,
): Promise<{ id: string | null; error: PostgrestError | null }> {
  staffCounter += 1;
  const id = randomUUID();
  const { error } = await by.rpc("create_worker", {
    p_worker: {
      id,
      organisation_id: owner.orgId,
      staff_id: `T-${String(staffCounter).padStart(4, "0")}`,
      first_name: "Ada",
      last_name: `Worker ${staffCounter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...fields,
    },
    p_pay_rate: payRate ?? undefined,
  });
  return { id: error ? null : id, error };
}

async function mustCreateWorker(
  fields: Record<string, Json> = {},
  payRate: Record<string, Json> | null = null,
) {
  const { id, error } = await createWorker(fields, payRate);
  expect(error).toBeNull();
  return id!;
}

const monthly = (effectiveFrom: string, basic = "10500050") => ({
  pay_type: "monthly",
  basic_kobo: basic,
  housing_kobo: "6300000",
  transport_kobo: "4200000",
  other_allowances_kobo: "0",
  effective_from: effectiveFrom,
});

async function versions(workerId: string) {
  const { rows } = await db.query<{
    id: string;
    effective_from: string;
    effective_to: string | null;
    basic: string | null;
  }>(
    `select id, effective_from::text, effective_to::text, basic_kobo::text as basic
     from public.pay_rates where worker_id = $1 order by effective_from`,
    [workerId],
  );
  return rows;
}

const bank = {
  bank_name: "GTBank",
  account_name: "Ada Worker",
  bank_account_enc: `\\x${randomBytes(40).toString("hex")}`,
  bank_account_last4: "7712",
};

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("p-owner", "People Org");
  other = await createTenantUser("p-other", "Other People Org");
  people.admin = await createTestUser("p-admin");
  people.hr = await createTestUser("p-hr");
  people.finance = await createTestUser("p-finance");
  people.ops = await createTestUser("p-ops");
  people.lineManager = await createTestUser("p-line-manager");
  await addMember(people.admin, "admin");
  await addMember(people.hr, "hr");
  await addMember(people.finance, "finance");
  await addMember(people.ops, "ops_manager");

  const dept = await people.hr.client
    .from("departments")
    .insert({ organisation_id: owner.orgId, name: "Security services" })
    .select("id")
    .single();
  expect(dept.error).toBeNull();
  departmentId = dept.data!.id;

  const otherDept = await other.client
    .from("departments")
    .insert({ organisation_id: other.orgId, name: "Other department" })
    .select("id")
    .single();
  otherDepartmentId = otherDept.data!.id;

  const clients = await people.hr.client
    .from("clients")
    .insert([
      { organisation_id: owner.orgId, name: "Coastline Logistics" },
      { organisation_id: owner.orgId, name: "Marina Holdings" },
    ])
    .select("id, name");
  expect(clients.error).toBeNull();
  clientId = clients.data!.find((c) => c.name === "Coastline Logistics")!.id;
  otherClientId = clients.data!.find((c) => c.name === "Marina Holdings")!.id;

  const site = await people.hr.client
    .from("sites")
    .insert({ organisation_id: owner.orgId, client_id: clientId, name: "Apapa Warehouse 3" })
    .select("id")
    .single();
  siteId = site.data!.id;
  const project = await people.hr.client
    .from("projects")
    .insert({ organisation_id: owner.orgId, client_id: clientId, name: "Guarding contract" })
    .select("id")
    .single();
  projectId = project.data!.id;
});

afterAll(async () => {
  await db?.end();
});

describe("pay-rate versioning", () => {
  it("creates a worker with a backdated first version, kobo stored exactly", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    expect(await versions(workerId)).toEqual([
      expect.objectContaining({
        effective_from: "2025-01-06",
        effective_to: null,
        basic: "10500050",
      }),
    ]);
  });

  it("inserts a new version and closes the old one the day before", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    const { error } = await people.hr.client.rpc("add_pay_rate", {
      p_worker_id: workerId,
      p_rate: monthly(IN_30, "12000000"),
    });
    expect(error).toBeNull();
    const rows = await versions(workerId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ effective_from: "2025-01-06", effective_to: lagosDate(29) });
    expect(rows[1]).toMatchObject({ effective_from: IN_30, effective_to: null, basic: "12000000" });
  });

  it("refuses a version that does not start after the latest one", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    expect(
      (
        await people.hr.client.rpc("add_pay_rate", {
          p_worker_id: workerId,
          p_rate: monthly(IN_30),
        })
      ).error,
    ).toBeNull();
    const { error } = await people.hr.client.rpc("add_pay_rate", {
      p_worker_id: workerId,
      p_rate: monthly(IN_30),
    });
    expect(error?.code).toBe("MLPR3");
    expect(await versions(workerId)).toHaveLength(2);
  });

  it("refuses a backdated change once a version exists (past versions are never rewritten)", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    const { error } = await people.hr.client.rpc("add_pay_rate", {
      p_worker_id: workerId,
      p_rate: monthly(YESTERDAY),
    });
    expect(error?.code).toBe("MLPR2");
    expect(await versions(workerId)).toEqual([
      expect.objectContaining({ effective_from: "2025-01-06", effective_to: null }),
    ]);
  });

  it("allows a change from today: the old version ends yesterday", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    const { error } = await people.hr.client.rpc("add_pay_rate", {
      p_worker_id: workerId,
      p_rate: monthly(TODAY, "11000000"),
    });
    expect(error).toBeNull();
    const rows = await versions(workerId);
    expect(rows.map((row) => [row.effective_from, row.effective_to])).toEqual([
      ["2025-01-06", YESTERDAY],
      [TODAY, null],
    ]);
  });

  it("rejects an overlapping version written directly", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    const { error } = await people.hr.client.from("pay_rates").insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      pay_type: "daily",
      daily_rate_kobo: 800_000,
      effective_from: IN_60,
    });
    expect(error?.code).toBe("23P01");
    expect(await versions(workerId)).toHaveLength(1);
  });

  it("rejects an edit to a version in force, even by the owner", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    const [row] = await versions(workerId);
    for (const client of [people.hr.client, owner.client]) {
      const { error } = await client.from("pay_rates").update({ basic_kobo: 1 }).eq("id", row!.id);
      expect(error?.code).toBe("MLPR1");
    }
    const moved = await people.hr.client
      .from("pay_rates")
      .update({ effective_from: "2025-02-01" })
      .eq("id", row!.id);
    expect(moved.error?.code).toBe("MLPR1");
    expect(await versions(workerId)).toEqual([expect.objectContaining({ basic: "10500050" })]);
  });

  it("rejects closing a version in force before yesterday", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    const [row] = await versions(workerId);
    const { error } = await people.hr.client
      .from("pay_rates")
      .update({ effective_to: "2025-06-30" })
      .eq("id", row!.id);
    expect(error?.code).toBe("MLPR1");
    const closed = await people.hr.client
      .from("pay_rates")
      .update({ effective_to: TODAY })
      .eq("id", row!.id);
    expect(closed.error).toBeNull();
    expect(await versions(workerId)).toEqual([
      expect.objectContaining({ effective_from: "2025-01-06", effective_to: TODAY }),
    ]);
  });

  it("lets a scheduled version change, but not into the past", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    await people.hr.client.rpc("add_pay_rate", { p_worker_id: workerId, p_rate: monthly(IN_30) });
    const scheduled = (await versions(workerId))[1]!;
    const edit = await people.hr.client
      .from("pay_rates")
      .update({ basic_kobo: 13_000_000 })
      .eq("id", scheduled.id);
    expect(edit.error).toBeNull();
    const past = await people.hr.client
      .from("pay_rates")
      .update({ effective_from: YESTERDAY })
      .eq("id", scheduled.id);
    expect(past.error?.code).toBe("MLPR2");
  });

  it("blocks the table owner from rewriting or deleting a version in force", async () => {
    const workerId = await mustCreateWorker({}, monthly("2025-01-06"));
    const [row] = await versions(workerId);
    await expect(
      db.query("update public.pay_rates set basic_kobo = 1 where id = $1", [row!.id]),
    ).rejects.toThrow(/already in force/);
    await expect(db.query("delete from public.pay_rates where id = $1", [row!.id])).rejects.toThrow(
      /already in force/,
    );
  });

  it("refuses fractional kobo, amounts for the wrong pay type and deletes", async () => {
    const workerId = await mustCreateWorker();
    const fraction = await people.hr.client.rpc("add_pay_rate", {
      p_worker_id: workerId,
      p_rate: monthly("2025-01-06", "1000.5"),
    });
    expect(fraction.error?.code).toBe("22P02");
    const mixed = await people.hr.client.rpc("add_pay_rate", {
      p_worker_id: workerId,
      p_rate: { ...monthly("2025-01-06"), daily_rate_kobo: "800000" },
    });
    expect(mixed.error?.code).toBe("23514");
    expect(await versions(workerId)).toEqual([]);

    const paid = await mustCreateWorker({}, monthly("2025-01-06"));
    const del = await owner.client.from("pay_rates").delete().eq("worker_id", paid);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    expect(await versions(paid)).toHaveLength(1);
  });

  it("refuses a pay rate before the start date", async () => {
    const { error } = await createWorker({ start_date: "2025-03-01" }, monthly("2025-01-06"));
    expect(error?.code).toBe("22023");
  });
});

describe("workers", () => {
  it("keeps staff IDs unique per company, ignoring case", async () => {
    await mustCreateWorker({ staff_id: "CSL-0412" });
    const { error } = await createWorker({ staff_id: "csl-0412" });
    expect(error?.code).toBe("23505");
    expect(error?.message).toContain("workers_staff_id_key");
    // Another company may use the same ID.
    const elsewhere = await other.client.rpc("create_worker", {
      p_worker: {
        id: randomUUID(),
        organisation_id: other.orgId,
        staff_id: "CSL-0412",
        first_name: "Bola",
        last_name: "Ade",
        employment_type: "casual",
        start_date: "2025-01-06",
      },
    });
    expect(elsewhere.error).toBeNull();
  });

  it("maintains needs_pay_details from bank details and pay", async () => {
    const noPay = await mustCreateWorker(bank);
    const noBank = await mustCreateWorker({}, monthly("2025-01-06"));
    const complete = await mustCreateWorker(bank, monthly("2025-01-06"));
    const { data } = await admin
      .from("workers")
      .select("id, needs_pay_details")
      .in("id", [noPay, noBank, complete]);
    const flag = Object.fromEntries((data ?? []).map((row) => [row.id, row.needs_pay_details]));
    expect(flag).toEqual({ [noPay]: true, [noBank]: true, [complete]: false });

    const later = await people.hr.client.rpc("add_pay_rate", {
      p_worker_id: noPay,
      p_rate: { pay_type: "daily", daily_rate_kobo: "800000", effective_from: "2025-01-06" },
    });
    expect(later.error).toBeNull();
    const { data: after } = await admin
      .from("workers")
      .select("needs_pay_details")
      .eq("id", noPay)
      .single();
    expect(after?.needs_pay_details).toBe(false);
  });

  it("does not let signed-in users write bank details after creation, or the pay flag", async () => {
    const workerId = await mustCreateWorker(bank, monthly("2025-01-06"));
    for (const patch of [
      { bank_name: "Access Bank" },
      { bank_account_last4: "0000" },
      { needs_pay_details: false },
    ]) {
      const { error } = await owner.client.from("workers").update(patch).eq("id", workerId);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("allows one line manager, never yourself, never a loop", async () => {
    const boss = await mustCreateWorker();
    const lead = await mustCreateWorker({ line_manager_worker_id: boss });
    const guard = await mustCreateWorker({ line_manager_worker_id: lead });

    const loop = await people.hr.client
      .from("workers")
      .update({ line_manager_worker_id: guard })
      .eq("id", boss);
    expect(loop.error?.code).toBe("MLLM1");

    const self = await people.hr.client
      .from("workers")
      .update({ line_manager_worker_id: guard })
      .eq("id", guard);
    expect(self.error?.code).toBe("MLLM1");

    const hrMembership = await admin
      .from("memberships")
      .select("id")
      .eq("organisation_id", owner.orgId)
      .eq("user_id", people.hr.id)
      .single();
    const both = await people.hr.client
      .from("workers")
      .update({ line_manager_membership_id: hrMembership.data!.id })
      .eq("id", guard);
    expect(both.error?.code).toBe("23514");

    const switched = await people.hr.client
      .from("workers")
      .update({ line_manager_worker_id: null, line_manager_membership_id: hrMembership.data!.id })
      .eq("id", guard);
    expect(switched.error).toBeNull();
  });

  it("only accepts a manager who is not a worker login as membership line manager", async () => {
    const workerUser = await createTestUser("p-worker-login");
    const workerId = await mustCreateWorker();
    const workerMembership = await addMember(workerUser, "worker", workerId);
    const { error } = await createWorker({ line_manager_membership_id: workerMembership });
    expect(error?.code).toBe("MLLM2");
  });

  it("cannot point at another company's department", async () => {
    const { error } = await createWorker({ department_id: otherDepartmentId });
    expect(error?.code).toBe("23503");
  });

  it("audits which personal data changed, never the values", async () => {
    const nin = `\\x${randomBytes(40).toString("hex")}`;
    const workerId = await mustCreateWorker({ ...bank, nin_enc: nin });
    const changed = await people.hr.client
      .from("workers")
      .update({
        nin_enc: `\\x${randomBytes(40).toString("hex")}`,
        rsa_pin_enc: nin,
        rsa_pin_last4: "4421",
      })
      .eq("id", workerId);
    expect(changed.error).toBeNull();

    const { rows } = await db.query<{
      action: string;
      actor_id: string;
      after: unknown;
      before: unknown;
    }>(
      `select action, actor_id, before, after from public.audit_log
       where entity = 'workers' and entity_id = $1 order by at, action`,
      [workerId],
    );
    const personal = rows.filter((row) => row.action === "workers.personal_data");
    expect(personal.map((row) => row.after)).toEqual([
      {
        changes: [
          { field: "nin", change: "added" },
          { field: "bank_account", change: "added" },
        ],
      },
      {
        changes: [
          { field: "nin", change: "changed" },
          { field: "rsa_pin", change: "added" },
        ],
      },
    ]);
    expect(personal.every((row) => row.actor_id === people.hr.id)).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/_enc"|last4"|\\\\x/);
  });

  it("ends employment and closes open assignments", async () => {
    const workerId = await mustCreateWorker();
    const assignment = await people.hr.client
      .from("worker_assignments")
      .insert({
        organisation_id: owner.orgId,
        worker_id: workerId,
        site_id: siteId,
        effective_from: "2025-01-06",
      })
      .select("client_id")
      .single();
    expect(assignment.error).toBeNull();
    // The client follows from the site.
    expect(assignment.data?.client_id).toBe(clientId);

    const { error } = await people.hr.client.rpc("end_employment", {
      p_worker_id: workerId,
      p_end_date: "2026-10-31",
    });
    expect(error).toBeNull();
    const { data: worker } = await admin
      .from("workers")
      .select("status, end_date")
      .eq("id", workerId)
      .single();
    expect(worker).toEqual({ status: "ended", end_date: "2026-10-31" });
    const { data: rows } = await admin
      .from("worker_assignments")
      .select("effective_to")
      .eq("worker_id", workerId);
    expect(rows).toEqual([{ effective_to: "2026-10-31" }]);

    const again = await people.hr.client.rpc("end_employment", {
      p_worker_id: workerId,
      p_end_date: "2026-11-30",
    });
    expect(again.error?.code).toBe("P0002");
  });

  it("refuses an assignment whose site or project belongs to another client", async () => {
    const workerId = await mustCreateWorker();
    for (const target of [{ site_id: siteId }, { project_id: projectId }]) {
      const { error } = await people.hr.client.from("worker_assignments").insert({
        organisation_id: owner.orgId,
        worker_id: workerId,
        client_id: otherClientId,
        effective_from: "2025-01-06",
        ...target,
      });
      expect(error?.code).toBe("MLAS1");
    }
  });
});

describe("who sees and changes people", () => {
  let reportee: string;
  let notMine: string;
  let viaWorker: string;
  let ownWorker: string;
  let workerUser: TestUser;

  beforeAll(async () => {
    const lineManagerMembership = await addMember(people.lineManager, "line_manager");
    reportee = await mustCreateWorker(
      { line_manager_membership_id: lineManagerMembership, department_id: departmentId },
      monthly("2025-01-06"),
    );
    notMine = await mustCreateWorker({}, monthly("2025-01-06"));

    // A worker who manages others through their worker record, signed in as line_manager.
    const supervisorUser = await createTestUser("p-supervisor");
    const supervisorWorker = await mustCreateWorker();
    await addMember(supervisorUser, "line_manager", supervisorWorker);
    viaWorker = await mustCreateWorker({ line_manager_worker_id: supervisorWorker });
    const supervisorSees = await supervisorUser.client.from("workers").select("id");
    expect((supervisorSees.data ?? []).map((row) => row.id).sort()).toEqual(
      [supervisorWorker, viaWorker].sort(),
    );

    ownWorker = await mustCreateWorker({ department_id: departmentId }, monthly("2025-01-06"));
    workerUser = await createTestUser("p-own-worker");
    await addMember(workerUser, "worker", ownWorker);
    const assigned = await people.hr.client.from("worker_assignments").insert([
      {
        organisation_id: owner.orgId,
        worker_id: ownWorker,
        project_id: projectId,
        effective_from: "2025-01-06",
      },
      {
        organisation_id: owner.orgId,
        worker_id: reportee,
        site_id: siteId,
        effective_from: "2025-01-06",
      },
    ]);
    expect(assigned.error).toBeNull();
  });

  it("finance and operations managers read workers and pay but cannot write", async () => {
    for (const reader of [people.finance, people.ops]) {
      const workers = await reader.client
        .from("workers")
        .select("id")
        .in("id", [reportee, notMine]);
      expect(workers.data).toHaveLength(2);
      const pay = await reader.client.from("pay_rates").select("id").eq("worker_id", reportee);
      expect(pay.data).toHaveLength(1);

      const insert = await createWorker({}, null, reader.client);
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
      const update = await reader.client
        .from("workers")
        .update({ first_name: "Changed" })
        .eq("id", reportee)
        .select();
      expect(update.data).toEqual([]);
      const rate = await reader.client.rpc("add_pay_rate", {
        p_worker_id: reportee,
        p_rate: monthly(IN_60),
      });
      expect(rate.error).not.toBeNull();
    }
  });

  it("an admin can add workers", async () => {
    const { error } = await createWorker({}, null, people.admin.client);
    expect(error).toBeNull();
  });

  it("a line manager reads only their reportees, their mapping, and no pay", async () => {
    const client = people.lineManager.client;
    const workers = await client.from("workers").select("id");
    expect((workers.data ?? []).map((row) => row.id)).toEqual([reportee]);
    const assignments = await client.from("worker_assignments").select("worker_id");
    expect(assignments.data).toEqual([{ worker_id: reportee }]);
    const pay = await client.from("pay_rates").select("id");
    expect(pay.data).toEqual([]);
    const departments = await client.from("departments").select("id");
    expect((departments.data ?? []).length).toBeGreaterThan(0);

    const update = await client
      .from("workers")
      .update({ first_name: "Changed" })
      .eq("id", reportee)
      .select();
    expect(update.data).toEqual([]);
  });

  it("a worker reads only their own row, pay, mapping and its names", async () => {
    const client = workerUser.client;
    const workers = await client.from("workers").select("id");
    expect((workers.data ?? []).map((row) => row.id)).toEqual([ownWorker]);
    const pay = await client.from("pay_rates").select("worker_id");
    expect(pay.data).toEqual([{ worker_id: ownWorker }]);
    const assignments = await client.from("worker_assignments").select("worker_id");
    expect(assignments.data).toEqual([{ worker_id: ownWorker }]);
    const departments = await client.from("departments").select("id");
    expect(departments.data).toEqual([{ id: departmentId }]);
    const projects = await client.from("projects").select("id");
    expect(projects.data).toEqual([{ id: projectId }]);
    const clients = await client.from("clients").select("id");
    expect(clients.data).toEqual([{ id: clientId }]);
    const sites = await client.from("sites").select("id");
    expect(sites.data).toEqual([]);

    const update = await client
      .from("workers")
      .update({ first_name: "Changed" })
      .eq("id", ownWorker)
      .select();
    expect(update.data).toEqual([]);
    const insert = await createWorker({}, null, client);
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
  });
});
