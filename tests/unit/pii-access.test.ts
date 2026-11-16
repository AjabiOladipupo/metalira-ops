import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { ROLES, type Role } from "@/lib/roles";
import { PiiDecryptError, encryptPiiForDb, type PiiContext } from "@/server/crypto/pii";
import type { Session } from "@/server/identity/session";
import {
  PII_FIELDS,
  PiiAccessError,
  PiiRecordNotFoundError,
  canSeePii,
  revealPii,
  type PiiField,
} from "@/server/people/pii-access";

const { getSession, createServerSupabase } = vi.hoisted(() => ({
  getSession: vi.fn(),
  createServerSupabase: vi.fn(),
}));
vi.mock("@/server/identity/session", () => ({ getSession }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const OTHER_ORG = "a0000000-0000-4000-8000-000000000009";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const OTHER_WORKER = "b0000000-0000-4000-8000-000000000003";
const CHANGE = "c0000000-0000-4000-8000-000000000004";
const NUBAN = "0123457712";
const NIN = "12345678901";

const ctx = (column: string, rowId = WORKER, table = "workers"): PiiContext => ({
  organisationId: ORG,
  table,
  column,
  rowId,
});

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** Owner decision 7, written out in full so a change to the rule shows up here. */
const EXPECTED: Record<Role, Record<PiiField, boolean>> = {
  owner: { nin: true, bank_account: true, rsa_pin: true },
  hr: { nin: true, bank_account: true, rsa_pin: true },
  finance: { nin: false, bank_account: true, rsa_pin: false },
  admin: { nin: false, bank_account: false, rsa_pin: false },
  ops_manager: { nin: false, bank_account: false, rsa_pin: false },
  line_manager: { nin: false, bank_account: false, rsa_pin: false },
  worker: { nin: false, bank_account: false, rsa_pin: false },
  client_approver: { nin: false, bank_account: false, rsa_pin: false },
};

describe("canSeePii", () => {
  it("matches the role matrix for every role and field", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      for (const field of PII_FIELDS) {
        expect({ role, field, allowed: canSeePii(role, field) }).toEqual({
          role,
          field,
          allowed: EXPECTED[role][field],
        });
      }
    }
  });

  it("masks for a role it does not know", () => {
    expect(canSeePii("auditor" as Role, "bank_account")).toBe(false);
  });
});

/** Signs in a user with one membership per entry. */
function signIn(memberships: { organisationId: string; role: Role }[] | null) {
  const session: Session | null = memberships && {
    user: { id: "u1", email: "u1@example.test", fullName: null },
    memberships: memberships.map((m) => ({ ...m, organisationName: "Org" })),
    managerMemberships: [],
    active: null,
  };
  getSession.mockResolvedValue(session);
}

/**
 * A fake RLS client: `from(...).select(...).eq(...).eq(...).maybeSingle()` returns `row`, and
 * `rpc("log_audit")` returns `audit`. Records the query so tests can check what was read.
 */
function fakeClient(
  row: { data: unknown; error: unknown },
  audit: { data: unknown; error: unknown } = { data: "audit-id", error: null },
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(row),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const from = vi.fn().mockReturnValue(query);
  const rpc = vi.fn().mockResolvedValue(audit);
  createServerSupabase.mockResolvedValue({ from, rpc });
  return { from, rpc, query };
}

