/**
 * Slice 1.8 people import, against the real database: who may run an import, the upload
 * bucket's rules, personal data kept out of the stored rows, and commit (one transaction,
 * names created once, line managers, pay, assignments, audit, idempotent on re-run).
 * Cross-organisation isolation for these tables lives in isolation.test.ts (tables/imports.ts).
 */
import { randomBytes, randomUUID } from "node:crypto";

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
const CHECK_VIOLATION = "23514";

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const people = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager", TestUser>;

async function addMember(user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

const hex = (bytes = 40) => `\\x${randomBytes(bytes).toString("hex")}`;

/** A batch created by `by` (hr unless said otherwise), in `orgId`. */
async function createBatch(by: Client = people.hr.client, orgId = owner.orgId) {
  const id = randomUUID();
  const path = `${orgId}/${id}.csv`;
  const { error } = await by.from("import_batches").insert({
    id,
    organisation_id: orgId,
    file_name: "employees.csv",
    file_format: "csv",
    file_path: path,
  });
  return { id, path, error };
}

function rowDoc(rowNumber: number, fields: Record<string, Json> = {}) {
  return {
    id: randomUUID(),
    row_number: rowNumber,
    raw: { first_name: `Worker ${rowNumber}`, last_name: "Test" },
    status: "ready",
    ...fields,
  };
}

async function saveRows(
  batchId: string,
  rows: Record<string, Json>[],
  by: Client = people.hr.client,
) {
  return by.rpc("save_import_check", {
    p_organisation_id: owner.orgId,
    p_batch_id: batchId,
    p_check: {
      columns: ["employee_id", "first_name"],
      file_notes: [],
      summary: { rows: rows.length },
    },
    p_rows: rows,
  });
}

let staffCounter = 0;
function workerDoc(fields: Record<string, Json> = {}) {
  staffCounter += 1;
  return {
    id: randomUUID(),
    staff_id: `IMP-${String(staffCounter).padStart(4, "0")}`,
    first_name: "Ada",
    last_name: `Imported ${staffCounter}`,
    phone: null,
    employment_type: "permanent",
    start_date: "2024-03-03",
    ...fields,
  };
}

const monthly = {
  pay_type: "monthly",
  basic_kobo: "10500050",
  housing_kobo: "6300000",
  transport_kobo: "4200000",
  other_allowances_kobo: "0",
  effective_from: "2024-03-03",
};

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("imp-owner", "Import Org");
  other = await createTenantUser("imp-other", "Other Import Org");
  people.admin = await createTestUser("imp-admin");
  people.hr = await createTestUser("imp-hr");
  people.finance = await createTestUser("imp-finance");
  people.ops = await createTestUser("imp-ops");
  people.lineManager = await createTestUser("imp-line-manager", "Lola Manager");
  await addMember(people.admin, "admin");
  await addMember(people.hr, "hr");
  await addMember(people.finance, "finance");
  await addMember(people.ops, "ops_manager");
  await addMember(people.lineManager, "line_manager");
});

afterAll(async () => {
  await db?.end();
});

describe("who runs an import", () => {
  it("lets owner, admin and hr create batches", async () => {
    for (const by of [owner.client, people.admin.client, people.hr.client]) {
      expect((await createBatch(by)).error).toBeNull();
    }
  });

  it("refuses finance, ops managers and line managers", async () => {
    for (const by of [people.finance.client, people.ops.client, people.lineManager.client]) {
      const { error } = await createBatch(by);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    const { id } = await createBatch();
    for (const by of [people.finance.client, people.ops.client, people.lineManager.client]) {
      const { data } = await by.from("import_batches").select("id").eq("id", id);
      expect(data).toEqual([]);
      const save = await saveRows(id, [rowDoc(2)], by);
      expect(save.error).not.toBeNull();
      const commit = await by.rpc("commit_import_batch", {
        p_organisation_id: owner.orgId,
        p_batch_id: id,
        p_rows: [],
      });
      expect(commit.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("fixes the upload path to the batch", async () => {
    const id = randomUUID();
    const { error } = await people.hr.client.from("import_batches").insert({
      id,
      organisation_id: owner.orgId,
      file_name: "employees.csv",
      file_format: "csv",
      file_path: `${other.orgId}/${id}.csv`,
    });
    expect(error?.code).toBe(CHECK_VIOLATION);
  });

  it("lists manager emails for line-manager matching to owner, admin and hr only", async () => {
    const { data, error } = await people.hr.client.rpc("list_import_managers", {
      p_organisation_id: owner.orgId,
    });
    expect(error).toBeNull();
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: people.lineManager.email.toLowerCase(),
          full_name: "Lola Manager",
        }),
      ]),
    );
    const refused = await people.finance.client.rpc("list_import_managers", {
      p_organisation_id: owner.orgId,
    });
    expect(refused.data).toEqual([]);
    const otherOrg = await other.client.rpc("list_import_managers", {
      p_organisation_id: owner.orgId,
    });
    expect(otherOrg.data).toEqual([]);
  });
});

