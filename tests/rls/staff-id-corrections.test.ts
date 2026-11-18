/**
 * Slice 1.11 (owner decision 19) against the real database: staff ID corrections need a
 * reason and a second approver (owner, admin or hr), apply on approval with before and after in
 * the audit log, are refused for workers with work records or who have left, and never let an
 * ID be used twice in a company (current, ended, retired or reserved). Cross-organisation
 * isolation is in isolation.test.ts (tables/staff_id.ts).
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

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
let other: TenantUser;
const staff = {} as Record<"admin" | "hr" | "finance" | "lineManager", TestUser>;
let counter = 0;

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function addWorker(
  fields: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
  orgId = owner.orgId,
) {
  counter += 1;
  const staffId = fields.staff_id ?? `SC-${String(counter).padStart(4, "0")}`;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: staffId,
      first_name: "Tunde",
      last_name: `Bakare ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { id: data!.id, staffId };
}

const raise = (by: Client, workerId: string, newStaffId: string, orgId = owner.orgId) =>
  by
    .from("staff_id_corrections")
    .insert({
      organisation_id: orgId,
      worker_id: workerId,
      new_staff_id: newStaffId,
      reason: "Typo at import",
    } as Database["public"]["Tables"]["staff_id_corrections"]["Insert"])
    .select("id, old_staff_id, status")
    .single();

const decide = (by: Client, id: string, status: "approved" | "rejected" | "cancelled") =>
  by
    .from("staff_id_corrections")
    .update({ status })
    .eq("id", id)
    .select("id, status, approved_by, rejected_by, cancelled_by")
    .maybeSingle();

async function staffIdOf(workerId: string): Promise<string> {
  const { rows } = await db.query<{ staff_id: string }>(
    "select staff_id from public.workers where id = $1",
    [workerId],
  );
  return rows[0]!.staff_id;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("sc-owner", "Staff ID Org");
  other = await createTenantUser("sc-other", "Other Staff ID Org");
  staff.admin = await createTestUser("sc-admin");
  staff.hr = await createTestUser("sc-hr");
  staff.finance = await createTestUser("sc-finance");
  staff.lineManager = await createTestUser("sc-lm");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.lineManager, "line_manager");
});

afterAll(async () => {
  await db?.end();
});

describe("the two-person rule", () => {
  it("HR raises, the owner approves, and the worker's staff ID changes with before and after audited", async () => {
    const worker = await addWorker();
    const raised = await raise(staff.hr.client, worker.id, `FIX-${counter}`);
    expect(raised.error).toBeNull();
    expect(raised.data).toMatchObject({ old_staff_id: worker.staffId, status: "pending" });
    expect(await staffIdOf(worker.id)).toBe(worker.staffId);

    const approved = await decide(owner.client, raised.data!.id, "approved");
    expect(approved.error).toBeNull();
    expect(approved.data).toMatchObject({ status: "approved", approved_by: owner.id });
    expect(await staffIdOf(worker.id)).toBe(`FIX-${counter}`);

    const { rows } = await db.query<{ before: string; after: string; actor_id: string }>(
      "select before ->> 'staff_id' as before, after ->> 'staff_id' as after, actor_id from public.audit_log where entity_id = $1 and action = 'workers.update'",
      [worker.id],
    );
    expect(rows).toEqual([{ before: worker.staffId, after: `FIX-${counter}`, actor_id: owner.id }]);
    const { rows: corr } = await db.query(
      "select action from public.audit_log where entity_id = $1 order by at",
      [raised.data!.id],
    );
    expect(corr.map((r) => r.action)).toEqual([
      "staff_id_corrections.insert",
      "staff_id_corrections.update",
    ]);
  });

  it("refuses the requester deciding their own correction, even through the table directly", async () => {
    const worker = await addWorker();
    const raised = await raise(staff.admin.client, worker.id, `OWN-${counter}`);
    expect(raised.error).toBeNull();
    for (const status of ["approved", "rejected"] as const) {
      const { error } = await decide(staff.admin.client, raised.data!.id, status);
      expect(error?.code).toBe("MLSI1");
    }
    // The check constraint holds even for a superuser write that skips the trigger.
    await db.query("begin");
    await db.query(
      "alter table public.staff_id_corrections disable trigger staff_id_corrections_before_update",
    );
    await expect(
      db.query(
        "update public.staff_id_corrections set status = 'approved', approved_by = requested_by, decided_at = now() where id = $1",
        [raised.data!.id],
      ),
    ).rejects.toThrow(/staff_id_corrections_second_approver/);
    await db.query("rollback");
    expect(await staffIdOf(worker.id)).toBe(worker.staffId);
  });

  it("finance and line managers can neither raise nor decide; another company can't see it", async () => {
    const worker = await addWorker();
    for (const who of ["finance", "lineManager"] as const) {
      const { error } = await raise(staff[who].client, worker.id, `NO-${counter}-${who}`);
      expect(error?.code, who).toBe("42501");
    }
    const raised = await raise(staff.hr.client, worker.id, `MAYBE-${counter}`);
    expect(raised.error).toBeNull();
    for (const who of ["finance", "lineManager"] as const) {
      const { data } = await decide(staff[who].client, raised.data!.id, "approved");
      expect(data, who).toBeNull();
    }
    const { data: seen } = await other.client
      .from("staff_id_corrections")
      .select("id")
      .eq("id", raised.data!.id);
    expect(seen).toEqual([]);
    const cross = await raise(other.client, worker.id, `X-${counter}`, owner.orgId);
    expect(cross.error?.code).toBe("42501");
    expect(await staffIdOf(worker.id)).toBe(worker.staffId);
  });

  it("rejection and withdrawal leave the staff ID alone; only the requester withdraws", async () => {
    const worker = await addWorker();
    const first = await raise(staff.hr.client, worker.id, `REJ-${counter}`);
    expect((await decide(staff.admin.client, first.data!.id, "rejected")).data).toMatchObject({
      status: "rejected",
      rejected_by: staff.admin.id,
    });
    const second = await raise(staff.hr.client, worker.id, `REJ-${counter}`);
    expect(second.error).toBeNull();
    expect((await decide(owner.client, second.data!.id, "cancelled")).error?.code).toBe("42501");
    expect((await decide(staff.hr.client, second.data!.id, "cancelled")).data).toMatchObject({
      status: "cancelled",
      cancelled_by: staff.hr.id,
    });
    expect(await staffIdOf(worker.id)).toBe(worker.staffId);
    // A decided correction is final, and none can be deleted.
    expect((await decide(owner.client, second.data!.id, "approved")).error?.code).toBe("MLSI4");
    await expect(
      db.query("delete from public.staff_id_corrections where id = $1", [second.data!.id]),
    ).rejects.toThrow(/kept as history/);
  });

  it("allows one open correction per worker", async () => {
    const worker = await addWorker();
    expect((await raise(staff.hr.client, worker.id, `ONE-${counter}`)).error).toBeNull();
    expect((await raise(owner.client, worker.id, `TWO-${counter}`)).error?.code).toBe("23505");
  });
});

describe("IDs are never used twice in a company", () => {
  it("refuses an ID a current or ended worker has", async () => {
    const worker = await addWorker();
    const current = await addWorker();
    const ended = await addWorker({ status: "ended", end_date: "2025-06-30" });
    for (const taken of [current.staffId, ended.staffId, current.staffId.toLowerCase()]) {
      const { error } = await raise(staff.hr.client, worker.id, taken);
      expect(error?.code, taken).toBe("MLSI3");
    }
    expect(
      (await raise(staff.hr.client, worker.id, worker.staffId.toLowerCase())).error?.code,
    ).toBe("MLSI3");
  });

  it("retires the old ID for good: no correction and no new worker can take it", async () => {
    const worker = await addWorker();
    const old = worker.staffId;
    const raised = await raise(staff.hr.client, worker.id, `NEW-${counter}`);
    await decide(owner.client, raised.data!.id, "approved");

    const someoneElse = await addWorker();
    expect((await raise(staff.hr.client, someoneElse.id, old)).error?.code).toBe("MLSI3");
    // Back to the old ID is refused too.
    expect((await raise(staff.hr.client, worker.id, old)).error?.code).toBe("MLSI3");
    // A new worker with the retired ID is refused for every writer.
    const { error } = await admin.from("workers").insert({
      organisation_id: owner.orgId,
      staff_id: old,
      first_name: "New",
      last_name: "Person",
      employment_type: "permanent",
      start_date: "2025-01-06",
    });
    expect(error?.code).toBe("MLSI3");
    // Another company may use it.
    await addWorker({ staff_id: old }, other.orgId);
  });

  it("a pending correction reserves its new ID", async () => {
    const a = await addWorker();
    const b = await addWorker();
    const reserved = `RES-${counter}`;
    expect((await raise(staff.hr.client, a.id, reserved)).error).toBeNull();
    expect((await raise(staff.hr.client, b.id, reserved)).error?.code).toBe("MLSI3");
    const { error } = await admin.from("workers").insert({
      organisation_id: owner.orgId,
      staff_id: reserved,
      first_name: "New",
      last_name: "Person",
      employment_type: "permanent",
      start_date: "2025-01-06",
    });
    expect(error?.code).toBe("MLSI3");
  });

  it("re-checks on approval: an ID taken meanwhile is refused", async () => {
    const worker = await addWorker();
    const wanted = `RACE-${counter}`;
    const raised = await raise(staff.hr.client, worker.id, wanted);
    // Someone slips a worker in with the ID past the reservation (superuser, trigger paused).
    await db.query("begin");
    await db.query("alter table public.workers disable trigger workers_staff_id_never_used");
    await db.query(
      "insert into public.workers (organisation_id, staff_id, first_name, last_name, employment_type, start_date) values ($1, $2, 'Slip', 'In', 'permanent', '2025-01-06')",
      [owner.orgId, wanted],
    );
    await db.query("alter table public.workers enable trigger workers_staff_id_never_used");
    await db.query("commit");
    expect((await decide(owner.client, raised.data!.id, "approved")).error?.code).toBe("MLSI3");
    expect(await staffIdOf(worker.id)).toBe(worker.staffId);
  });
});

describe("when a correction is allowed", () => {
  it("refuses a worker who has left", async () => {
    const ended = await addWorker({ status: "ended", end_date: "2025-06-30" });
    expect((await raise(staff.hr.client, ended.id, `GONE-${counter}`)).error?.code).toBe("MLSI5");
  });

  it("refuses once work records exist (the hook later phases fill in)", async () => {
    const { rows } = await db.query<{ has: boolean }>(
      "select private.worker_has_work_records($1, $2) as has",
      [owner.orgId, (await addWorker()).id],
    );
    expect(rows[0]!.has).toBe(false);

    // A Phase 3 punches table appears without the hook being updated: corrections fail closed.
    const worker = await addWorker();
    await db.query("create table public.punches (id uuid primary key)");
    try {
      const { rows: closed } = await db.query<{ has: boolean }>(
        "select private.worker_has_work_records($1, $2) as has",
        [owner.orgId, worker.id],
      );
      expect(closed[0]!.has).toBe(true);
      const { error } = await raise(staff.hr.client, worker.id, `PUNCHED-${counter}`);
      expect(error?.code).toBe("MLSI6");
    } finally {
      await db.query("drop table public.punches");
    }
  });

  it("refuses a correction raised for a worker whose ID changed meanwhile", async () => {
    const worker = await addWorker();
    const raised = await raise(staff.hr.client, worker.id, `LATE-${counter}`);
    await db.query("update public.workers set staff_id = $2 where id = $1", [
      worker.id,
      `MOVED-${counter}`,
    ]);
    expect((await decide(owner.client, raised.data!.id, "approved")).error?.code).toBe("MLSI7");
  });

  it("gives signed-in users no direct write to workers.staff_id", async () => {
    const worker = await addWorker();
    const { error } = await owner.client
      .from("workers")
      .update({ staff_id: `DIRECT-${counter}` } as never)
      .eq("id", worker.id);
    expect(error?.code).toBe("42501");
  });
});