describe("revealPii", () => {
  it("decrypts the session role's field from the named row and audits it, never the value", async () => {
    signIn([{ organisationId: ORG, role: "finance" }]);
    const value = encryptPiiForDb(NUBAN, ctx("bank_account_enc"));
    const { from, rpc, query } = fakeClient({ data: { bank_account_enc: value }, error: null });

    const plaintext = await revealPii({
      organisationId: ORG,
      field: "bank_account",
      entity: "workers",
      entityId: WORKER,
    });

    expect(plaintext).toBe(NUBAN);
    expect(from).toHaveBeenCalledWith("workers");
    expect(query.select).toHaveBeenCalledWith("bank_account_enc");
    expect(query.eq).toHaveBeenCalledWith("id", WORKER);
    expect(query.eq).toHaveBeenCalledWith("organisation_id", ORG);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("log_audit", {
      p_organisation_id: ORG,
      p_action: "pii.reveal",
      p_entity: "workers",
      p_entity_id: WORKER,
      p_before: undefined,
      p_after: { field: "bank_account" },
      p_reason: undefined,
    });
    const sent = JSON.stringify(rpc.mock.calls);
    expect(sent).not.toContain(NUBAN);
    expect(sent).not.toContain(value.slice(2));
  });

  it("reads a bank-detail change's account under its destination, the worker's column", async () => {
    signIn([{ organisationId: ORG, role: "hr" }]);
    // Slice 1.7: the request holds the number encrypted for workers.bank_account_enc of its
    // worker, so the database can apply it when the hold ends without a key.
    const value = encryptPiiForDb(NUBAN, ctx("bank_account_enc", WORKER));
    const { from, rpc, query } = fakeClient({
      data: { bank_account_enc: value, worker_id: WORKER },
      error: null,
    });

    await expect(
      revealPii({
        organisationId: ORG,
        field: "bank_account",
        entity: "bank_detail_changes",
        entityId: CHANGE,
        reason: "Checking before approval",
      }),
    ).resolves.toBe(NUBAN);
    expect(from).toHaveBeenCalledWith("bank_detail_changes");
    expect(query.select).toHaveBeenCalledWith("bank_account_enc, worker_id");
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_entity: "bank_detail_changes",
      p_entity_id: CHANGE,
      p_reason: "Checking before approval",
    });
  });

  it("refuses a bank-detail change whose number was encrypted for another worker", async () => {
    signIn([{ organisationId: ORG, role: "hr" }]);
    const spliced = encryptPiiForDb(NUBAN, ctx("bank_account_enc", OTHER_WORKER));
    const { rpc } = fakeClient({
      data: { bank_account_enc: spliced, worker_id: WORKER },
      error: null,
    });

    await expect(
      revealPii({
        organisationId: ORG,
        field: "bank_account",
        entity: "bank_detail_changes",
        entityId: CHANGE,
      }),
    ).rejects.toBeInstanceOf(PiiDecryptError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a NIN spliced into the bank account column, without auditing", async () => {
    signIn([{ organisationId: ORG, role: "finance" }]);
    const spliced = encryptPiiForDb(NIN, ctx("nin_enc"));
    const { rpc } = fakeClient({ data: { bank_account_enc: spliced }, error: null });

    await expect(
      revealPii({
        organisationId: ORG,
        field: "bank_account",
        entity: "workers",
        entityId: WORKER,
      }),
    ).rejects.toBeInstanceOf(PiiDecryptError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a value copied from another worker's row", async () => {
    signIn([{ organisationId: ORG, role: "owner" }]);
    const copied = encryptPiiForDb(NUBAN, ctx("bank_account_enc", OTHER_WORKER));
    const { rpc } = fakeClient({ data: { bank_account_enc: copied }, error: null });

    await expect(
      revealPii({
        organisationId: ORG,
        field: "bank_account",
        entity: "workers",
        entityId: WORKER,
      }),
    ).rejects.toBeInstanceOf(PiiDecryptError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("takes the role from the session, ignoring any role the caller sends", async () => {
    signIn([{ organisationId: ORG, role: "finance" }]);
    const { from, rpc } = fakeClient({ data: null, error: null });
    const input = {
      organisationId: ORG,
      field: "nin",
      entity: "workers",
      entityId: WORKER,
      role: "owner",
    } as Parameters<typeof revealPii>[0];

    await expect(revealPii(input)).rejects.toBeInstanceOf(PiiAccessError);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses when the user's permitted role is in a different organisation", async () => {
    signIn([
      { organisationId: OTHER_ORG, role: "owner" },
      { organisationId: ORG, role: "admin" },
    ]);
    const { from } = fakeClient({ data: null, error: null });

    await expect(
      revealPii({ organisationId: ORG, field: "nin", entity: "workers", entityId: WORKER }),
    ).rejects.toBeInstanceOf(PiiAccessError);
    expect(from).not.toHaveBeenCalled();
  });

  it("refuses a user with no membership, or no session", async () => {
    const { from } = fakeClient({ data: null, error: null });
    const input = {
      organisationId: ORG,
      field: "nin",
      entity: "workers",
      entityId: WORKER,
    } as const;

    signIn([{ organisationId: OTHER_ORG, role: "owner" }]);
    await expect(revealPii(input)).rejects.toBeInstanceOf(PiiAccessError);
    signIn(null);
    await expect(revealPii(input)).rejects.toBeInstanceOf(PiiAccessError);
    expect(from).not.toHaveBeenCalled();
  });

  it("fails when the record is not visible in that organisation", async () => {
    signIn([{ organisationId: ORG, role: "hr" }]);
    const { rpc } = fakeClient({ data: null, error: null });

    await expect(
      revealPii({ organisationId: ORG, field: "nin", entity: "workers", entityId: WORKER }),
    ).rejects.toBeInstanceOf(PiiRecordNotFoundError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails when the read itself fails", async () => {
    signIn([{ organisationId: ORG, role: "hr" }]);
    const { rpc } = fakeClient({ data: null, error: { message: "boom" } });

    await expect(
      revealPii({ organisationId: ORG, field: "nin", entity: "workers", entityId: WORKER }),
    ).rejects.toThrow(/Could not read the record/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns nothing when no value is on file, without an audit row", async () => {
    signIn([{ organisationId: ORG, role: "hr" }]);
    const { rpc } = fakeClient({ data: { rsa_pin_enc: null }, error: null });

    await expect(
      revealPii({ organisationId: ORG, field: "rsa_pin", entity: "workers", entityId: WORKER }),
    ).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("withholds the value when the audit row cannot be written", async () => {
    signIn([{ organisationId: ORG, role: "owner" }]);
    const value = encryptPiiForDb(NUBAN, ctx("bank_account_enc"));
    fakeClient(
      { data: { bank_account_enc: value }, error: null },
      { data: null, error: { message: "denied" } },
    );

    await expect(
      revealPii({
        organisationId: ORG,
        field: "bank_account",
        entity: "workers",
        entityId: WORKER,
      }),
    ).rejects.toThrow(/audit/);
  });

  it("validates its input before touching the session or the database", async () => {
    signIn([{ organisationId: ORG, role: "owner" }]);
    const { from } = fakeClient({ data: null, error: null });
    const bad = [
      { organisationId: ORG, field: "nin", entity: "bank_detail_changes", entityId: CHANGE },
      { organisationId: ORG, field: "nin", entity: "workers", entityId: "1 or 1=1" },
      { organisationId: "x", field: "nin", entity: "workers", entityId: WORKER },
      { organisationId: ORG, field: "bvn", entity: "workers", entityId: WORKER },
      { organisationId: ORG, field: "nin", entity: "memberships", entityId: WORKER },
    ];
    for (const input of bad) {
      await expect(revealPii(input as Parameters<typeof revealPii>[0])).rejects.toBeInstanceOf(
        ZodError,
      );
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});