describe("personal data in stored rows", () => {
  it("refuses NIN, bank account number or RSA PIN in raw or normalised", async () => {
    const { id } = await createBatch();
    for (const raw of [
      { nin: "70000104734" },
      { bank_account_number: "2000009153" },
      { rsa_pin: "PEN1" },
    ]) {
      const { error } = await saveRows(id, [rowDoc(2, { raw })]);
      expect(error?.code).toBe(CHECK_VIOLATION);
    }
    const { error } = await saveRows(id, [
      rowDoc(2, { normalised: { worker: { bankAccountNumber: "2000009153" } } }),
    ]);
    expect(error?.code).toBe(CHECK_VIOLATION);
  });

  it("stores the encrypted columns and refreshes the batch counts", async () => {
    const { id } = await createBatch();
    const { error } = await saveRows(id, [
      rowDoc(2, { nin_enc: hex(), bank_account_enc: hex() }),
      rowDoc(3, {
        status: "held",
        errors: [{ message: "Phone is not a Nigerian mobile number." }],
      }),
      rowDoc(4, { status: "fixed" }),
    ]);
    expect(error).toBeNull();
    const { data } = await people.hr.client
      .from("import_batches")
      .select("status, rows_total, rows_ready, rows_held, rows_imported")
      .eq("id", id)
      .single();
    expect(data).toEqual({
      status: "validated",
      rows_total: 3,
      rows_ready: 2,
      rows_held: 1,
      rows_imported: 0,
    });
  });

  it("never rewrites a row under another id", async () => {
    const { id } = await createBatch();
    const first = rowDoc(2, { nin_enc: hex() });
    expect((await saveRows(id, [first])).error).toBeNull();
    expect((await saveRows(id, [{ ...first, id: randomUUID(), status: "held" }])).error).toBeNull();
    const { rows } = await db.query<{ id: string; status: string }>(
      "select id, status from public.import_rows where batch_id = $1",
      [id],
    );
    expect(rows).toEqual([{ id: first.id, status: "ready" }]);
  });
});

