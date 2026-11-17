/**
 * Slice 1.11 (owner decision 18) against the real database: the 3rd lockout within 24 hours
 * holds sign-in until a new PIN, unknown IDs are held the same way, the manager unlock (who may,
 * what it refuses, the audit row), and the per-company cap on wrong PINs.
 */
import { randomBytes } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

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

const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;
const CAP = 50;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let companyCode: string;
const staff = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager" | "otherLm", TestUser>;
let lineManagerMembership: string;
let counter = 0;

const ipKey = () => randomBytes(32).toString("hex");

async function addMember(user: TestUser, role: Role, orgId = owner.orgId): Promise<string> {
  const { data, error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

async function addWorker(
  fields: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
  orgId = owner.orgId,
) {
  counter += 1;
  const staffId = `PL-${String(counter).padStart(4, "0")}`;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: staffId,
      first_name: "Ngozi",
      last_name: `Eze ${counter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { id: data!.id, staffId };
}

async function setPin(workerId: string, orgId = owner.orgId): Promise<string> {
  const { data: inv, error } = await owner.client.rpc("create_worker_invites", {
    p_organisation_id: orgId,
    p_worker_ids: [workerId],
    p_sent_via: "print",
  });
  expect(error).toBeNull();
  const existing = await db.query<{ auth_user_id: string }>(
    "select auth_user_id from public.worker_credentials where worker_id = $1",
    [workerId],
  );
  let authUserId = existing.rows[0]?.auth_user_id;
  if (!authUserId) {
    const created = await admin.auth.admin.createUser({
      email: `w-${workerId}@workers.metalira.invalid`,
      email_confirm: true,
      app_metadata: { login: "worker" },
    });
    expect(created.error).toBeNull();
    authUserId = created.data.user!.id;
  }
  const accepted = await admin.rpc("accept_worker_invite", {
    p_token: inv![0]!.token,
    p_auth_user_id: authUserId,
    p_pin_hash: PIN_HASH,
  });
  expect(accepted.error).toBeNull();
  return authUserId;
}

async function signedUpWorker(fields: Parameters<typeof addWorker>[0] = {}) {
  const worker = await addWorker(fields);
  await setPin(worker.id);
  return worker;
}

async function begin(staffId: string, code = companyCode) {
  const { data, error } = await admin
    .rpc("worker_sign_in_begin", { p_company_code: code, p_staff_id: staffId, p_ip_key: ipKey() })
    .single();
  expect(error).toBeNull();
  return data!;
}

async function finish(workerId: string | null, ok: boolean) {
  const { data, error } = await admin.rpc("worker_sign_in_finish", {
    p_worker_id: workerId as string,
    p_ok: ok,
    p_ip_key: ipKey(),
  });
  expect(error).toBeNull();
  return data;
}

/** Five wrong PINs in a row; returns what the 5th try's finish said. */
async function lockOnce(workerId: string | null, staffId: string) {
  let last: string | null = null;
  for (let i = 1; i <= 5; i += 1) {
    const started = await begin(staffId);
    expect(started.outcome, `try ${i}`).toBe("proceed");
    last = await finish(workerId, false);
  }
  return last;
}

/** Moves the worker's lock into the past, as if 15 minutes had gone by. */
async function endLock(workerId: string) {
  await db.query(
    "update public.worker_credentials set locked_until = now() - interval '1 second' where worker_id = $1",
    [workerId],
  );
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("pl-owner", "PIN Lockout Org");
  other = await createTenantUser("pl-other", "Other PIN Lockout Org");
  staff.admin = await createTestUser("pl-admin");
  staff.hr = await createTestUser("pl-hr");
  staff.finance = await createTestUser("pl-finance");
  staff.ops = await createTestUser("pl-ops");
  staff.lineManager = await createTestUser("pl-lm");
  staff.otherLm = await createTestUser("pl-other-lm");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  lineManagerMembership = await addMember(staff.lineManager, "line_manager");
  await addMember(staff.otherLm, "line_manager");
  const { data } = await admin
    .from("organisations")
    .select("company_code")
    .eq("id", owner.orgId)
    .single();
  companyCode = data!.company_code;
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("delete from private.auth_throttle where key like 'company:%'");
});

describe("the hold after 3 lockouts in 24 hours", () => {
  it("holds at the 3rd lockout, refuses even after the lock ends, and audits it", async () => {
    const worker = await signedUpWorker();
    expect(await lockOnce(worker.id, worker.staffId)).toBe("locked");
    await endLock(worker.id);
    expect(await lockOnce(worker.id, worker.staffId)).toBe("locked");
    await endLock(worker.id);

    // The 5th try of the 3rd round says in advance that it holds.
    for (let i = 1; i <= 4; i += 1) {
      await begin(worker.staffId);
      await finish(worker.id, false);
    }
    expect(await begin(worker.staffId)).toMatchObject({
      outcome: "proceed",
      locks_on_failure: true,
      holds_on_failure: true,
    });
    expect(await finish(worker.id, false)).toBe("held");

    await endLock(worker.id);
    expect(await begin(worker.staffId)).toMatchObject({ outcome: "held", pin_hash: null });

    const { rows } = await db.query<{ action: string }>(
      "select action from public.audit_log where entity_id = $1 and action like 'worker_auth.%' order by at",
      [worker.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "worker_auth.locked",
      "worker_auth.locked",
      "worker_auth.locked",
      "worker_auth.held",
    ]);
  });

  it("counts only lockouts in the last 24 hours", async () => {
    const worker = await signedUpWorker();
    await lockOnce(worker.id, worker.staffId);
    await endLock(worker.id);
    await lockOnce(worker.id, worker.staffId);
    await endLock(worker.id);
    // Both earlier lockouts move back 25 hours (the audit log is append-only, so through a
    // superuser session with its guard paused).
    await db.query("begin");
    await db.query("alter table public.audit_log disable trigger audit_log_no_update_delete");
    await db.query(
      "update public.audit_log set at = at - interval '25 hours' where entity_id = $1 and action = 'worker_auth.locked'",
      [worker.id],
    );
    await db.query("alter table public.audit_log enable trigger audit_log_no_update_delete");
    await db.query("commit");
    expect(await lockOnce(worker.id, worker.staffId)).toBe("locked");
  });

  it("a new PIN lifts the hold and starts the count again", async () => {
    const worker = await signedUpWorker();
    for (let round = 0; round < 3; round += 1) {
      await lockOnce(worker.id, worker.staffId);
      await endLock(worker.id);
    }
    expect((await begin(worker.staffId)).outcome).toBe("held");
    await setPin(worker.id);
    const { rows } = await db.query(
      "select held_at, locked_until, failed_attempts from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    expect(rows).toEqual([{ held_at: null, locked_until: null, failed_attempts: 0 }]);
    expect(await lockOnce(worker.id, worker.staffId)).toBe("locked");
  });

  it("holds an unknown staff ID the same way", async () => {
    const id = `NOBODY-${counter++}`;
    for (let round = 0; round < 3; round += 1) {
      for (let i = 1; i <= 4; i += 1) {
        expect(await begin(id)).toMatchObject({ outcome: "proceed", locks_on_failure: false });
        await finish(null, false);
      }
      expect(await begin(id)).toMatchObject({
        outcome: "proceed",
        locks_on_failure: true,
        holds_on_failure: round === 2,
      });
      expect(await finish(null, false)).toBe("failed");
      if (round < 2) {
        expect((await begin(id)).outcome).toBe("locked");
        await db.query(
          "update private.auth_throttle set locked_until = now() - interval '1 second' where key like 'subject:%' and locked_until > now()",
        );
      }
    }
    expect((await begin(id)).outcome).toBe("held");
  });
});

describe("unlocking sign-in", () => {
  async function lockedWorker(fields: Parameters<typeof addWorker>[0] = {}) {
    const worker = await signedUpWorker(fields);
    expect(await lockOnce(worker.id, worker.staffId)).toBe("locked");
    return worker;
  }

  it("owner, admin and hr unlock, and it is audited with who did it", async () => {
    for (const [by, userId] of [
      [owner.client, owner.id],
      [staff.admin.client, staff.admin.id],
      [staff.hr.client, staff.hr.id],
    ] as const) {
      const worker = await lockedWorker();
      const { error } = await by.rpc("unlock_worker_sign_in", {
        p_organisation_id: owner.orgId,
        p_worker_id: worker.id,
      });
      expect(error).toBeNull();
      expect((await begin(worker.staffId)).outcome).toBe("proceed");
      const { rows } = await db.query(
        "select actor_id, before ->> 'failed_attempts' as before_attempts from public.audit_log where entity_id = $1 and action = 'worker_auth.unlocked'",
        [worker.id],
      );
      expect(rows).toEqual([{ actor_id: userId, before_attempts: "5" }]);
    }
  });

  it("the worker's own line manager unlocks; another line manager, finance and ops can't", async () => {
    const worker = await lockedWorker({ line_manager_membership_id: lineManagerMembership });
    for (const who of ["otherLm", "finance", "ops"] as const) {
      const { error } = await staff[who].client.rpc("unlock_worker_sign_in", {
        p_organisation_id: owner.orgId,
        p_worker_id: worker.id,
      });
      expect(error?.code, who).toBe("42501");
    }
    // The line manager sees the lock on their reportee's page.
    const seen = await staff.lineManager.client
      .from("worker_credentials")
      .select("locked_until")
      .eq("worker_id", worker.id);
    expect(seen.data).toHaveLength(1);
    const notTheirs = await staff.otherLm.client
      .from("worker_credentials")
      .select("locked_until")
      .eq("worker_id", worker.id);
    expect(notTheirs.data).toEqual([]);

    const { error } = await staff.lineManager.client.rpc("unlock_worker_sign_in", {
      p_organisation_id: owner.orgId,
      p_worker_id: worker.id,
    });
    expect(error).toBeNull();
  });

  it("refuses a hold, a login that isn't locked, no login, and another company", async () => {
    const held = await signedUpWorker();
    for (let round = 0; round < 3; round += 1) {
      await lockOnce(held.id, held.staffId);
      if (round < 2) await endLock(held.id);
    }
    const unlock = (workerId: string, org = owner.orgId, by = staff.hr.client) =>
      by.rpc("unlock_worker_sign_in", { p_organisation_id: org, p_worker_id: workerId });

    expect((await unlock(held.id)).error?.code).toBe("MLPN1");
    const open = await signedUpWorker();
    expect((await unlock(open.id)).error?.code).toBe("MLPN2");
    const noLogin = await addWorker();
    expect((await unlock(noLogin.id)).error?.code).toBe("MLPN2");

    const foreign = await addWorker({}, other.orgId);
    expect((await unlock(foreign.id)).error?.code).toBe("42501");
    expect((await unlock(foreign.id, other.orgId)).error?.code).toBe("42501");
    const anon = await anonClient().rpc("unlock_worker_sign_in", {
      p_organisation_id: owner.orgId,
      p_worker_id: open.id,
    });
    expect(anon.error).not.toBeNull();
  });
});

describe("the company cap on wrong PINs", () => {
  it("refuses the company's sign-ins at the cap, counts against no worker, and audits once", async () => {
    const worker = await signedUpWorker();
    for (let i = 1; i <= CAP; i += 1) {
      const started = await begin(`SPRAY-${counter}-${i}`);
      expect(started.outcome, `try ${i}`).toBe("proceed");
      await finish(null, false);
    }
    for (let i = 0; i < 3; i += 1) {
      expect(await begin(worker.staffId)).toMatchObject({
        outcome: "company_throttled",
        pin_hash: null,
      });
    }
    const { rows: creds } = await db.query(
      "select failed_attempts, locked_until from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    expect(creds).toEqual([{ failed_attempts: 0, locked_until: null }]);

    const { rows: audit } = await db.query(
      "select (after ->> 'wrong_pin_cap')::int as cap, actor_id from public.audit_log where organisation_id = $1 and action = 'worker_auth.company_throttled'",
      [owner.orgId],
    );
    expect(audit).toEqual([{ cap: CAP, actor_id: null }]);

    // Another company is not affected.
    const { data } = await admin
      .from("organisations")
      .select("company_code")
      .eq("id", other.orgId)
      .single();
    expect((await begin("ANY-1", data!.company_code)).outcome).toBe("proceed");

    // The window ends: sign-ins for the company work again.
    await db.query(
      "update private.auth_throttle set window_started_at = now() - interval '16 minutes' where key like 'company:%'",
    );
    expect((await begin(worker.staffId)).outcome).toBe("proceed");
    expect(await finish(worker.id, true)).toBe("signed_in");
  });

  it("gives a successful sign-in its try back", async () => {
    const worker = await signedUpWorker();
    for (let i = 1; i < CAP; i += 1) {
      await begin(`SPRAY2-${counter}-${i}`);
      await finish(null, false);
    }
    for (let i = 0; i < 5; i += 1) {
      expect((await begin(worker.staffId)).outcome).toBe("proceed");
      expect(await finish(worker.id, true)).toBe("signed_in");
    }
  });

  it("caps an unknown company code the same way", async () => {
    for (let i = 1; i <= CAP; i += 1) await begin(`X-${i}`, "QQQQQQ");
    expect((await begin("X-0", "QQQQQQ")).outcome).toBe("company_throttled");
  });
});
