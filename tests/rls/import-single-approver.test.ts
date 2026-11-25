/**
 * Slice 1.11 (owner decision 20) against the real database: the owner's FIRST
 * commit_import_batch while company setup is unfinished writes new workers' bank details
 * directly, audited per worker. A later import by the owner (even during setup), HR's import
 * during setup, the owner's import after setup, and a direct create_worker call all keep the
 * two-person hold (a pending bank-detail change). An admin can't import at all since the file
 * carries pay (owner decision, 23 Nov 2026).
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

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let hr: TestUser;
let orgAdmin: TestUser;
let counter = 0;

const hex = () => `\\x${randomBytes(40).toString("hex")}`;

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

function workerDoc(bank: "full" | "partial" | "none" = "full"): Record<string, Json> {
  counter += 1;
  const doc: Record<string, Json> = {
    id: randomUUID(),
    staff_id: `ONB-${String(counter).padStart(4, "0")}`,
    first_name: "Ada",
    last_name: `Onboarded ${counter}`,
    phone: null,
    employment_type: "permanent",
    start_date: "2024-03-03",
  };
  if (bank === "full") {
    Object.assign(doc, {
      bank_name: "GTBank",
      account_name: `Ada Onboarded ${counter}`,
      bank_account_enc: hex(),
      bank_account_last4: "7712",
    });
  } else if (bank === "partial") {
    // A bank name without the number: can't become anything, so it's left off.
    Object.assign(doc, { bank_name: "GTBank", account_name: `Ada Onboarded ${counter}` });
  }
  return doc;
}

/** A checked batch of one ready row in `orgId`. */
async function checkedBatch(by: Client, orgId: string) {
  const batchId = randomUUID();
  const created = await by.from("import_batches").insert({
    id: batchId,
    organisation_id: orgId,
    file_name: "employees.csv",
    file_format: "csv",
    file_path: `${orgId}/${batchId}.csv`,
  });
  expect(created.error).toBeNull();
  const rowId = randomUUID();
  const saved = await by.rpc("save_import_check", {
    p_organisation_id: orgId,
    p_batch_id: batchId,
    p_check: {
      columns: ["employee_id", "first_name"],
      file_notes: [],
      summary: { rows: 1 },
      rows_expected: 1,
    },
    p_rows: [
      { id: rowId, row_number: 2, raw: { first_name: "Ada", last_name: "Test" }, status: "ready" },
    ],
    p_final: true,
  });
  expect(saved.error).toBeNull();
  return { batchId, rowId };
}

/** Imports one worker through a checked batch; returns the new worker's id and the result. */
async function importOne(
  by: Client,
  { orgId = owner.orgId, bank = "full" as "full" | "partial" | "none" } = {},
): Promise<{ workerId: string; result: Json; batchId: string }> {
  const { batchId, rowId } = await checkedBatch(by, orgId);
  const worker = workerDoc(bank);
  const { data, error } = await by.rpc("commit_import_batch", {
    p_organisation_id: orgId,
    p_batch_id: batchId,
    p_rows: [
      {
        row_id: rowId,
        worker,
        pay_rate: null,
        department: { name: "Security" },
        line_manager: null,
        client: null,
        site: null,
        project: null,
      },
    ],
  });
  expect(error).toBeNull();
  return { workerId: worker.id as string, result: data, batchId };
}

async function bankState(workerId: string) {
  const { rows } = await db.query<{
    last4: string | null;
    pending: number;
    needs_pay_details: boolean;
  }>(
    `select w.bank_account_last4 as last4, w.needs_pay_details,
       (select count(*)::int from public.bank_detail_changes c
         where c.worker_id = w.id and c.status = 'pending') as pending
     from public.workers w where w.id = $1`,
    [workerId],
  );
  return rows[0];
}

async function exceptionAudits(workerId: string) {
  const { rows } = await db.query<{ actor_id: string; batch: string | null }>(
    "select actor_id, after ->> 'batch_id' as batch from public.audit_log where entity_id = $1 and action = 'people.bank_details_single_approver'",
    [workerId],
  );
  return rows;
}

const held = { last4: null, pending: 1, needs_pay_details: true };

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("onb-owner", "Onboarding Org");
  hr = await createTestUser("onb-hr");
  orgAdmin = await createTestUser("onb-admin");
  await addMember(hr, "hr");
  await addMember(orgAdmin, "admin");
});

afterAll(async () => {
  await db?.end();
});

