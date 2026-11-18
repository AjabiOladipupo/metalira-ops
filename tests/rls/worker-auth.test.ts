/**
 * Slice 1.9 against the real database: worker invites (who may create them, single use,
 * expiry, revocation), invite acceptance (login, membership, PIN reset ends sessions), the PIN
 * sign-in counter (5 tries then a 15-minute lock, unknown IDs locked the same way, a cap per
 * network address), who may call the secret-key-only functions, and what a worker's own session
 * can read. Cross-organisation isolation for the two tables lives in isolation.test.ts
 * (tables/worker-auth.ts).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

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

const PERMISSION_DENIED = "42501";
const PIN_HASH = `s1$k1$${"A".repeat(22)}$${"B".repeat(43)}`;

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let other: TenantUser;
let companyCode: string;
const staff = {} as Record<"admin" | "hr" | "finance" | "ops" | "lineManager", TestUser>;
let staffCounter = 0;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ipKey = () => randomBytes(32).toString("hex");

async function addMember(user: TestUser, role: Role, orgId = owner.orgId) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

async function addWorker(
  fields: Partial<Database["public"]["Tables"]["workers"]["Insert"]> = {},
  orgId = owner.orgId,
): Promise<{ id: string; staffId: string }> {
  staffCounter += 1;
  const staffId = `WA-${String(staffCounter).padStart(4, "0")}`;
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: staffId,
      first_name: "Musa",
      last_name: `Ibrahim ${staffCounter}`,
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { id: data!.id, staffId };
}

async function invite(workerId: string, by: Client = staff.hr.client, channel = "print") {
  const { data, error } = await by.rpc("create_worker_invites", {
    p_organisation_id: owner.orgId,
    p_worker_ids: [workerId],
    p_sent_via: channel,
  });
  expect(error).toBeNull();
  return data![0]!;
}

async function workerLogin(workerId: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `w-${workerId}@workers.metalira.invalid`,
    email_confirm: true,
    app_metadata: { login: "worker" },
  });
  expect(error).toBeNull();
  return data.user!.id;
}

/** A session for a login, opened the way the server does it (one-time token, no email). */
async function sessionFor(workerId: string): Promise<Client> {
  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: `w-${workerId}@workers.metalira.invalid`,
  });
  expect(link.error).toBeNull();
  const client = anonClient();
  const verified = await client.auth.verifyOtp({
    type: "email",
    token_hash: link.data.properties!.hashed_token,
  });
  expect(verified.error).toBeNull();
  return client;
}

/** An invited worker who has set a PIN: their login id and worker id. */
async function signedUpWorker(fields: Parameters<typeof addWorker>[0] = {}) {
  const worker = await addWorker(fields);
  const token = (await invite(worker.id)).token;
  const authUserId = await workerLogin(worker.id);
  const accepted = await admin.rpc("accept_worker_invite", {
    p_token: token,
    p_auth_user_id: authUserId,
    p_pin_hash: PIN_HASH,
  });
  expect(accepted.error).toBeNull();
  return { ...worker, authUserId };
}

async function begin(staffId: string, ip = ipKey(), code = companyCode) {
  const { data, error } = await admin
    .rpc("worker_sign_in_begin", { p_company_code: code, p_staff_id: staffId, p_ip_key: ip })
    .single();
  expect(error).toBeNull();
  return data!;
}