describe("upload bucket", () => {
  const csv = () => new Blob(["employee_id,first_name\nAFS-1,Ada\n"], { type: "text/csv" });

  it("takes an upload only at the path of an uploaded batch its creator made", async () => {
    const batch = await createBatch();
    const upload = await people.hr.client.storage.from("imports").upload(batch.path, csv(), {
      contentType: "text/csv",
    });
    expect(upload.error).toBeNull();

    // No batch at this path.
    const stray = await people.hr.client.storage
      .from("imports")
      .upload(`${owner.orgId}/${randomUUID()}.csv`, csv(), { contentType: "text/csv" });
    expect(stray.error).not.toBeNull();

    // Someone else's batch, and another organisation's batch.
    const adminsBatch = await createBatch(people.admin.client);
    const notMine = await people.hr.client.storage
      .from("imports")
      .upload(adminsBatch.path, csv(), { contentType: "text/csv" });
    expect(notMine.error).not.toBeNull();
    const otherBatch = await createBatch(other.client, other.orgId);
    expect(otherBatch.error).toBeNull();
    const cross = await people.hr.client.storage
      .from("imports")
      .upload(otherBatch.path, csv(), { contentType: "text/csv" });
    expect(cross.error).not.toBeNull();

    // An upload is never replaced.
    const again = await people.hr.client.storage
      .from("imports")
      .upload(batch.path, csv(), { contentType: "text/csv", upsert: true });
    expect(again.error).not.toBeNull();
  });

  it("lets only the uploader read the file back", async () => {
    const batch = await createBatch();
    expect(
      (
        await people.hr.client.storage
          .from("imports")
          .upload(batch.path, csv(), { contentType: "text/csv" })
      ).error,
    ).toBeNull();
    const mine = await people.hr.client.storage.from("imports").download(batch.path);
    expect(mine.error).toBeNull();
    expect(await mine.data?.text()).toContain("AFS-1");

    for (const by of [people.admin.client, owner.client, other.client, people.finance.client]) {
      const theirs = await by.storage.from("imports").download(batch.path);
      expect(theirs.data).toBeNull();
    }
  });

  it("refuses an upload once the batch has been checked", async () => {
    const batch = await createBatch();
    expect((await saveRows(batch.id, [rowDoc(2)])).error).toBeNull();
    const late = await people.hr.client.storage
      .from("imports")
      .upload(batch.path, csv(), { contentType: "text/csv" });
    expect(late.error).not.toBeNull();
  });
});