describe("first import during unfinished setup", () => {
  it("HR's import during setup keeps the two-person hold", async () => {
    const { workerId, result } = await importOne(hr.client);
    expect(result).toMatchObject({ created: 1, bank_details_saved: 0 });
    expect(await bankState(workerId)).toEqual(held);
    expect(await exceptionAudits(workerId)).toEqual([]);
  });

  it("an admin can't import: the file carries pay", async () => {
    const id = randomUUID();
    const { error } = await orgAdmin.client.from("import_batches").insert({
      id,
      organisation_id: owner.orgId,
      file_name: "employees.csv",
      file_format: "csv",
      file_path: `${owner.orgId}/${id}.csv`,
    });
    expect(error?.code).toBe("42501");
  });

  it("the owner's first import saves bank details directly and audits each worker", async () => {
    const { workerId, result, batchId } = await importOne(owner.client);
    expect(result).toMatchObject({ created: 1, bank_details_saved: 1 });
    // Bank details on file; still no pay rate, so still flagged before payroll.
    expect(await bankState(workerId)).toEqual({
      last4: "7712",
      pending: 0,
      needs_pay_details: true,
    });
    expect(await exceptionAudits(workerId)).toEqual([{ actor_id: owner.id, batch: batchId }]);
    // The personal-data audit names the field, never the number.
    const { rows } = await db.query<{ doc: string }>(
      "select coalesce(before::text, '') || coalesce(after::text, '') as doc from public.audit_log where entity_id = $1",
      [workerId],
    );
    // Ids in the rows are uuids, which hold "7712" by chance now and then: take them out first
    // (as payouts.test.ts does), so the check still catches the account's last 4 anywhere else
    // in the audit rows (slice 5.10: the known flake, fixed without weakening the check).
    expect(
      rows
        .map((r) => r.doc)
        .join(" ")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ""),
    ).not.toContain("7712");
  });

  it("a later import by the owner, even during setup, keeps the hold", async () => {
    const { workerId, result } = await importOne(owner.client);
    expect(result).toMatchObject({ created: 1, bank_details_saved: 0 });
    expect(await bankState(workerId)).toEqual(held);
    expect(await exceptionAudits(workerId)).toEqual([]);
  });

  it("a direct create_worker call by the owner can't bring unchecked bank details", async () => {
    // Slice 2.3b: outside the import, bank details need the bank's account name check.
    const worker = workerDoc();
    const { error } = await owner.client.rpc("create_worker", {
      p_worker: { ...worker, organisation_id: owner.orgId },
    });
    expect(error?.code).toBe("MLBL7");
  });

  it("after setup is finished, the owner's import keeps the hold too", async () => {
    const fresh = await createTenantUser("onb-owner-2", "Onboarding Org Two");
    const done = await fresh.client.rpc("complete_company_setup", {
      p_organisation_id: fresh.orgId,
    });
    expect(done.error).toBeNull();
    const { workerId, result } = await importOne(fresh.client, { orgId: fresh.orgId });
    expect(result).toMatchObject({ created: 1, bank_details_saved: 0 });
    expect(await bankState(workerId)).toEqual(held);
    expect(await exceptionAudits(workerId)).toEqual([]);
  });
});

describe("the single-approver helper", () => {
  it("leaves incomplete bank details off, as every import does", async () => {
    const fresh = await createTenantUser("onb-owner-3", "Onboarding Org Three");
    const { workerId, result } = await importOne(fresh.client, {
      orgId: fresh.orgId,
      bank: "partial",
    });
    expect(result).toMatchObject({ created: 1, bank_details_saved: 0 });
    expect(await bankState(workerId)).toEqual({ last4: null, pending: 0, needs_pay_details: true });
  });

  it("can't put bank details on a worker this import didn't just create", async () => {
    // A fresh company whose owner has not used the exception, so only the worker guard stands.
    const fresh = await createTenantUser("onb-owner-4", "Onboarding Org Four");
    const existing = await importOne(fresh.client, { orgId: fresh.orgId, bank: "none" });
    const { batchId } = await checkedBatch(fresh.client, fresh.orgId);
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [fresh.id]);
      await expect(
        db.query(
          "select private.import_bank_details_single_approver($1, $2, $3, 'GTBank', 'X', '\\x00'::bytea, '0000')",
          [fresh.orgId, batchId, existing.workerId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
    }
    expect(await bankState(existing.workerId)).toMatchObject({ last4: null });
  });
});
