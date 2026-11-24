/**
 * Slice 1.8 people import, against the real database: who may run an import, the upload
 * bucket's rules, personal data kept out of the stored rows, and commit (one transaction,
 * names created once, line managers, pay, assignments, audit, idempotent on re-run).
 * Cross-organisation isolation for these tables lives in isolation.test.ts (tables/imports.ts).
 */
import { randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sweepImportUploads } from "@/server/people/imports/sweep";
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

/**
 * One save_import_check call. By default it is the whole check of a file of `rows.length`
 * rows (one chunk, the last); `final` and `expected` describe one chunk of a larger file.
 */
async function saveRows(
  batchId: string,
  rows: Record<string, Json>[],
  by: Client = people.hr.client,
  { final = true, expected = rows.length }: { final?: boolean; expected?: number } = {},
) {
  return by.rpc("save_import_check", {
    p_organisation_id: owner.orgId,
    p_batch_id: batchId,
    p_check: {
      columns: ["employee_id", "first_name"],
      file_notes: [],
      summary: { rows: expected },
      rows_expected: expected,
    },
    p_rows: rows,
    p_final: final,
  });
}

async function batchState(id: string) {
  const { rows } = await db.query<{
    status: string;
    rows_total: number;
    rows_held: number;
    file_removed_at: Date | null;
  }>(
    "select status, rows_total, rows_held, file_removed_at from public.import_batches where id = $1",
    [id],
  );
  return rows[0];
}