describe("commit", () => {
  async function departmentNamed(name: string) {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.departments where organisation_id = $1 and lower(name) = lower($2)",
      [owner.orgId, name],
    );
    return rows;
  }

  it("creates names, workers, pay and assignments in one go, and does nothing on a re-run", async () => {
    const { id } = await createBatch();
    const manager = rowDoc(2);
    const reportee = rowDoc(3, { attention: true });
    const held = rowDoc(4, { status: "held" });
    expect((await saveRows(id, [manager, reportee, held])).error).toBeNull();

    const managerWorker = workerDoc({
      bank_name: "GTBank",
      account_name: "Ada Imported",
      bank_account_enc: hex(),
      bank_account_last4: "7712",
    });
    const reporteeWorker = workerDoc({ phone: "08031234567", supervisor_clock_in: true });
    const payload = [
      {
        row_id: manager.id,
        worker: managerWorker,
        pay_rate: monthly,
        department: { name: "Security Services" },
        line_manager: null,
        client: { name: "Coastline Logistics" },
        site: { name: "Apapa Warehouse 3" },
        project: { name: "Coastline guarding contract" },
      },
      {
        row_id: reportee.id,
        worker: reporteeWorker,
        pay_rate: null,
        department: { name: "security services" },
        line_manager: { worker_id: managerWorker.id },
        client: { name: "coastline logistics" },
        site: { name: "Apapa Warehouse 3" },
        project: null,
      },
    ];

    const { data, error } = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: payload,
    });
    expect(error).toBeNull();
    expect(data).toEqual({
      created: 2,
      already_imported: 0,
      departments: 1,
      clients: 1,
      sites: 1,
      projects: 1,
    });

    expect(await departmentNamed("Security Services")).toHaveLength(1);
    const { rows: workers } = await db.query<{
      id: string;
      line_manager_worker_id: string | null;
      needs_pay_details: boolean;
      supervisor_clock_in: boolean;
      department_id: string;
    }>(
      `select id, line_manager_worker_id, needs_pay_details, supervisor_clock_in, department_id
       from public.workers where id = any($1) order by staff_id`,
      [[managerWorker.id, reporteeWorker.id]],
    );
    expect(workers).toEqual([
      expect.objectContaining({
        id: managerWorker.id,
        line_manager_worker_id: null,
        needs_pay_details: false,
        supervisor_clock_in: false,
      }),
      expect.objectContaining({
        id: reporteeWorker.id,
        line_manager_worker_id: managerWorker.id,
        // No bank details and no pay rate: payroll won't pay this worker yet.
        needs_pay_details: true,
        supervisor_clock_in: true,
      }),
    ]);
    expect(workers[0]?.department_id).toBe(workers[1]?.department_id);

    const { rows: assignments } = await db.query<{
      worker_id: string;
      site: string;
      project: string | null;
      effective_from: string;
    }>(
      `select a.worker_id, s.name as site, p.name as project, a.effective_from::text
       from public.worker_assignments a
       join public.sites s on s.id = a.site_id
       left join public.projects p on p.id = a.project_id
       where a.worker_id = any($1) order by a.worker_id = $2 desc`,
      [[managerWorker.id, reporteeWorker.id], managerWorker.id],
    );
    expect(assignments).toEqual([
      {
        worker_id: managerWorker.id,
        site: "Apapa Warehouse 3",
        project: "Coastline guarding contract",
        effective_from: "2024-03-03",
      },
      {
        worker_id: reporteeWorker.id,
        site: "Apapa Warehouse 3",
        project: null,
        effective_from: "2024-03-03",
      },
    ]);

    const { rows: rates } = await db.query<{ basic: string }>(
      "select basic_kobo::text as basic from public.pay_rates where worker_id = $1",
      [managerWorker.id],
    );
    expect(rates).toEqual([{ basic: "10500050" }]);

    const { rows: importRows } = await db.query<{
      row_number: number;
      status: string;
      worker_id: string | null;
    }>(
      "select row_number, status, worker_id from public.import_rows where batch_id = $1 order by row_number",
      [id],
    );
    expect(importRows).toEqual([
      { row_number: 2, status: "imported", worker_id: managerWorker.id },
      { row_number: 3, status: "imported", worker_id: reporteeWorker.id },
      { row_number: 4, status: "held", worker_id: null },
    ]);
    const { data: batch } = await people.hr.client
      .from("import_batches")
      .select("status, rows_imported, rows_held, committed_at")
      .eq("id", id)
      .single();
    expect(batch).toMatchObject({ status: "committed", rows_imported: 2, rows_held: 1 });
    expect(batch?.committed_at).not.toBeNull();

    // Audit: one event for the batch, one row per created worker, nothing in clear.
    const { rows: events } = await db.query<{ action: string; after: Record<string, unknown> }>(
      `select action, after from public.audit_log
       where organisation_id = $1 and (entity_id = $2 or entity_id = any($3))`,
      [owner.orgId, id, [managerWorker.id, reporteeWorker.id]],
    );
    expect(events.filter((e) => e.action === "people.import_committed")).toEqual([
      expect.objectContaining({
        after: { created: 2, departments: 1, clients: 1, sites: 1, projects: 1 },
      }),
    ]);
    expect(events.filter((e) => e.action === "workers.insert")).toHaveLength(2);
    for (const event of events) {
      expect(JSON.stringify(event.after ?? {})).not.toContain("bank_account_enc");
    }

    // The same payload again (a double submit): nothing happens.
    const rerun = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: payload,
    });
    expect(rerun.error).toBeNull();
    expect(rerun.data).toMatchObject({ created: 0, already_imported: 2 });
    const { rows: count } = await db.query<{ n: string }>(
      "select count(*)::text as n from public.workers where id = any($1)",
      [[managerWorker.id, reporteeWorker.id]],
    );
    expect(count).toEqual([{ n: "2" }]);
  });

  it("refuses a payload that is partly imported already, and held rows", async () => {
    const { id } = await createBatch();
    const a = rowDoc(2);
    const b = rowDoc(3);
    const held = rowDoc(4, { status: "held" });
    expect((await saveRows(id, [a, b, held])).error).toBeNull();
    const item = (rowId: string) => ({
      row_id: rowId,
      worker: workerDoc(),
      pay_rate: null,
      department: { name: "Cleaning services" },
      line_manager: null,
      client: null,
      site: null,
      project: null,
    });
    const first = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [item(a.id)],
    });
    expect(first.error).toBeNull();
    const mixed = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [item(a.id), item(b.id)],
    });
    expect(mixed.error?.code).toBe("MLIM1");
    const heldCommit = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [item(held.id)],
    });
    expect(heldCommit.error?.code).toBe("MLIM1");
    // Nothing from the refused calls landed.
    const { rows } = await db.query<{ status: string }>(
      "select status from public.import_rows where batch_id = $1 order by row_number",
      [id],
    );
    expect(rows.map((r) => r.status)).toEqual(["imported", "ready", "held"]);
  });

  it("rolls the whole commit back when one worker fails", async () => {
    const { id } = await createBatch();
    const a = rowDoc(2);
    const b = rowDoc(3);
    expect((await saveRows(id, [a, b])).error).toBeNull();
    const taken = workerDoc();
    const { error } = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [
        { row_id: a.id, worker: taken, department: { name: "Rollback dept" }, line_manager: null },
        // Same staff ID as the first: the unique index refuses it.
        {
          row_id: b.id,
          worker: { ...workerDoc(), staff_id: taken.staff_id },
          department: { name: "Rollback dept" },
          line_manager: null,
        },
      ],
    });
    expect(error?.code).toBe("23505");
    expect(await departmentNamed("Rollback dept")).toEqual([]);
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text as n from public.workers where id = $1",
      [taken.id],
    );
    expect(rows).toEqual([{ n: "0" }]);
  });

  it("keeps workers in the batch's organisation whatever the payload says", async () => {
    const { id } = await createBatch();
    const a = rowDoc(2);
    expect((await saveRows(id, [a])).error).toBeNull();
    const worker = workerDoc({ organisation_id: other.orgId });
    const { error } = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [{ row_id: a.id, worker, department: { name: "Org check" }, line_manager: null }],
    });
    expect(error).toBeNull();
    const { rows } = await db.query<{ organisation_id: string }>(
      "select organisation_id from public.workers where id = $1",
      [worker.id],
    );
    expect(rows).toEqual([{ organisation_id: owner.orgId }]);
  });

  it("refuses another organisation's batch", async () => {
    const { id } = await createBatch();
    const { error } = await other.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [],
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
    const wrongOrg = await other.client.rpc("commit_import_batch", {
      p_organisation_id: other.orgId,
      p_batch_id: id,
      p_rows: [],
    });
    expect(wrongOrg.error?.code).toBe("P0002");
  });
});

