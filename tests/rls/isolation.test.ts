/**
 * Phase 0 acceptance test (slice 0.3): two organisations with one user each.
 * For every public table, neither user can select, insert, update or delete the
 * other's rows, and a blocked select returns zero rows. Positive controls make
 * sure the blocked results are not vacuous.
 *
 * Tables come from the per-module registry in tests/rls/tables/. A public table
 * without an entry fails the completeness guard.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRegistry } from "./helpers/registry";
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

const TABLES = await loadRegistry();

// The generic table loop needs an untyped client: table names come from the registry.
const untyped = (client: Client) => client as unknown as SupabaseClient;

const PERMISSION_DENIED = "42501";

let admin: Client;
let db: pg.Client;
const users: { a?: TenantUser; b?: TenantUser } = {};

function user(key: "a" | "b"): TenantUser {
  const found = users[key];
  if (!found) throw new Error(`user ${key} not set up`);
  return found;
}

async function readRow(table: string, key: string, value: string) {
  const { data, error } = await untyped(admin).from(table).select("*").eq(key, value);
  expect(error).toBeNull();
  return data ?? [];
}

async function countRows(table: string): Promise<number> {
  const { count, error } = await untyped(admin)
    .from(table)
    .select("*", { count: "exact", head: true });
  expect(error).toBeNull();
  return count ?? -1;
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  users.a = await createTenantUser("a", "Org A");
  users.b = await createTenantUser("b", "Org B");
  for (const spec of TABLES) {
    if (spec.seed) {
      await spec.seed({ admin, side: user("a") });
      await spec.seed({ admin, side: user("b") });
    }
  }
});

afterAll(async () => {
  await db?.end();
});

describe("registry completeness", () => {
  it("declares exactly the tables in schema public", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    const actual = rows.map((row) => row.tablename).sort();
    const declared = TABLES.map((spec) => spec.table).sort();
    expect(actual.length).toBeGreaterThan(0);
    expect(declared).toEqual(actual);
  });

  it("enables row-level security on every public table", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and not rowsecurity",
    );
    expect(rows).toEqual([]);
  });

  it("has no always-true policies", async () => {
    const { rows } = await db.query<{ policyname: string }>(
      `select policyname from pg_policies
       where schemaname = 'public'
         and (lower(btrim(qual)) = 'true' or lower(btrim(with_check)) = 'true')`,
    );
    expect(rows).toEqual([]);
  });

  it("gives every table organisation_id unless the registry says why not", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
       join pg_tables t on t.schemaname = c.table_schema and t.tablename = c.table_name
       where c.table_schema = 'public' and c.column_name = 'organisation_id'`,
    );
    const withOrg = new Set(rows.map((row) => row.table_name));
    for (const spec of TABLES) {
      if (withOrg.has(spec.table)) {
        expect(spec.noOrganisationIdReason, spec.table).toBeUndefined();
        expect(spec.tenantColumn, spec.table).toBe("organisation_id");
      } else {
        expect(spec.noOrganisationIdReason, spec.table).toBeTruthy();
      }
    }
  });

  it("keeps security-definer functions in schema private with an empty search_path", async () => {
    const { rows } = await db.query<{ schema: string; name: string; config: string[] | null }>(
      `select n.nspname as schema, p.proname as name, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public', 'private')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.schema, row.name).toBe("private");
      expect(row.config ?? [], row.name).toContain('search_path=""');
    }
  });

  it("grants anon nothing on public tables", async () => {
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee in ('anon', 'PUBLIC') and table_schema = 'public'`,
    );
    expect(rows).toEqual([]);
  });
});

describe.each(TABLES)("$table", (spec) => {
  it("positive control: each user sees their own row", async () => {
    for (const key of ["a", "b"] as const) {
      const me = user(key);
      const id = await spec.rowOf({ admin, side: me });
      const { data, error } = await untyped(me.client)
        .from(spec.table)
        .select("*")
        .eq(spec.key, id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    }
  });

  describe.each([
    { label: "A attacks B", attackerKey: "a" as const, victimKey: "b" as const },
    { label: "B attacks A", attackerKey: "b" as const, victimKey: "a" as const },
  ])("$label", ({ attackerKey, victimKey }) => {
    it("select by key returns zero rows", async () => {
      const attacker = user(attackerKey);
      const victimId = await spec.rowOf({ admin, side: user(victimKey) });
      const { data, error } = await untyped(attacker.client)
        .from(spec.table)
        .select("*")
        .eq(spec.key, victimId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("unfiltered select returns none of the victim's rows", async () => {
      const attacker = user(attackerKey);
      const victimValue = spec.tenantValue(user(victimKey));
      const { data, error } = await untyped(attacker.client).from(spec.table).select("*");
      expect(error).toBeNull();
      const rows = (data ?? []) as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((row) => row[spec.tenantColumn] === victimValue)).toEqual([]);
    });

    it("insert aimed at the victim is rejected", async () => {
      const attacker = user(attackerKey);
      const victim = user(victimKey);
      const before = await countRows(spec.table);
      const { error } = await untyped(attacker.client)
        .from(spec.table)
        .insert(spec.attackInsert({ admin, attacker, victim }));
      expect(error?.code).toBe(PERMISSION_DENIED);
      expect(await countRows(spec.table)).toBe(before);
    });

    it("update changes nothing", async () => {
      const attacker = user(attackerKey);
      const victimId = await spec.rowOf({ admin, side: user(victimKey) });
      const snapshot = await readRow(spec.table, spec.key, victimId);
      expect(snapshot).toHaveLength(1);

      const { data, error } = await untyped(attacker.client)
        .from(spec.table)
        .update(spec.patch)
        .eq(spec.key, victimId)
        .select();
      if (error) {
        expect(error.code).toBe(PERMISSION_DENIED);
      } else {
        expect(data).toEqual([]);
      }
      expect(await readRow(spec.table, spec.key, victimId)).toEqual(snapshot);
    });

    it("delete removes nothing", async () => {
      const attacker = user(attackerKey);
      const victimId = await spec.rowOf({ admin, side: user(victimKey) });
      const snapshot = await readRow(spec.table, spec.key, victimId);
      expect(snapshot).toHaveLength(1);

      const { data, error } = await untyped(attacker.client)
        .from(spec.table)
        .delete()
        .eq(spec.key, victimId)
        .select();
      if (error) {
        expect(error.code).toBe(PERMISSION_DENIED);
      } else {
        expect(data).toEqual([]);
      }
      expect(await readRow(spec.table, spec.key, victimId)).toEqual(snapshot);
    });
  });

  it("anonymous callers can read and write nothing", async () => {
    const anon = untyped(anonClient());
    const select = await anon.from(spec.table).select("*");
    if (select.error) {
      expect(select.error.code).toBe(PERMISSION_DENIED);
    } else {
      expect(select.data).toEqual([]);
    }
    const before = await countRows(spec.table);
    const insert = await anon
      .from(spec.table)
      .insert(spec.attackInsert({ admin, attacker: user("a"), victim: user("b") }));
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    expect(await countRows(spec.table)).toBe(before);
  });
});

describe("cross-tenant membership attacks", () => {
  it.each([
    {
      label: "A pulls B into A's organisation",
      attackerKey: "a" as const,
      victimKey: "b" as const,
    },
    {
      label: "B pulls A into B's organisation",
      attackerKey: "b" as const,
      victimKey: "a" as const,
    },
  ])("$label: a direct insert is rejected", async ({ attackerKey, victimKey }) => {
    const attacker = user(attackerKey);
    const victim = user(victimKey);
    const before = await countRows("memberships");
    const { error } = await attacker.client
      .from("memberships")
      .insert({ organisation_id: attacker.orgId, user_id: victim.id, role: "admin" });
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await countRows("memberships")).toBe(before);
    const { data } = await admin
      .from("memberships")
      .select("id")
      .eq("organisation_id", attacker.orgId)
      .eq("user_id", victim.id);
    expect(data).toEqual([]);
  });

  it("an owner cannot create invites for another organisation", async () => {
    const { data, error } = await user("a").client.rpc("create_membership_invite", {
      p_organisation_id: user("b").orgId,
      p_email: user("a").email,
      p_role: "owner",
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it("an invite for the victim's email cannot be accepted by the attacker", async () => {
    const a = user("a");
    const b = user("b");
    const { data: token, error } = await a.client.rpc("create_membership_invite", {
      p_organisation_id: a.orgId,
      p_email: b.email,
      p_role: "admin",
    });
    expect(error).toBeNull();
    const accept = await a.client.rpc("accept_membership_invite", { p_token: token! });
    expect(accept.error?.code).toBe(PERMISSION_DENIED);
    const { data } = await admin
      .from("memberships")
      .select("user_id")
      .eq("organisation_id", a.orgId);
    expect(data).toEqual([{ user_id: a.id }]);
  });

  // Slice 1.12: the team functions take an organisation id; none reaches the other company.
  it.each([
    { label: "A acts on B's team", attackerKey: "a" as const, victimKey: "b" as const },
    { label: "B acts on A's team", attackerKey: "b" as const, victimKey: "a" as const },
  ])("$label: list, role change, removal, resend and cancel are refused", async (keys) => {
    const attacker = user(keys.attackerKey);
    const victim = user(keys.victimKey);
    const { data: member } = await admin
      .from("memberships")
      .select("id")
      .eq("organisation_id", victim.orgId)
      .eq("user_id", victim.id)
      .single();
    const { data: invite } = await admin
      .from("membership_invites")
      .select("id, revoked_at, expires_at")
      .eq("organisation_id", victim.orgId)
      .limit(1)
      .single();
    for (const org of [victim.orgId, attacker.orgId]) {
      const calls = [
        attacker.client.rpc("team_members", { p_organisation_id: org }),
        attacker.client.rpc("change_member_role", {
          p_organisation_id: org,
          p_membership_id: member!.id,
          p_role: "hr",
        }),
        attacker.client.rpc("remove_member", {
          p_organisation_id: org,
          p_membership_id: member!.id,
        }),
        attacker.client.rpc("resend_membership_invite", {
          p_organisation_id: org,
          p_invite_id: invite!.id,
        }),
        attacker.client.rpc("revoke_membership_invite", {
          p_organisation_id: org,
          p_invite_id: invite!.id,
        }),
      ];
      const results = await Promise.all(calls);
      // team_members on the attacker's own company is allowed; it never lists the victim.
      const [list, ...writes] = results;
      if (org === victim.orgId) expect(list?.error?.code).toBe(PERMISSION_DENIED);
      else expect(JSON.stringify(list?.data)).not.toContain(victim.id);
      for (const write of writes) expect(write.error).not.toBeNull();
    }
    const { data: still } = await admin
      .from("memberships")
      .select("role")
      .eq("id", member!.id)
      .single();
    expect(still?.role).toBe("owner");
    const { data: inviteAfter } = await admin
      .from("membership_invites")
      .select("id, revoked_at, expires_at")
      .eq("id", invite!.id)
      .single();
    expect(inviteAfter).toEqual(invite);
  });
});

describe("anonymous RPC", () => {
  it("cannot create an organisation", async () => {
    const { data, error } = await anonClient().rpc("create_organisation", { p_name: "Anon Ltd" });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("cannot write to the audit log", async () => {
    const { error } = await anonClient().rpc("log_audit", {
      p_organisation_id: user("a").orgId,
      p_action: "test.event",
      p_entity: "organisations",
    });
    expect(error).not.toBeNull();
  });

  it("cannot create or accept invites", async () => {
    const create = await anonClient().rpc("create_membership_invite", {
      p_organisation_id: user("a").orgId,
      p_email: "anon@example.test",
      p_role: "owner",
    });
    expect(create.error).not.toBeNull();
    const accept = await anonClient().rpc("accept_membership_invite", {
      p_token: "0".repeat(64),
    });
    expect(accept.error).not.toBeNull();
  });
});

describe("audit_log is append-only for every role", () => {
  let rowId: string;
  let snapshot: Record<string, unknown>[];

  beforeAll(async () => {
    const { data, error } = await admin
      .from("audit_log")
      .select("id")
      .eq("organisation_id", user("a").orgId)
      .limit(1)
      .single();
    expect(error).toBeNull();
    rowId = data!.id;
    snapshot = await readRow("audit_log", "id", rowId);
    expect(snapshot).toHaveLength(1);
  });

  async function expectUnchanged() {
    expect(await readRow("audit_log", "id", rowId)).toEqual(snapshot);
  }

  it("the organisation's own owner cannot update or delete", async () => {
    const client = user("a").client;
    const update = await client
      .from("audit_log")
      .update({ action: "tampered" })
      .eq("id", rowId)
      .select();
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await client.from("audit_log").delete().eq("id", rowId).select();
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    await expectUnchanged();
  });

  it("the secret-key client cannot update or delete", async () => {
    const update = await admin
      .from("audit_log")
      .update({ action: "tampered" })
      .eq("id", rowId)
      .select();
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await admin.from("audit_log").delete().eq("id", rowId).select();
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    await expectUnchanged();
  });

  it("the table owner (postgres) cannot update, delete or truncate", async () => {
    await expect(
      db.query("update public.audit_log set action = 'tampered' where id = $1", [rowId]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query("delete from public.audit_log where id = $1", [rowId])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query("truncate public.audit_log")).rejects.toThrow(/append-only/);
    await expect(db.query("truncate public.audit_log cascade")).rejects.toThrow(/append-only/);
    await expectUnchanged();
  });

  it("service_role and authenticated hold no update, delete or truncate privilege", async () => {
    const { rows } = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'audit_log'
         and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`,
    );
    expect(rows).toEqual([]);
  });

  it("a member cannot insert directly, so actor_id and at cannot be forged", async () => {
    const a = user("a");
    const before = await countRows("audit_log");
    const forgedAt = await a.client.from("audit_log").insert({
      organisation_id: a.orgId,
      action: "test.forged",
      entity: "organisations",
      at: "2000-01-01T00:00:00Z",
    });
    expect(forgedAt.error?.code).toBe(PERMISSION_DENIED);
    const forgedActor = await a.client.from("audit_log").insert({
      organisation_id: a.orgId,
      action: "test.forged",
      entity: "organisations",
      actor_id: user("b").id,
    });
    expect(forgedActor.error?.code).toBe(PERMISSION_DENIED);
    const plain = await a.client.from("audit_log").insert({
      organisation_id: a.orgId,
      action: "test.forged",
      entity: "organisations",
    });
    expect(plain.error?.code).toBe(PERMISSION_DENIED);
    expect(await countRows("audit_log")).toBe(before);
  });

  it("log_audit takes the actor and time from the session, not the caller", async () => {
    const a = user("a");
    const started = Date.now();
    const { data: id, error } = await a.client.rpc("log_audit", {
      p_organisation_id: a.orgId,
      p_action: "test.event",
      p_entity: "organisations",
      p_entity_id: a.orgId,
      p_reason: "isolation test",
    });
    expect(error).toBeNull();
    const [row] = await readRow("audit_log", "id", id!);
    expect(row).toMatchObject({
      organisation_id: a.orgId,
      actor_id: a.id,
      action: "test.event",
      reason: "isolation test",
    });
    const at = new Date(row!.at as string).getTime();
    expect(Math.abs(at - started)).toBeLessThan(60_000);

    // There is no parameter for actor or time: PostgREST finds no such function.
    const forged = await untyped(a.client).rpc("log_audit", {
      p_organisation_id: a.orgId,
      p_action: "test.event",
      p_entity: "organisations",
      p_actor_id: user("b").id,
      p_at: "2000-01-01T00:00:00Z",
    });
    expect(forged.error).not.toBeNull();
  });

  it("log_audit rejects another organisation and trigger-style actions", async () => {
    const a = user("a");
    const before = await countRows("audit_log");
    const otherOrg = await a.client.rpc("log_audit", {
      p_organisation_id: user("b").orgId,
      p_action: "test.event",
      p_entity: "organisations",
    });
    expect(otherOrg.error?.code).toBe(PERMISSION_DENIED);
    const spoofed = await a.client.rpc("log_audit", {
      p_organisation_id: a.orgId,
      p_action: "organisations.update",
      p_entity: "organisations",
    });
    expect(spoofed.error?.code).toBe("22023");
    const malformed = await a.client.rpc("log_audit", {
      p_organisation_id: a.orgId,
      p_action: "Not An Action",
      p_entity: "organisations",
    });
    expect(malformed.error?.code).toBe("22023");
    expect(await countRows("audit_log")).toBe(before);
  });

  it("log_audit strips encrypted and hashed keys from before and after", async () => {
    const a = user("a");
    const { data: id, error } = await a.client.rpc("log_audit", {
      p_organisation_id: a.orgId,
      p_action: "test.redact",
      p_entity: "workers",
      p_before: { nin_enc: "cipher", name: "Ada", nested: { pin_hash: "h", kept: 1 } },
      p_after: { bank_account_enc: "cipher", token_hash: "t", list: [{ bvn_enc: "c", ok: true }] },
    });
    expect(error).toBeNull();
    const [row] = await readRow("audit_log", "id", id!);
    expect(row!.before).toEqual({ name: "Ada", nested: { kept: 1 } });
    expect(row!.after).toEqual({ list: [{ ok: true }] });
  });

  it("log_audit strips plain-text personal data keys at any depth", async () => {
    const a = user("a");
    const personal = {
      nin: "12345678901",
      bvn: "22222222222",
      rsa_pin: "PEN100000000001",
      rsaPin: "PEN100000000002",
      account_number: "0123456789",
      bankAccount: "0123456789",
      nuban: "0123456789",
      pin: "1234",
    };
    const { data: id, error } = await a.client.rpc("log_audit", {
      p_organisation_id: a.orgId,
      p_action: "pii.reveal",
      p_entity: "workers",
      p_before: { ...personal, name: "Ada", nested: { deeper: [{ ...personal, kept: 1 }] } },
      p_after: { shipping: 1, running_total: 2, tokens_used: 3 },
    });
    expect(error).toBeNull();
    const [row] = await readRow("audit_log", "id", id!);
    expect(row!.before).toEqual({ name: "Ada", nested: { deeper: [{ kept: 1 }] } });
    expect(row!.after).toEqual({ shipping: 1, running_total: 2, tokens_used: 3 });
  });
});

describe("audit_row_change trigger strips secret columns", () => {
  it("drops *_enc, pin_hash and token_hash from the logged row", async () => {
    const orgId = user("a").orgId;
    await db.query("begin");
    try {
      await db.query(
        `create table public.rls_tmp_redact (
           id uuid primary key default gen_random_uuid(),
           organisation_id uuid not null,
           name text, nin_enc text, pin_hash text, token_hash text)`,
      );
      await db.query(
        `create trigger rls_tmp_redact_audit after insert or update on public.rls_tmp_redact
         for each row execute function private.audit_row_change()`,
      );
      const inserted = await db.query<{ id: string }>(
        `insert into public.rls_tmp_redact (organisation_id, name, nin_enc, pin_hash, token_hash)
         values ($1, 'Ada', 'cipher', 'hash', 'token') returning id`,
        [orgId],
      );
      const rowId = inserted.rows[0]!.id;
      await db.query("update public.rls_tmp_redact set nin_enc = 'cipher2' where id = $1", [rowId]);
      await db.query("update public.rls_tmp_redact set name = 'Bola' where id = $1", [rowId]);

      const { rows } = await db.query<{ action: string; before: unknown; after: unknown }>(
        `select action, before, after from public.audit_log
         where entity = 'rls_tmp_redact' and entity_id = $1 order by at, action`,
        [rowId],
      );
      // The nin_enc-only update is invisible after redaction, so it is skipped.
      expect(rows.map((row) => row.action)).toEqual([
        "rls_tmp_redact.insert",
        "rls_tmp_redact.update",
      ]);
      expect(rows[0]!.after).toEqual({ id: rowId, organisation_id: orgId, name: "Ada" });
      expect(rows[1]!.before).toEqual({ id: rowId, organisation_id: orgId, name: "Ada" });
      expect(rows[1]!.after).toEqual({ id: rowId, organisation_id: orgId, name: "Bola" });
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/cipher|hash|token/);
    } finally {
      await db.query("rollback");
    }
  });
});

describe("roles inside one organisation (has_role)", () => {
  let worker: TestUser;
  let approver: TestUser;
  let lineManager: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    worker = await createTestUser("c-worker");
    approver = await createTestUser("c-approver");
    lineManager = await createTestUser("c-line-manager");
    outsider = await createTestUser("d-outsider");
    const { error } = await admin.from("memberships").insert([
      { organisation_id: user("a").orgId, user_id: worker.id, role: "worker" },
      { organisation_id: user("a").orgId, user_id: approver.id, role: "client_approver" },
      { organisation_id: user("a").orgId, user_id: lineManager.id, role: "line_manager" },
    ]);
    expect(error).toBeNull();
  });

  it.each([
    { label: "a worker", who: () => worker },
    { label: "a client approver", who: () => approver },
  ])("$label sees only their own membership and profile", async ({ who }) => {
    const me = who();
    const org = await me.client.from("organisations").select("id").eq("id", user("a").orgId);
    expect(org.data).toHaveLength(1);

    const memberships = await me.client.from("memberships").select("user_id");
    expect(memberships.error).toBeNull();
    expect(memberships.data).toEqual([{ user_id: me.id }]);

    const profiles = await me.client.from("profiles").select("user_id");
    expect(profiles.error).toBeNull();
    expect(profiles.data).toEqual([{ user_id: me.id }]);
  });

  it.each([
    { label: "a worker", who: () => worker },
    { label: "a client approver", who: () => approver },
  ])("$label cannot write to the audit log or invite people", async ({ who }) => {
    const me = who();
    const before = await countRows("audit_log");
    const event = await me.client.rpc("log_audit", {
      p_organisation_id: user("a").orgId,
      p_action: "payroll.release_approved",
      p_entity: "organisations",
    });
    expect(event.error?.code).toBe(PERMISSION_DENIED);
    expect(await countRows("audit_log")).toBe(before);

    const invite = await me.client.rpc("create_membership_invite", {
      p_organisation_id: user("a").orgId,
      p_email: outsider.email,
      p_role: "worker",
    });
    expect(invite.error?.code).toBe(PERMISSION_DENIED);
  });

  it("a manager sees co-members' memberships and profiles, but no one outside", async () => {
    const memberships = await lineManager.client.from("memberships").select("user_id");
    expect(memberships.error).toBeNull();
    const ids = (memberships.data ?? []).map((row) => row.user_id);
    expect(ids).toEqual(expect.arrayContaining([user("a").id, worker.id, approver.id]));
    expect(ids).not.toContain(user("b").id);

    const profile = await lineManager.client
      .from("profiles")
      .select("user_id")
      .eq("user_id", worker.id);
    expect(profile.data).toHaveLength(1);
    const notShared = await lineManager.client
      .from("profiles")
      .select("user_id")
      .eq("user_id", outsider.id);
    expect(notShared.data).toEqual([]);

    const event = await lineManager.client.rpc("log_audit", {
      p_organisation_id: user("a").orgId,
      p_action: "test.manager_event",
      p_entity: "organisations",
    });
    expect(event.error).toBeNull();
  });

  it("log_audit rejects before or after larger than 16 KB", async () => {
    const { error } = await user("a").client.rpc("log_audit", {
      p_organisation_id: user("a").orgId,
      p_action: "test.too_big",
      p_entity: "organisations",
      p_after: { blob: "x".repeat(17_000) },
    });
    expect(error?.code).toBe("22023");
  });

  it("a worker cannot update the organisation", async () => {
    const orgId = user("a").orgId;
    const snapshot = await readRow("organisations", "id", orgId);
    const { data, error } = await worker.client
      .from("organisations")
      .update({ name: "Worker Rename" })
      .eq("id", orgId)
      .select();
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await readRow("organisations", "id", orgId)).toEqual(snapshot);
  });

  it("a worker cannot add members", async () => {
    const { error } = await worker.client
      .from("memberships")
      .insert({ organisation_id: user("a").orgId, user_id: outsider.id, role: "worker" });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("a worker cannot read the audit log", async () => {
    const { data, error } = await worker.client
      .from("audit_log")
      .select("id")
      .eq("organisation_id", user("a").orgId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("a worker cannot promote themselves", async () => {
    const { data, error } = await worker.client
      .from("memberships")
      .update({ role: "owner" })
      .eq("user_id", worker.id)
      .select();
    if (error) {
      expect(error.code).toBe(PERMISSION_DENIED);
    } else {
      expect(data).toEqual([]);
    }
    const { data: row } = await admin
      .from("memberships")
      .select("role")
      .eq("user_id", worker.id)
      .single();
    expect(row?.role).toBe("worker");
  });

  it("a worker cannot change protected columns even on rows they can see", async () => {
    const { error } = await untyped(worker.client)
      .from("organisations")
      .update({ plan: "enterprise" })
      .eq("id", user("a").orgId);
    expect(error?.code).toBe(PERMISSION_DENIED);
  });
});
