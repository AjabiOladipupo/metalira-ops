/**
 * Slice 1.7 against the real database: bank-detail changes need a second approver (CLAUDE.md
 * rule 10), wait 72 hours after approval (owner decision 9), and only then change
 * workers.bank_*. The requester can't approve their own request, whatever client they use:
 * the trigger refuses it and the check constraint refuses it even for the table owner.
 * Cross-organisation isolation for the table lives in isolation.test.ts (tables/people_bank.ts).
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
import { makeLookup } from "./helpers/bank-lookup";

type Role = Database["public"]["Enums"]["membership_role"];

const PERMISSION_DENIED = "42501";
const HOUR = 3_600_000;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
const people = {} as Record<
  "admin" | "hr" | "hr2" | "finance" | "ops" | "worker" | "hrWorker",
  TestUser
>;
/** The worker record linked to people.worker's login, and the one linked to people.hrWorker. */
let ownWorkerId: string;
let hrWorkerRecordId: string;

const enc = () => `\\x${randomBytes(48).toString("hex")}`;

async function addMember(user: TestUser, role: Role, workerId: string | null = null) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: owner.orgId, user_id: user.id, role, worker_id: workerId });
  expect(error).toBeNull();
}

let staffCounter = 0;

/** A worker with bank details already on file (written with the secret key, as after an applied change). */
async function addWorker(org = owner.orgId, extra: Record<string, unknown> = {}): Promise<string> {
  staffCounter += 1;
  const id = randomUUID();
  const { error } = await admin.from("workers").insert({
    id,
    organisation_id: org,
    staff_id: `BK-${String(staffCounter).padStart(4, "0")}`,
    first_name: "Musa",
    last_name: `Ibrahim ${staffCounter}`,
    employment_type: "permanent",
    start_date: "2025-01-06",
    bank_name: "Access Bank",
    account_name: "Musa Ibrahim",
    bank_account_enc: enc(),
    bank_account_last4: "1234",
    ...extra,
  });
  expect(error).toBeNull();
  return id;
}

/**
 * Raises a change as `by`, checked with a lookup the server made for them (slice 2.3b). A caller
 * the lookup refuses raises without one, so the request itself is what the database refuses.
 */
async function request(workerId: string, by: Client = people.hr.client, last4 = "7712") {
  const { data: who } = await by.auth.getUser();
  const lookup = await makeLookup(admin, {
    orgId: owner.orgId,
    userId: who.user!.id,
    purpose: "worker_bank",
    workerId,
    last4,
    accountName: "MUSA IBRAHIM",
  }).catch(() => null);
  return by
    .from("bank_detail_changes")
    .insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      bank_name: "GTBank",
      account_name: "Musa Ibrahim",
      bank_account_enc: enc(),
      bank_account_last4: last4,
      reason: "Moved banks",
      ...(lookup
        ? {
            bank_code: lookup.bankCode,
            bank_lookup_id: lookup.id,
            bank_account_digest: lookup.digest,
            name_check: "match" as const,
          }
        : {}),
    })
    .select("*")
    .single();
}

async function mustRequest(workerId: string, by: Client = people.hr.client, last4 = "7712") {
  const { data, error } = await request(workerId, by, last4);
  expect(error).toBeNull();
  return data!;
}

function decide(
  id: string,
  status: Database["public"]["Enums"]["bank_detail_change_status"],
  by: Client,
  note: string | null = null,
) {
  return by
    .from("bank_detail_changes")
    .update({ status, decision_note: note })
    .eq("id", id)
    .select("*");
}