describe("batch lifecycle", () => {
  it("freezes imported rows", async () => {
    const { id } = await createBatch();
    const a = rowDoc(2);
    expect((await saveRows(id, [a])).error).toBeNull();
    const commit = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [
        { row_id: a.id, worker: workerDoc(), department: { name: "Frozen" }, line_manager: null },
      ],
    });
    expect(commit.error).toBeNull();
    const { error } = await people.hr.client
      .from("import_rows")
      .update({ status: "held" })
      .eq("id", a.id);
    expect(error?.code).toBe("MLIM3");
  });

  it("cancels a checked batch, and then refuses changes to it", async () => {
    const { id } = await createBatch();
    expect((await saveRows(id, [rowDoc(2)])).error).toBeNull();
    const cancel = await people.hr.client.rpc("cancel_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
    });
    expect(cancel.error).toBeNull();
    const save = await saveRows(id, [rowDoc(3)]);
    expect(save.error?.code).toBe("MLIM2");
    const commit = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [],
    });
    expect(commit.error?.code).toBe("MLIM2");
  });

  it("won't cancel a batch that has employees in it", async () => {
    const { id } = await createBatch();
    const a = rowDoc(2);
    expect((await saveRows(id, [a])).error).toBeNull();
    expect(
      (
        await people.hr.client.rpc("commit_import_batch", {
          p_organisation_id: owner.orgId,
          p_batch_id: id,
          p_rows: [
            { row_id: a.id, worker: workerDoc(), department: { name: "Kept" }, line_manager: null },
          ],
        })
      ).error,
    ).toBeNull();
    const cancel = await people.hr.client.rpc("cancel_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
    });
    expect(cancel.error?.code).toBe("P0002");
    const direct = await people.hr.client
      .from("import_batches")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", id);
    expect(direct.error?.code).toBe("MLIM2");
  });
});