async function finish(workerId: string | null, ok: boolean, ip = ipKey()) {
  const { data, error } = await admin.rpc("worker_sign_in_finish", {
    p_worker_id: workerId as string,
    p_ok: ok,
    p_ip_key: ip,
  });
  expect(error).toBeNull();
  return data;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("wa-owner", "Worker Auth Org");
  other = await createTenantUser("wa-other", "Other Worker Auth Org");
  staff.admin = await createTestUser("wa-admin");
  staff.hr = await createTestUser("wa-hr");
  staff.finance = await createTestUser("wa-finance");
  staff.ops = await createTestUser("wa-ops");
  staff.lineManager = await createTestUser("wa-line-manager");
  await addMember(staff.admin, "admin");
  await addMember(staff.hr, "hr");
  await addMember(staff.finance, "finance");
  await addMember(staff.ops, "ops_manager");
  await addMember(staff.lineManager, "line_manager");
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

// The company cap on wrong PINs (slice 1.11, tests/rls/pin-lockout.test.ts) would otherwise
// stop these tests after 50 tries against one company code.
beforeEach(async () => {
  await db.query("delete from private.auth_throttle where key like 'company:%'");
});

describe("creating invites", () => {
  it("owner, admin and hr can; a token comes back once and only its hash is stored", async () => {
    for (const by of [owner.client, staff.admin.client, staff.hr.client]) {
      const worker = await addWorker();
      const row = await invite(worker.id, by);
      expect(row.token).toMatch(/^[0-9a-f]{64}$/);
      expect(row.invite_worker_id).toBe(worker.id);
      const { rows } = await db.query<{ token_hash: string; expires_at: Date; created_at: Date }>(
        "select token_hash, expires_at, created_at from public.worker_invites where id = $1",
        [row.invite_id],
      );
      expect(rows[0]!.token_hash).toBe(sha256(row.token));
      const days = (rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime()) / 86_400_000;
      expect(days).toBeCloseTo(7, 3);
    }
  });

  it.each(["finance", "ops", "lineManager"] as const)("%s cannot", async (who) => {
    const worker = await addWorker();
    const { error } = await staff[who].client.rpc("create_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [worker.id],
      p_sent_via: "print",
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("refuses another company's workers, ended workers, and email for workers without one", async () => {
    const foreign = await addWorker({}, other.orgId);
    const cross = await staff.hr.client.rpc("create_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [foreign.id],
      p_sent_via: "print",
    });
    expect(cross.error?.code).toBe("P0002");

    const aimed = await owner.client.rpc("create_worker_invites", {
      p_organisation_id: other.orgId,
      p_worker_ids: [foreign.id],
      p_sent_via: "print",
    });
    expect(aimed.error?.code).toBe(PERMISSION_DENIED);

    const ended = await addWorker({ status: "ended", end_date: "2025-06-30" });
    const endedInvite = await staff.hr.client.rpc("create_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [ended.id],
      p_sent_via: "print",
    });
    expect(endedInvite.error?.code).toBe("P0002");

    const noEmail = await addWorker();
    const email = await staff.hr.client.rpc("create_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [noEmail.id],
      p_sent_via: "email",
    });
    expect(email.error?.code).toBe("22023");

    const withEmail = await addWorker({ email: "musa@example.test" });
    await invite(withEmail.id, staff.hr.client, "email");
  });

  it("a new invite revokes the open one", async () => {
    const worker = await addWorker();
    const first = await invite(worker.id);
    const second = await invite(worker.id);
    const { rows } = await db.query<{ id: string; revoked_at: Date | null }>(
      "select id, revoked_at from public.worker_invites where worker_id = $1 order by created_at",
      [worker.id],
    );
    expect(rows.map((r) => [r.id, r.revoked_at !== null])).toEqual([
      [first.invite_id, true],
      [second.invite_id, false],
    ]);
  });

  it("is audited without the token hash", async () => {
    const worker = await addWorker();
    const row = await invite(worker.id);
    const { rows } = await db.query<{ action: string; actor_id: string; after: object }>(
      "select action, actor_id, after from public.audit_log where entity_id = $1",
      [row.invite_id],
    );
    expect(rows.map((r) => r.action)).toEqual(["worker_invites.insert"]);
    expect(rows[0]!.actor_id).toBe(staff.hr.id);
    expect(JSON.stringify(rows[0]!.after)).not.toContain(sha256(row.token));
  });
});

describe("secret-key-only functions", () => {
  it("cannot be called signed in or anonymously", async () => {
    for (const client of [anonClient(), owner.client, staff.hr.client]) {
      const lookup = await client.rpc("worker_invite_lookup", { p_token: "0".repeat(64) });
      expect(lookup.error?.code).toBe(PERMISSION_DENIED);
      const accept = await client.rpc("accept_worker_invite", {
        p_token: "0".repeat(64),
        p_auth_user_id: owner.id,
        p_pin_hash: PIN_HASH,
      });
      expect(accept.error?.code).toBe(PERMISSION_DENIED);
      const started = await client.rpc("worker_sign_in_begin", {
        p_company_code: companyCode,
        p_staff_id: "WA-0001",
        p_ip_key: ipKey(),
      });
      expect(started.error?.code).toBe(PERMISSION_DENIED);
      const finished = await client.rpc("worker_sign_in_finish", {
        p_worker_id: randomUUID(),
        p_ok: true,
        p_ip_key: ipKey(),
      });
      expect(finished.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("keeps PIN hashes and counters out of every API role's reach", async () => {
    const { rows } = await db.query<{ role: string; tbl: string; ok: boolean }>(
      `select r.role, t.tbl, has_table_privilege(r.role, t.tbl, 'select') as ok
       from (values ('anon'), ('authenticated'), ('service_role')) as r (role)
       cross join (values ('private.worker_pins'), ('private.auth_throttle')) as t (tbl)`,
    );
    expect(rows.filter((r) => r.ok)).toEqual([]);
  });

  it("gives signed-in users no write access to invites or credentials", async () => {
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'authenticated' and table_schema = 'public'
         and table_name in ('worker_invites', 'worker_credentials')
       order by table_name, privilege_type`,
    );
    expect(rows).toEqual([
      { table_name: "worker_credentials", privilege_type: "SELECT" },
      { table_name: "worker_invites", privilege_type: "SELECT" },
    ]);
  });
});

describe("using an invite", () => {
  it("looks up the invite for the page without revealing the hash", async () => {
    const worker = await addWorker();
    const row = await invite(worker.id);
    const { data, error } = await admin
      .rpc("worker_invite_lookup", { p_token: row.token })
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      worker_id: worker.id,
      staff_id: worker.staffId,
      company_code: companyCode,
      organisation_name: "Worker Auth Org",
      auth_user_id: null,
      state: "valid",
    });
    const unknown = await admin.rpc("worker_invite_lookup", { p_token: "f".repeat(64) });
    expect(unknown.data).toEqual([]);
  });

  it("creates the credentials and a worker membership, and marks the invite used", async () => {
    const worker = await signedUpWorker();
    const { rows: members } = await db.query(
      "select role, worker_id, organisation_id from public.memberships where user_id = $1",
      [worker.authUserId],
    );
    expect(members).toEqual([
      { role: "worker", worker_id: worker.id, organisation_id: owner.orgId },
    ]);
    const { rows: creds } = await db.query(
      "select failed_attempts, locked_until, auth_user_id from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    expect(creds).toEqual([
      { failed_attempts: 0, locked_until: null, auth_user_id: worker.authUserId },
    ]);
    const { rows: pins } = await db.query(
      "select pin_hash from private.worker_pins where worker_id = $1",
      [worker.id],
    );
    expect(pins).toEqual([{ pin_hash: PIN_HASH }]);
  });

  it("audits with the worker as actor and never writes the PIN hash", async () => {
    const worker = await signedUpWorker();
    const { rows } = await db.query<{ action: string; actor_id: string | null; doc: string }>(
      `select action, actor_id, coalesce(before, '{}')::text || coalesce(after, '{}')::text as doc
       from public.audit_log
       where organisation_id = $1 and (entity_id = $2 or after ->> 'worker_id' = $2::text)`,
      [owner.orgId, worker.id],
    );
    const byWorker = ["worker_credentials.insert", "memberships.insert", "worker_invites.update"];
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(byWorker));
    for (const row of rows.filter((r) => byWorker.includes(r.action))) {
      expect(row.actor_id, row.action).toBe(worker.authUserId);
    }
    expect(rows.map((r) => r.doc).join("")).not.toContain(PIN_HASH);
  });

  it("is single use, and refuses revoked and expired invites", async () => {
    const worker = await addWorker();
    const first = (await invite(worker.id)).token;
    const second = (await invite(worker.id)).token;
    const login = await workerLogin(worker.id);
    const accept = (token: string) =>
      admin.rpc("accept_worker_invite", {
        p_token: token,
        p_auth_user_id: login,
        p_pin_hash: PIN_HASH,
      });
    expect((await accept(first)).error?.code).toBe("MLWI3");
    expect((await accept(second)).error).toBeNull();
    expect((await accept(second)).error?.code).toBe("MLWI2");
    expect((await accept("0".repeat(64))).error?.code).toBe("MLWI1");

    const late = await addWorker();
    const lateToken = await invite(late.id);
    await db.query(
      "update public.worker_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1",
      [lateToken.invite_id],
    );
    const lateLogin = await workerLogin(late.id);
    const expired = await admin.rpc("accept_worker_invite", {
      p_token: lateToken.token,
      p_auth_user_id: lateLogin,
      p_pin_hash: PIN_HASH,
    });
    expect(expired.error?.code).toBe("MLWI4");
  });

  it("refuses a login that is not a worker login, or another worker's login", async () => {
    const worker = await addWorker();
    const token = (await invite(worker.id)).token;
    const manager = await admin.rpc("accept_worker_invite", {
      p_token: token,
      p_auth_user_id: staff.hr.id,
      p_pin_hash: PIN_HASH,
    });
    expect(manager.error?.code).toBe("22023");

    const taken = await signedUpWorker();
    const reuse = await admin.rpc("accept_worker_invite", {
      p_token: token,
      p_auth_user_id: taken.authUserId,
      p_pin_hash: PIN_HASH,
    });
    expect(reuse.error?.code).toBe("MLWI5");
  });

  it("a PIN reset keeps the login, clears the lock and ends every session", async () => {
    const worker = await signedUpWorker();
    await sessionFor(worker.id);
    await db.query(
      "update public.worker_credentials set failed_attempts = 5, locked_until = now() + interval '10 minutes' where worker_id = $1",
      [worker.id],
    );
    const sessions = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            "select count(*) as n from auth.sessions where user_id = $1",
            [worker.authUserId],
          )
        ).rows[0]!.n,
      );
    expect(await sessions()).toBeGreaterThan(0);

    const token = (await invite(worker.id)).token;
    const lookup = await admin.rpc("worker_invite_lookup", { p_token: token }).single();
    expect(lookup.data?.auth_user_id).toBe(worker.authUserId);
    const reset = await admin
      .rpc("accept_worker_invite", {
        p_token: token,
        p_auth_user_id: worker.authUserId,
        p_pin_hash: `s1$k1$${"C".repeat(22)}$${"D".repeat(43)}`,
      })
      .single();
    expect(reset.error).toBeNull();
    expect(reset.data?.pin_reset).toBe(true);
    expect(await sessions()).toBe(0);
    const { rows } = await db.query(
      "select failed_attempts, locked_until from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    expect(rows).toEqual([{ failed_attempts: 0, locked_until: null }]);
  });
});

describe("PIN sign-in counter", () => {
  it("returns the login and hash for a matching company code and staff ID, any case", async () => {
    const worker = await signedUpWorker();
    const started = await begin(worker.staffId.toLowerCase(), ipKey(), companyCode.toLowerCase());
    expect(started).toMatchObject({
      outcome: "proceed",
      worker_id: worker.id,
      organisation_id: owner.orgId,
      auth_user_id: worker.authUserId,
      pin_hash: PIN_HASH,
      locks_on_failure: false,
    });
    expect(await finish(worker.id, true)).toBe("signed_in");
  });

  it("locks on the 5th try in a row, audits the lock, and refuses until it ends", async () => {
    const worker = await signedUpWorker();
    for (let i = 1; i <= 4; i += 1) {
      expect(await begin(worker.staffId)).toMatchObject({
        outcome: "proceed",
        locks_on_failure: false,
      });
      expect(await finish(worker.id, false)).toBe("failed");
    }
    expect(await begin(worker.staffId)).toMatchObject({
      outcome: "proceed",
      locks_on_failure: true,
    });
    expect(await finish(worker.id, false)).toBe("locked");
    expect(await begin(worker.staffId)).toMatchObject({ outcome: "locked", pin_hash: null });

    const { rows: audit } = await db.query(
      "select action, after ->> 'failed_attempts' as attempts from public.audit_log where entity_id = $1 and action = 'worker_auth.locked'",
      [worker.id],
    );
    expect(audit).toEqual([{ action: "worker_auth.locked", attempts: "5" }]);

    const { rows } = await db.query<{ mins: number }>(
      "select (extract(epoch from locked_until - now()) / 60)::float8 as mins from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    expect(rows[0]!.mins).toBeGreaterThan(14);
    expect(rows[0]!.mins).toBeLessThanOrEqual(15);

    await db.query(
      "update public.worker_credentials set locked_until = now() - interval '1 second' where worker_id = $1",
      [worker.id],
    );
    expect(await begin(worker.staffId)).toMatchObject({
      outcome: "proceed",
      locks_on_failure: false,
    });
    const { rows: after } = await db.query(
      "select failed_attempts, locked_until from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    expect(after).toEqual([{ failed_attempts: 1, locked_until: null }]);
  });

  it("counts before the PIN is checked: parallel guesses cannot get past 5", async () => {
    const worker = await signedUpWorker();
    const results = await Promise.all(Array.from({ length: 12 }, () => begin(worker.staffId)));
    expect(results.filter((r) => r.outcome === "proceed")).toHaveLength(5);
    expect(results.filter((r) => r.outcome === "locked")).toHaveLength(7);
  });

  it("a success on the 5th try clears the count and the lock", async () => {
    const worker = await signedUpWorker();
    for (let i = 1; i <= 4; i += 1) {
      await begin(worker.staffId);
      await finish(worker.id, false);
    }
    expect((await begin(worker.staffId)).locks_on_failure).toBe(true);
    expect(await finish(worker.id, true)).toBe("signed_in");
    const { rows } = await db.query(
      "select failed_attempts, locked_until, last_sign_in_at is not null as signed_in from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    expect(rows).toEqual([{ failed_attempts: 0, locked_until: null, signed_in: true }]);
  });

  it("treats unknown IDs, workers without a login and ended workers like real ones", async () => {
    const noLogin = await addWorker();
    const ended = await signedUpWorker();
    await db.query(
      "update public.workers set status = 'ended', end_date = '2025-12-31' where id = $1",
      [ended.id],
    );
    for (const staffId of ["NOBODY-1", noLogin.staffId, ended.staffId]) {
      for (let i = 1; i <= 4; i += 1) {
        expect(await begin(staffId)).toEqual({
          outcome: "proceed",
          worker_id: null,
          organisation_id: null,
          auth_user_id: null,
          pin_hash: null,
          locks_on_failure: false,
          holds_on_failure: false,
          alert_organisation_id: null,
        });
        expect(await finish(null, false)).toBe("failed");
      }
      expect(await begin(staffId)).toMatchObject({ outcome: "proceed", locks_on_failure: true });
      expect(await begin(staffId)).toMatchObject({ outcome: "locked" });
    }
    expect(await begin("NOBODY-2", ipKey(), "ZZZZZZ")).toMatchObject({
      outcome: "proceed",
      worker_id: null,
    });
  });

  it("audits the login changing, not every sign-in try", async () => {
    const worker = await signedUpWorker();
    const { rows: creds } = await db.query<{ id: string }>(
      "select id from public.worker_credentials where worker_id = $1",
      [worker.id],
    );
    const credId = creds[0]!.id;
    const updates = async () =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.audit_log where entity_id = $1 and action = 'worker_credentials.update'",
          [credId],
        )
      ).rows[0]!.n;

    for (let i = 1; i <= 3; i += 1) {
      await begin(worker.staffId);
      await finish(worker.id, false);
    }
    await begin(worker.staffId);
    expect(await finish(worker.id, true)).toBe("signed_in");
    expect(await updates()).toBe(0);

    const token = (await invite(worker.id)).token;
    const reset = await admin.rpc("accept_worker_invite", {
      p_token: token,
      p_auth_user_id: worker.authUserId,
      p_pin_hash: `s1$k1$${"E".repeat(22)}$${"F".repeat(43)}`,
    });
    expect(reset.error).toBeNull();
    expect(await updates()).toBe(1);
  });

  it("cannot succeed for an unknown pair", async () => {
    const { error } = await admin.rpc("worker_sign_in_finish", {
      p_worker_id: null as unknown as string,
      p_ok: true,
      p_ip_key: ipKey(),
    });
    expect(error?.code).toBe("22023");
  });

  it("caps tries per network address at 100 in 15 minutes", async () => {
    const ip = ipKey();
    for (let i = 1; i <= 100; i += 1) {
      // A different code each time, so the per-company cap stays out of the way.
      // Wrong PINs per address have their own, lower cap (slice 1.11): cleared each time so
      // this checks the cap on all tries.
      await db.query("delete from private.auth_throttle where key = $1", [`ipwrong:${ip}`]);
      const r = await begin(`NET-${i}`, ip, `NET${i}`);
      expect(r.outcome, `try ${i}`).toBe("proceed");
    }
    expect((await begin("NET-101", ip)).outcome).toBe("ip_blocked");
    expect((await begin("NET-102", ipKey())).outcome).toBe("proceed");
    const { rows } = await db.query(
      "select count(*)::int as n from private.auth_throttle where key = $1",
      [`ip:${ip}`],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

describe("ending employment", () => {
  it("signs the worker out everywhere: sessions go and refresh tokens stop working", async () => {
    const worker = await signedUpWorker();
    const client = await sessionFor(worker.id);
    const { data } = await client.auth.getSession();
    const refreshToken = data.session!.refresh_token;
    const colleague = await signedUpWorker();
    const colleagueClient = await sessionFor(colleague.id);

    const { error } = await owner.client.rpc("end_employment", {
      p_organisation_id: owner.orgId,
      p_worker_id: worker.id,
      p_end_date: "2026-11-15",
    });
    expect(error).toBeNull();

    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from auth.sessions where user_id = $1",
      [worker.authUserId],
    );
    expect(rows).toEqual([{ n: 0 }]);
    const refreshed = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
    expect(refreshed.error).not.toBeNull();
    expect(refreshed.data.session).toBeNull();
    expect((await client.auth.getUser()).error).not.toBeNull();

    // Only the leaver is signed out.
    expect((await colleagueClient.auth.getUser()).error).toBeNull();
  });
});

describe("a worker's own session", () => {
  let me: Awaited<ReturnType<typeof signedUpWorker>>;
  let colleague: Awaited<ReturnType<typeof signedUpWorker>>;
  let client: Client;

  beforeAll(async () => {
    me = await signedUpWorker();
    colleague = await signedUpWorker();
    for (const w of [me, colleague]) {
      const { error } = await admin.from("pay_rates").insert({
        organisation_id: owner.orgId,
        worker_id: w.id,
        pay_type: "daily",
        daily_rate_kobo: 800_000,
        effective_from: "2025-01-06",
      });
      expect(error).toBeNull();
    }
    client = await sessionFor(me.id);
  });

  it("reads only its own worker row and pay", async () => {
    const workers = await client.from("workers").select("id");
    expect(workers.error).toBeNull();
    expect(workers.data).toEqual([{ id: me.id }]);
    const theirs = await client.from("workers").select("id").eq("id", colleague.id);
    expect(theirs.data).toEqual([]);
    const pay = await client.from("pay_rates").select("worker_id");
    expect(pay.data).toEqual([{ worker_id: me.id }]);
  });

  it("reads its own credentials, no invites, and no other memberships", async () => {
    const creds = await client.from("worker_credentials").select("worker_id");
    expect(creds.data).toEqual([{ worker_id: me.id }]);
    const invites = await client.from("worker_invites").select("id");
    expect(invites.data).toEqual([]);
    const members = await client.from("memberships").select("user_id, role");
    expect(members.data).toEqual([{ user_id: me.authUserId, role: "worker" }]);
    const audit = await client.from("audit_log").select("id");
    expect(audit.data).toEqual([]);
  });

  it("cannot invite anyone, write the log, or change its own worker row", async () => {
    const inv = await client.rpc("create_worker_invites", {
      p_organisation_id: owner.orgId,
      p_worker_ids: [colleague.id],
      p_sent_via: "print",
    });
    expect(inv.error?.code).toBe(PERMISSION_DENIED);
    const log = await client.rpc("log_audit", {
      p_organisation_id: owner.orgId,
      p_action: "worker_auth.fake",
      p_entity: "workers",
    });
    expect(log.error?.code).toBe(PERMISSION_DENIED);
    const update = await client
      .from("workers")
      .update({ first_name: "Hacked" })
      .eq("id", me.id)
      .select();
    expect(update.data ?? []).toEqual([]);
  });
});