async function changeRow(id: string) {
  const { rows } = await db.query<{
    status: string;
    requested_by: string;
    approved_by: string | null;
    rejected_by: string | null;
    decided_at: Date | null;
    applies_after: Date | null;
    applied_at: Date | null;
    previous_bank_account_last4: string | null;
  }>(
    `select status, requested_by, approved_by, rejected_by, decided_at, applies_after, applied_at,
       previous_bank_account_last4
     from public.bank_detail_changes where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function workerBank(id: string) {
  const { rows } = await db.query<{
    bank_name: string | null;
    bank_account_last4: string | null;
    bank_account_enc: string | null;
    needs_pay_details: boolean;
  }>(
    `select bank_name, bank_account_last4, encode(bank_account_enc, 'hex') as bank_account_enc,
       needs_pay_details
     from public.workers where id = $1`,
    [id],
  );
  return rows[0]!;
}

/**
 * Moves an approved change's hold into the past, as if 72 hours had gone by. Only the guard
 * trigger is switched off, inside one transaction, so the audit and apply triggers still run
 * later and nothing else sees the switch.
 */
async function endHold(id: string) {
  await db.query("begin");
  try {
    await db.query(
      "alter table public.bank_detail_changes disable trigger bank_detail_changes_before_update",
    );
    await db.query(
      `update public.bank_detail_changes
       set decided_at = now() - interval '73 hours', applies_after = now() - interval '1 hour'
       where id = $1 and status = 'approved'`,
      [id],
    );
    await db.query(
      "alter table public.bank_detail_changes enable trigger bank_detail_changes_before_update",
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

function applyDue(by: Client = people.hr.client, org = owner.orgId) {
  return by.rpc("apply_due_bank_detail_changes", { p_organisation_id: org });
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("bk-owner", "Bank Org");
  other = await createTenantUser("bk-other", "Other Bank Org");
  for (const key of ["admin", "hr", "hr2", "finance", "ops", "worker", "hrWorker"] as const) {
    people[key] = await createTestUser(`bk-${key}`);
  }
  ownWorkerId = await addWorker();
  hrWorkerRecordId = await addWorker();
  await addMember(people.admin, "admin");
  await addMember(people.hr, "hr");
  await addMember(people.hr2, "hr");
  await addMember(people.finance, "finance");
  await addMember(people.ops, "ops_manager");
  await addMember(people.worker, "worker", ownWorkerId);
  // An HR user who is also on the payroll.
  await addMember(people.hrWorker, "hr", hrWorkerRecordId);
});

afterAll(async () => {
  await db?.end();
});

describe("raising a request", () => {
  it("records the caller as requester and leaves the worker's bank details alone", async () => {
    const workerId = await addWorker();
    const before = await workerBank(workerId);
    const change = await mustRequest(workerId);
    expect(change).toMatchObject({
      status: "pending",
      requested_by: people.hr.id,
      raised_by_worker: false,
      approved_by: null,
      decided_at: null,
      applies_after: null,
    });
    expect(await workerBank(workerId)).toEqual(before);
  });

  it("refuses a requester or decision columns chosen by the caller", async () => {
    const workerId = await addWorker();
    const forged = await people.hr.client.from("bank_detail_changes").insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      requested_by: people.finance.id,
      bank_name: "GTBank",
      account_name: "Musa Ibrahim",
      bank_account_enc: enc(),
      bank_account_last4: "7712",
    });
    expect(forged.error?.code).toBe(PERMISSION_DENIED);
    const preApproved = await people.hr.client.from("bank_detail_changes").insert({
      organisation_id: owner.orgId,
      worker_id: workerId,
      status: "approved",
      bank_name: "GTBank",
      account_name: "Musa Ibrahim",
      bank_account_enc: enc(),
      bank_account_last4: "7712",
    });
    expect(preApproved.error?.code).toBe(PERMISSION_DENIED);
  });

  it("allows one open request per worker", async () => {
    const workerId = await addWorker();
    await mustRequest(workerId);
    const second = await request(workerId, people.hr2.client);
    expect(second.error?.code).toBe("23505");
  });

  it("refuses a request for an employee who has left", async () => {
    const workerId = await addWorker(owner.orgId, { status: "ended", end_date: "2025-06-30" });
    const { error } = await request(workerId);
    expect(error?.code).toBe("MLBK5");
  });

  it("lets owner, admin and hr raise requests, a worker only for themselves, nobody else", async () => {
    await mustRequest(await addWorker(), owner.client);
    await mustRequest(await addWorker(), people.admin.client);

    const own = await mustRequest(ownWorkerId, people.worker.client);
    expect(own.raised_by_worker).toBe(true);
    expect((await request(await addWorker(), people.worker.client)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect((await request(await addWorker(), people.finance.client)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect((await request(await addWorker(), people.ops.client)).error?.code).toBe(
      PERMISSION_DENIED,
    );
  });

  it("shows requests to owner, admin, hr and finance, and a worker only their own", async () => {
    const change = await mustRequest(await addWorker());
    for (const user of [owner, people.admin, people.hr, people.finance]) {
      const { data } = await user.client
        .from("bank_detail_changes")
        .select("id")
        .eq("id", change.id);
      expect(data).toHaveLength(1);
    }
    const ops = await people.ops.client.from("bank_detail_changes").select("id");
    expect(ops.data).toEqual([]);
    const mine = await people.worker.client.from("bank_detail_changes").select("worker_id");
    expect(mine.data?.length).toBeGreaterThan(0);
    expect(new Set(mine.data?.map((row) => row.worker_id))).toEqual(new Set([ownWorkerId]));
  });
});

describe("two-person approval", () => {
  it("refuses the requester approving or rejecting their own request", async () => {
    const workerId = await addWorker();
    const before = await workerBank(workerId);
    const change = await mustRequest(workerId);

    const approve = await decide(change.id, "approved", people.hr.client);
    expect(approve.error?.code).toBe("MLBK1");
    const reject = await decide(change.id, "rejected", people.hr.client);
    expect(reject.error?.code).toBe("MLBK1");

    expect((await changeRow(change.id)).status).toBe("pending");
    expect(await workerBank(workerId)).toEqual(before);
  });

  it("refuses self-approval in the database itself, even for the table owner", async () => {
    const change = await mustRequest(await addWorker());
    await db.query("begin");
    try {
      await db.query(
        "alter table public.bank_detail_changes disable trigger bank_detail_changes_before_update",
      );
      await expect(
        db.query(
          `update public.bank_detail_changes
           set status = 'approved', approved_by = requested_by, decided_at = now(),
             applies_after = now() + interval '72 hours'
           where id = $1`,
          [change.id],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "bank_detail_changes_second_approver",
      });
    } finally {
      await db.query("rollback");
    }
    expect((await changeRow(change.id)).status).toBe("pending");
  });

  it("refuses the secret key approving on the requester's behalf", async () => {
    const change = await mustRequest(await addWorker());
    // No signed-in user: the trigger has no second person to record.
    const { error } = await admin
      .from("bank_detail_changes")
      .update({ status: "approved" })
      .eq("id", change.id);
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect((await changeRow(change.id)).status).toBe("pending");
  });

  it("a worker cannot approve anything, including a request they raised", async () => {
    const own = await people.worker.client
      .from("bank_detail_changes")
      .select("id")
      .eq("worker_id", ownWorkerId)
      .eq("status", "pending")
      .single();
    expect(own.error).toBeNull();
    const selfApprove = await decide(own.data!.id, "approved", people.worker.client);
    expect(selfApprove.error?.code).toBe(PERMISSION_DENIED);

    const someoneElse = await mustRequest(await addWorker());
    const approveOther = await decide(someoneElse.id, "approved", people.worker.client);
    expect(approveOther.error).toBeNull();
    expect(approveOther.data).toEqual([]);
    expect((await changeRow(someoneElse.id)).status).toBe("pending");
  });

  it("admins and operations managers cannot approve", async () => {
    const change = await mustRequest(await addWorker());
    for (const user of [people.admin, people.ops]) {
      const { data, error } = await decide(change.id, "approved", user.client);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    expect((await changeRow(change.id)).status).toBe("pending");
  });

  it("nobody decides a change to their own bank details", async () => {
    const change = await mustRequest(hrWorkerRecordId);
    const { error } = await decide(change.id, "approved", people.hrWorker.client);
    expect(error?.code).toBe("MLBK2");
    expect((await changeRow(change.id)).status).toBe("pending");
    // Someone else can.
    expect((await decide(change.id, "rejected", people.finance.client)).error).toBeNull();
  });

  it("rejected requests leave the worker unchanged", async () => {
    const workerId = await addWorker();
    const before = await workerBank(workerId);
    const change = await mustRequest(workerId);
    const { data, error } = await decide(change.id, "rejected", owner.client, "Wrong account");
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      status: "rejected",
      rejected_by: owner.id,
      approved_by: null,
      applies_after: null,
      decision_note: "Wrong account",
    });
    expect(await applyDue()).toMatchObject({ error: null });
    expect(await workerBank(workerId)).toEqual(before);
    // Decided once: no second decision.
    expect((await decide(change.id, "approved", people.finance.client)).error?.code).toBe("MLBK4");
  });

  it("never lets a request's details change after it is raised", async () => {
    const change = await mustRequest(await addWorker());
    const edit = await people.finance.client
      .from("bank_detail_changes")
      .update({ bank_account_last4: "0000" })
      .eq("id", change.id);
    expect(edit.error?.code).toBe(PERMISSION_DENIED);
    const del = await people.finance.client
      .from("bank_detail_changes")
      .delete()
      .eq("id", change.id);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    await expect(
      db.query("update public.bank_detail_changes set bank_account_last4 = '0000' where id = $1", [
        change.id,
      ]),
    ).rejects.toMatchObject({ code: "MLBK4" });
    await expect(
      db.query("delete from public.bank_detail_changes where id = $1", [change.id]),
    ).rejects.toMatchObject({ code: "MLBK4" });
  });

  it("only the requester withdraws a pending request", async () => {
    const change = await mustRequest(await addWorker());
    expect((await decide(change.id, "cancelled", people.finance.client)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    const { data, error } = await decide(change.id, "cancelled", people.hr.client);
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ status: "cancelled", cancelled_by: people.hr.id });
  });
});

describe("the 72-hour hold", () => {
  it("applies an approved change only after 72 hours, then shows it on the worker", async () => {
    const workerId = await addWorker();
    const before = await workerBank(workerId);
    const change = await mustRequest(workerId);

    const { data, error } = await decide(change.id, "approved", people.finance.client);
    expect(error).toBeNull();
    const approved = data![0]!;
    expect(approved).toMatchObject({
      status: "approved",
      approved_by: people.finance.id,
      previous_bank_name: "Access Bank",
      previous_bank_account_last4: "1234",
    });
    const decidedAt = Date.parse(approved.decided_at!);
    expect(Date.parse(approved.applies_after!) - decidedAt).toBe(72 * HOUR);

    // During the hold: the worker keeps the old account, the apply does nothing, and nobody can
    // jump the queue.
    expect((await applyDue()).data).toBe(0);
    expect(await workerBank(workerId)).toEqual(before);
    const early = await decide(change.id, "applied", owner.client);
    expect(early.error?.code).toBe("MLBK3");

    // Payouts ask which account was in force at the payout time.
    const asOf = async (at: Date) => {
      const { data: rows, error: e } = await people.finance.client.rpc(
        "worker_bank_details_as_of",
        { p_organisation_id: owner.orgId, p_worker_id: workerId, p_at: at.toISOString() },
      );
      expect(e).toBeNull();
      return rows?.[0]?.bank_account_last4;
    };
    expect(await asOf(new Date())).toBe("1234");
    expect(await asOf(new Date(decidedAt + 73 * HOUR))).toBe("7712");

    await endHold(change.id);
    expect((await applyDue()).data).toBe(1);
    // Idempotent: a second run (or the pg_cron job) finds nothing to do.
    expect((await applyDue()).data).toBe(0);

    const after = await workerBank(workerId);
    expect(after.bank_name).toBe("GTBank");
    expect(after.bank_account_last4).toBe("7712");
    expect(after.bank_account_enc).toBe(change.bank_account_enc.slice(2));
    const row = await changeRow(change.id);
    expect(row.status).toBe("applied");
    expect(row.applied_at).not.toBeNull();
    expect(await asOf(new Date())).toBe("7712");
  });

  it("a stopped change during the hold never applies", async () => {
    const workerId = await addWorker();
    const before = await workerBank(workerId);
    const change = await mustRequest(workerId);
    expect((await decide(change.id, "approved", owner.client)).error).toBeNull();
    // The requester (hr) can stop it too: stopping only ever protects the worker.
    const stop = await decide(change.id, "cancelled", people.hr.client, "Worker did not ask");
    expect(stop.error).toBeNull();
    expect(stop.data?.[0]).toMatchObject({ status: "cancelled", cancelled_by: people.hr.id });
    await expect(
      db.query(
        `update public.bank_detail_changes set applies_after = now() - interval '1 hour'
         where id = $1`,
        [change.id],
      ),
    ).rejects.toMatchObject({ code: "MLBK4" });
    expect((await applyDue()).data).toBe(0);
    expect(await workerBank(workerId)).toEqual(before);
  });

  it("can't be stopped once the hold has ended", async () => {
    const change = await mustRequest(await addWorker());
    expect((await decide(change.id, "approved", people.finance.client)).error).toBeNull();
    await endHold(change.id);
    const { error } = await decide(change.id, "cancelled", owner.client);
    expect(error?.code).toBe("MLBK3");
    expect((await applyDue()).data).toBe(1);
  });

  it("the pg_cron job is scheduled every 5 minutes", async () => {
    const { rows } = await db.query<{ schedule: string; command: string }>(
      "select schedule, command from cron.job where jobname = 'apply-bank-detail-changes'",
    );
    expect(rows).toEqual([
      { schedule: "*/5 * * * *", command: "select private.apply_due_bank_detail_changes(null)" },
    ]);
  });

  it("a signed-in user can apply only for their own organisation", async () => {
    expect((await applyDue(people.hr.client, other.orgId)).error?.code).toBe(PERMISSION_DENIED);
    const all = await people.hr.client.rpc("apply_due_bank_detail_changes", {
      p_organisation_id: null as unknown as string,
    });
    expect(all.error?.code).toBe(PERMISSION_DENIED);
  });

  it("audits the request, the decision and the change, never the account number", async () => {
    const workerId = await addWorker();
    const change = await mustRequest(workerId, people.hr.client, "9031");
    expect((await decide(change.id, "approved", people.finance.client)).error).toBeNull();
    await endHold(change.id);
    expect((await applyDue()).data).toBe(1);

    const { data: audit, error } = await admin
      .from("audit_log")
      .select("action, actor_id, entity_id, before, after")
      .eq("organisation_id", owner.orgId)
      .in("entity_id", [change.id, workerId]);
    expect(error).toBeNull();
    const actions = (audit ?? []).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "bank_detail_changes.insert",
        "bank_detail_changes.update",
        "workers.update",
        "workers.personal_data",
      ]),
    );
    const approval = audit!.find(
      (row) =>
        row.action === "bank_detail_changes.update" &&
        (row.before as { status?: string } | null)?.status === "pending" &&
        (row.after as { status?: string } | null)?.status === "approved",
    );
    expect(approval?.actor_id).toBe(people.finance.id);
    const personal = audit!
      .filter((row) => row.action === "workers.personal_data")
      .map((row) => row.after);
    expect(personal).toContainEqual({ changes: [{ field: "bank_account", change: "changed" }] });
    const text = JSON.stringify(audit);
    expect(text).not.toContain("9031");
    expect(text).not.toContain(change.bank_account_enc.slice(2));
  });
});

describe("new workers", () => {
  async function newWorker(by: Client, org: string, fields: Record<string, Json> = {}) {
    staffCounter += 1;
    const id = randomUUID();
    // Bank details come with the caller's own lookup (slice 2.3b).
    const { data: who } = await by.auth.getUser();
    const lookup = await makeLookup(admin, {
      orgId: org,
      userId: who.user!.id,
      purpose: "worker_bank",
      last4: "4410",
      accountName: "NGOZI EZE",
    });
    return by
      .rpc("create_worker", {
        p_worker: {
          id,
          organisation_id: org,
          staff_id: `NW-${String(staffCounter).padStart(4, "0")}`,
          first_name: "Ngozi",
          last_name: `Eze ${staffCounter}`,
          employment_type: "permanent",
          start_date: "2025-01-06",
          bank_name: "GTBank",
          account_name: "Ngozi Eze",
          bank_account_enc: enc(),
          bank_account_last4: "4410",
          bank_code: lookup.bankCode,
          bank_lookup_id: lookup.id,
          bank_account_digest: lookup.digest,
          name_check: "match",
          ...fields,
        },
      })
      .then((result) => ({ ...result, id }));
  }

  it("refuses unchecked bank details from a signed-in caller (slice 2.3b)", async () => {
    const { error } = await newWorker(people.hr.client, owner.orgId, {
      bank_lookup_id: null,
      bank_account_digest: null,
      name_check: null,
    });
    expect(error?.code).toBe("MLBL7");
  });

  async function openRequests(workerId: string) {
    const { rows } = await db.query<{ status: string; requested_by: string; reason: string }>(
      "select status, requested_by, reason from public.bank_detail_changes where worker_id = $1",
      [workerId],
    );
    return rows;
  }

  const newEmployee = (staffId: string) => ({
    organisation_id: owner.orgId,
    staff_id: staffId,
    first_name: "Ngozi",
    last_name: "Direct",
    employment_type: "permanent" as const,
    start_date: "2025-01-06",
    bank_name: "GTBank",
    account_name: "Ngozi Direct",
    bank_account_enc: enc(),
    bank_account_last4: "4410",
  });

  it("holds bank details as a request on every path, before setup is finished", async () => {
    const { rows } = await db.query<{ setup_completed_at: Date | null }>(
      "select setup_completed_at from public.organisations where id = $1",
      [owner.orgId],
    );
    expect(rows[0]?.setup_completed_at).toBeNull();

    // No flag, and an old client asking not to hold: both are held all the same.
    const variants: Record<string, Json>[] = [{}, { hold_bank_details: false }];
    for (const fields of variants) {
      const { id, error } = await newWorker(people.hr.client, owner.orgId, fields);
      expect(error).toBeNull();
      const bank = await workerBank(id);
      expect(bank.bank_name).toBeNull();
      expect(bank.bank_account_last4).toBeNull();
      expect(bank.needs_pay_details).toBe(true);
      expect(await openRequests(id)).toEqual([
        {
          status: "pending",
          requested_by: people.hr.id,
          reason: "Bank details for a new employee",
        },
      ]);
    }
  });

  it("refuses a worker row that carries them, before and after setup", async () => {
    for (const by of [people.hr.client, owner.client]) {
      const direct = await by.from("workers").insert(newEmployee(`NW-D${(staffCounter += 1)}`));
      expect(direct.error?.code).toBe(PERMISSION_DENIED);
    }

    await db.query("update public.organisations set setup_completed_at = now() where id = $1", [
      other.orgId,
    ]);
    const { id, error } = await newWorker(other.client, other.orgId);
    expect(error).toBeNull();
    expect((await workerBank(id)).bank_account_last4).toBeNull();
    expect(await openRequests(id)).toEqual([
      { status: "pending", requested_by: other.id, reason: "Bank details for a new employee" },
    ]);
    const direct = await other.client
      .from("workers")
      .insert({ ...newEmployee("NW-DIRECT"), organisation_id: other.orgId });
    expect(direct.error?.code).toBe(PERMISSION_DENIED);
  });

  it("refuses them for a signed-in caller even past the column grants (definer code)", async () => {
    // As the table owner, with a signed-in user's claims: what a security definer function
    // run by that user would look like. The grants don't apply; the trigger still refuses.
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: people.hr.id, role: "authenticated" }),
      ]);
      const row = newEmployee("NW-DEFINER");
      await expect(
        db.query(
          `insert into public.workers (organisation_id, staff_id, first_name, last_name,
             employment_type, start_date, bank_name, account_name, bank_account_enc,
             bank_account_last4)
           values ($1, $2, $3, $4, 'permanent', $5, $6, $7, decode($8, 'hex'), $9)`,
          [
            row.organisation_id,
            row.staff_id,
            row.first_name,
            row.last_name,
            row.start_date,
            row.bank_name,
            row.account_name,
            row.bank_account_enc.slice(2),
            row.bank_account_last4,
          ],
        ),
      ).rejects.toMatchObject({ code: "MLBK6" });
    } finally {
      await db.query("rollback");
    }
  });

  it("leaves incomplete details off, so the worker keeps needs_pay_details", async () => {
    const partial = await newWorker(people.hr.client, owner.orgId, {
      bank_account_enc: null,
      bank_account_last4: null,
    });
    expect(partial.error).toBeNull();
    expect((await workerBank(partial.id)).bank_name).toBeNull();
    expect(await openRequests(partial.id)).toEqual([]);
  });

  it("holds them for every worker an import creates", async () => {
    const { id, error } = await newWorker(people.hr.client, owner.orgId);
    expect(error).toBeNull();
    // commit_import_batch creates each worker through create_worker (see imports.test.ts).
    expect(await openRequests(id)).toHaveLength(1);
  });
});

describe("bank details as of a payout date", () => {
  it("answers the owner, HR and finance, and refuses everyone else rather than guess", async () => {
    const workerId = await addWorker();
    const ask = (by: Client) =>
      by.rpc("worker_bank_details_as_of", {
        p_organisation_id: owner.orgId,
        p_worker_id: workerId,
      });
    for (const by of [owner.client, people.hr.client, people.finance.client]) {
      const { data, error } = await ask(by);
      expect(error).toBeNull();
      expect(data?.[0]?.bank_account_last4).toBe("1234");
    }
    for (const by of [people.ops.client, people.admin.client, people.worker.client]) {
      const { data, error } = await ask(by);
      expect(error?.code).toBe(PERMISSION_DENIED);
      expect(data).toBeNull();
    }
    // Another company's owner can't ask about this worker either.
    expect((await ask(other.client)).error?.code).toBe(PERMISSION_DENIED);
    // Server code with the secret key (no signed-in user) may.
    expect((await ask(admin)).data?.[0]?.bank_account_last4).toBe("1234");
  });
});