/** How many rows of a batch still hold any encrypted personal data. */
async function rowsWithPersonalData(batchId: string) {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.import_rows
     where batch_id = $1
       and (nin_enc is not null or bank_account_enc is not null or rsa_pin_enc is not null)`,
    [batchId],
  );
  return rows[0]?.n ?? 0;
}

const withPersonalData = () => ({ nin_enc: hex(), bank_account_enc: hex(), rsa_pin_enc: hex() });

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
  it("lets owner and hr create batches (the file carries pay)", async () => {
    for (const by of [owner.client, people.hr.client]) {
      expect((await createBatch(by)).error).toBeNull();
    }
  });

  // Owner decision, 23 Nov 2026: pay for owner, hr and finance only, so admins don't import.
  it("refuses an admin: no batch, no rows, no saved check", async () => {
    const created = await createBatch(people.admin.client);
    expect(created.error?.code).toBe(PERMISSION_DENIED);
    const { id } = await createBatch();
    expect((await saveRows(id, [rowDoc(2)])).error).toBeNull();
    const batches = await people.admin.client.from("import_batches").select("id").eq("id", id);
    expect(batches.data).toEqual([]);
    const rows = await people.admin.client.from("import_rows").select("id, raw, normalised");
    expect(rows.data).toEqual([]);
    const fresh = await createBatch();
    const save = await saveRows(fresh.id, [rowDoc(2)], people.admin.client);
    expect(save.error?.code).toBe(PERMISSION_DENIED);
    expect(await batchState(fresh.id)).toMatchObject({ status: "uploaded", rows_total: 0 });
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
    const ownersBatch = await createBatch(owner.client);
    const notMine = await people.hr.client.storage
      .from("imports")
      .upload(ownersBatch.path, csv(), { contentType: "text/csv" });
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
      // HR's import: bank details wait for a second approver (slice 1.11 keeps that).
      bank_details_saved: 0,
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
        // Pay is set, but the bank details wait for a second approver (slice 1.7).
        needs_pay_details: true,
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

    // The import is not a way round the two-person rule: the bank details became a pending
    // request by the importer, not columns on the worker (slice 1.7).
    const { rows: requests } = await db.query<{
      worker_id: string;
      status: string;
      requested_by: string;
      bank_account_last4: string;
      on_worker: string | null;
    }>(
      `select c.worker_id, c.status, c.requested_by, c.bank_account_last4,
         w.bank_account_last4 as on_worker
       from public.bank_detail_changes c join public.workers w on w.id = c.worker_id
       where c.worker_id = any($1)`,
      [[managerWorker.id, reporteeWorker.id]],
    );
    expect(requests).toEqual([
      {
        worker_id: managerWorker.id,
        status: "pending",
        requested_by: people.hr.id,
        bank_account_last4: "7712",
        on_worker: null,
      },
    ]);

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
        after: {
          created: 2,
          departments: 1,
          clients: 1,
          sites: 1,
          projects: 1,
          bank_details_saved: 0,
        },
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
    const a = rowDoc(2, withPersonalData());
    const held = rowDoc(3, { ...withPersonalData(), status: "held" });
    expect((await saveRows(id, [a, held])).error).toBeNull();
    const commit = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [
        { row_id: a.id, worker: workerDoc(), department: { name: "Frozen" }, line_manager: null },
      ],
    });
    expect(commit.error).toBeNull();

    // The imported row no longer holds personal data (the worker has its own copy); the held
    // row keeps it, to be fixed and imported later.
    const { rows } = await db.query<{ id: string; status: string; enc: number }>(
      `select id, status,
              num_nonnulls(nin_enc, bank_account_enc, rsa_pin_enc)::int as enc
       from public.import_rows where batch_id = $1 order by row_number`,
      [id],
    );
    expect(rows).toEqual([
      { id: a.id, status: "imported", enc: 0 },
      { id: held.id, status: "held", enc: 3 },
    ]);

    // Nobody changes an imported row: not through the API, and not even the table owner.
    const { error } = await people.hr.client
      .from("import_rows")
      .update({ status: "held" })
      .eq("id", a.id);
    expect(error?.code).toBe(PERMISSION_DENIED);
    await expect(
      db.query("update public.import_rows set status = 'held' where id = $1", [a.id]),
    ).rejects.toMatchObject({ code: "MLIM3" });
  });

  it("cancels a checked batch, clears its personal data, and then refuses changes to it", async () => {
    const { id } = await createBatch();
    expect(
      (await saveRows(id, [rowDoc(2, withPersonalData()), rowDoc(3, withPersonalData())])).error,
    ).toBeNull();
    expect(await rowsWithPersonalData(id)).toBe(2);
    const cancel = await people.hr.client.rpc("cancel_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
    });
    expect(cancel.error).toBeNull();
    expect(await rowsWithPersonalData(id)).toBe(0);

    const save = await saveRows(id, [rowDoc(3)]);
    expect(save.error?.code).toBe("MLIM2");
    const commit = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [],
    });
    expect(commit.error?.code).toBe("MLIM2");
    const counts = await people.hr.client
      .from("import_batches")
      .update({ rows_total: 0 })
      .eq("id", id);
    expect(counts.error?.code).toBe("MLIM2");

    // Recording that the upload was removed is the one change a cancelled batch takes, once.
    const removed = await people.hr.client
      .from("import_batches")
      .update({ file_removed_at: new Date().toISOString() })
      .eq("id", id);
    expect(removed.error).toBeNull();
    const again = await people.hr.client
      .from("import_batches")
      .update({ file_removed_at: new Date().toISOString() })
      .eq("id", id);
    expect(again.error?.code).toBe("MLIM2");
  });

  it("lets only owner and hr cancel", async () => {
    const { id } = await createBatch();
    for (const by of [people.admin.client, people.finance.client, people.ops.client, other.client]) {
      const { error } = await by.rpc("cancel_import_batch", {
        p_organisation_id: owner.orgId,
        p_batch_id: id,
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    expect((await batchState(id))?.status).toBe("uploaded");
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

describe("writing import rows", () => {
  it("refuses direct inserts and updates, even for hr", async () => {
    const { id } = await createBatch();
    const a = rowDoc(2);
    expect((await saveRows(id, [a])).error).toBeNull();

    const insert = await people.hr.client.from("import_rows").insert({
      organisation_id: owner.orgId,
      batch_id: id,
      row_number: 3,
      raw: { first_name: "Typed" },
      status: "ready",
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);

    const update = await people.hr.client
      .from("import_rows")
      .update({ status: "imported", imported_at: new Date().toISOString() })
      .eq("id", a.id);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const raw = await people.hr.client
      .from("import_rows")
      .update({ raw: { first_name: "Changed" } })
      .eq("id", a.id);
    expect(raw.error?.code).toBe(PERMISSION_DENIED);

    const { rows } = await db.query<{ status: string; raw: Json }>(
      "select status, raw from public.import_rows where id = $1",
      [a.id],
    );
    expect(rows).toEqual([{ status: "ready", raw: a.raw }]);
  });

  it("lets only owner and hr save a check", async () => {
    const { id } = await createBatch();
    for (const by of [people.admin.client, people.finance.client, people.ops.client, other.client]) {
      const { error } = await saveRows(id, [rowDoc(2)], by);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    expect(await batchState(id)).toMatchObject({ status: "uploaded", rows_total: 0 });
  });
});

describe("a check saved in chunks", () => {
  it("stays uploaded until the last chunk finds every row stored, and a re-run stores them all", async () => {
    const { id } = await createBatch();
    // A file of 4 rows (2 to 5), saved 2 at a time.
    const r2 = rowDoc(2, withPersonalData());
    const r3 = rowDoc(3, withPersonalData());
    const r4 = rowDoc(4, withPersonalData());
    const r5 = rowDoc(5, withPersonalData());
    const chunk = { final: false, expected: 4 };
    const last = { final: true, expected: 4 };

    expect((await saveRows(id, [r2, r3], undefined, chunk)).error).toBeNull();
    expect(await batchState(id)).toMatchObject({ status: "uploaded", rows_total: 2 });

    // The second chunk never arrives whole: a last call that leaves rows missing is refused
    // and rolled back, and the batch is still `uploaded`.
    const short = await saveRows(id, [r4], undefined, last);
    expect(short.error?.code).toBe("MLIM4");
    expect(await batchState(id)).toMatchObject({ status: "uploaded", rows_total: 2 });

    // Nothing can be imported from it meanwhile.
    const commit = await people.hr.client.rpc("commit_import_batch", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_rows: [],
    });
    expect(commit.error?.code).toBe("MLIM2");

    // Checking again from the file rewrites the rows already stored (same ids) and stores the
    // rest; only then is the batch validated.
    expect(
      (await saveRows(id, [r2, { ...r3, status: "held" }], undefined, chunk)).error,
    ).toBeNull();
    expect((await saveRows(id, [r4, r5], undefined, last)).error).toBeNull();
    expect(await batchState(id)).toMatchObject({
      status: "validated",
      rows_total: 4,
      rows_held: 1,
    });
  });

  it("refuses a last chunk that doesn't say how many rows the file has", async () => {
    const { id } = await createBatch();
    const { error } = await people.hr.client.rpc("save_import_check", {
      p_organisation_id: owner.orgId,
      p_batch_id: id,
      p_check: { columns: ["first_name"], file_notes: [] },
      p_rows: [rowDoc(2)],
      p_final: true,
    });
    expect(error?.code).toBe("MLIM4");
    expect(await batchState(id)).toMatchObject({ status: "uploaded", rows_total: 0 });
  });
});

describe("expiry", () => {
  it("is scheduled hourly with pg_cron", async () => {
    const { rows } = await db.query<{ schedule: string; command: string; active: boolean }>(
      "select schedule, command, active from cron.job where jobname = 'expire-import-batches'",
    );
    expect(rows).toEqual([
      { schedule: "17 * * * *", command: "select private.expire_import_batches()", active: true },
    ]);
  });

  it("cancels batches still uploaded after a day and clears their personal data", async () => {
    const stale = await createBatch();
    expect(
      (
        await saveRows(stale.id, [rowDoc(2, withPersonalData())], undefined, {
          final: false,
          expected: 3,
        })
      ).error,
    ).toBeNull();
    const fresh = await createBatch();
    const checked = await createBatch();
    expect((await saveRows(checked.id, [rowDoc(2, withPersonalData())])).error).toBeNull();
    await db.query(
      "update public.import_batches set created_at = now() - interval '25 hours' where id = any($1)",
      [[stale.id, checked.id]],
    );

    const { rows } = await db.query<{ n: number }>("select private.expire_import_batches() as n");
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);

    expect((await batchState(stale.id))?.status).toBe("cancelled");
    expect(await rowsWithPersonalData(stale.id)).toBe(0);
    expect((await batchState(fresh.id))?.status).toBe("uploaded");
    expect((await batchState(checked.id))?.status).toBe("validated");
    expect(await rowsWithPersonalData(checked.id)).toBe(1);
  });

  it("can't be run by signed-in users", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await expect(db.query("select private.expire_import_batches()")).rejects.toMatchObject({
        code: PERMISSION_DENIED,
      });
    } finally {
      await db.query("rollback");
    }
  });
});

describe("upload sweep", () => {
  const csv = () => new Blob(["employee_id,first_name\nAFS-1,Ada\n"], { type: "text/csv" });

  async function uploaded(by: Client = people.hr.client) {
    const batch = await createBatch(by);
    expect(batch.error).toBeNull();
    const { error } = await by.storage
      .from("imports")
      .upload(batch.path, csv(), { contentType: "text/csv" });
    expect(error).toBeNull();
    return batch;
  }

  async function stored(path: string) {
    const { data } = await admin.storage.from("imports").download(path);
    return data !== null;
  }

  it("removes uploads left behind by checked, abandoned and cancelled batches", async () => {
    // Checked, but the server's removal never happened.
    const checked = await uploaded();
    expect((await saveRows(checked.id, [rowDoc(2)])).error).toBeNull();
    // Uploaded two hours ago and never checked (the tab closed).
    const abandoned = await uploaded();
    await db.query(
      "update public.import_batches set created_at = now() - interval '2 hours' where id = $1",
      [abandoned.id],
    );
    // Cancelled by someone who can't read the uploader's file.
    const cancelled = await uploaded();
    expect(
      (
        await owner.client.rpc("cancel_import_batch", {
          p_organisation_id: owner.orgId,
          p_batch_id: cancelled.id,
        })
      ).error,
    ).toBeNull();
    // Being uploaded and checked right now.
    const current = await uploaded();

    const result = await sweepImportUploads(admin);
    expect(result.removed).toBeGreaterThanOrEqual(3);

    for (const batch of [checked, abandoned, cancelled]) {
      expect(await stored(batch.path)).toBe(false);
      expect((await batchState(batch.id))?.file_removed_at).not.toBeNull();
    }
    expect(await stored(current.path)).toBe(true);
    expect((await batchState(current.id))?.file_removed_at).toBeNull();
  });
});
