/**
 * Slice 1.11 (owner decision 20) against the real database: the owner's commit_import_batch
 * while company setup is unfinished writes new workers' bank details directly, audited per
 * worker. HR's import during setup, the owner's import after setup, and a direct create_worker
 * call all keep the two-person hold (a pending bank-detail change).
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
let counter = 0;

const hex = () => `\\x${randomBytes(40).toString("hex")}`;

async function addMember(user: TestUser, role: Role) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

function workerDoc(): Record<string, Json> {
  counter += 1;
  return {
    id: randomUUID(),
    staff_id: `ONB-${String(counter).padStart(4, "0")}`,
    first_name: "Ada",
    last_name: `Onboarded ${counter}`,
    phone: null,
    employment_type: "permanent",
    start_date: "2024-03-03",
    bank_name: "GTBank",
    account_name: `Ada Onboarded ${counter}`,
    bank_account_enc: hex(),
    bank_account_last4: "7712",
  };
}

/** A checked batch of one ready row, committed by `by`; returns the new worker's id. */
async function importOne(by: Client): Promise<{ workerId: string; result: Json }> {
  const batchId = randomUUID();
  const created = await by.from("import_batches").insert({
    id: batchId,
    organisation_id: owner.orgId,
    file_name: "employees.csv",
    file_format: "csv",
    file_path: `${owner.orgId}/${batchId}.csv`,
  });
  expect(created.error).toBeNull();
  const rowId = randomUUID();
  const saved = await by.rpc("save_import_check", {
    p_organisation_id: owner.orgId,
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
  const worker = workerDoc();
  const { data, error } = await by.rpc("commit_import_batch", {
    p_organisation_id: owner.orgId,
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
  return { workerId: worker.id as string, result: data };
}

async function bankState(workerId: string) {
  const { rows } = await db.query<{ last4: string | null; pending: number }>(
    `select w.bank_account_last4 as last4,
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

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("onb-owner", "Onboarding Org");
  hr = await createTestUser("onb-hr");
  await addMember(hr, "hr");
});

afterAll(async () => {
  await db?.end();
});

describe("first import during unfinished setup", () => {
  it("the owner's import saves bank details directly and audits each worker", async () => {
    const { workerId, result } = await importOne(owner.client);
    expect(result).toMatchObject({ created: 1, bank_details_saved: 1 });
    expect(await bankState(workerId)).toEqual({ last4: "7712", pending: 0 });
    const audits = await exceptionAudits(workerId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBe(owner.id);
    // The personal-data audit names the field, never the number.
    const { rows } = await db.query<{ doc: string }>(
      "select coalesce(before::text, '') || coalesce(after::text, '') as doc from public.audit_log where entity_id = $1",
      [workerId],
    );
    expect(rows.map((r) => r.doc).join(" ")).not.toContain("7712");
  });

  it("HR's import during setup keeps the two-person hold", async () => {
    const { workerId, result } = await importOne(hr.client);
    expect(result).toMatchObject({ created: 1, bank_details_saved: 0 });
    expect(await bankState(workerId)).toEqual({ last4: null, pending: 1 });
    expect(await exceptionAudits(workerId)).toEqual([]);
  });

  it("a direct create_worker call by the owner keeps the hold", async () => {
    const worker = workerDoc();
    const { error } = await owner.client.rpc("create_worker", {
      p_worker: { ...worker, organisation_id: owner.orgId },
    });
    expect(error).toBeNull();
    expect(await bankState(worker.id as string)).toEqual({ last4: null, pending: 1 });
  });

  it("the helper can't put bank details on an existing worker", async () => {
    const { workerId } = await importOne(hr.client);
    await expect(
      db.query(
        `select set_config('request.jwt.claim.sub', '${owner.id}', false);
         select private.import_bank_details_single_approver(
           '${owner.orgId}', gen_random_uuid(), '${workerId}', 'GTBank', 'X', '\\x00'::bytea, '0000')`,
      ),
    ).rejects.toThrow();
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  });

  it("after setup is finished, the owner's import keeps the hold too", async () => {
    const done = await owner.client.rpc("complete_company_setup", {
      p_organisation_id: owner.orgId,
    });
    expect(done.error).toBeNull();
    const { workerId, result } = await importOne(owner.client);
    expect(result).toMatchObject({ created: 1, bank_details_saved: 0 });
    expect(await bankState(workerId)).toEqual({ last4: null, pending: 1 });
    expect(await exceptionAudits(workerId)).toEqual([]);
  });
});
