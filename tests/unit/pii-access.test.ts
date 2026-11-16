import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROLES, type Role } from "@/lib/roles";
import { PiiDecryptError, encryptPiiForDb } from "@/server/crypto/pii";
import {
  PII_FIELDS,
  PiiAccessError,
  canSeePii,
  revealPii,
  type PiiField,
} from "@/server/people/pii-access";
import type { Database } from "@/types/db";

const ORG = "a0000000-0000-4000-8000-000000000001";
const WORKER = "b0000000-0000-4000-8000-000000000002";
const NUBAN = "0123457712";

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
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

function fakeClient(result: { data: unknown; error: unknown } = { data: "audit-id", error: null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

describe("revealPii", () => {
  it("decrypts for a permitted role and audits the field, never the value", async () => {
    const { client, rpc } = fakeClient();
    const value = encryptPiiForDb(NUBAN);
    const plaintext = await revealPii({
      supabase: client,
      organisationId: ORG,
      role: "finance",
      field: "bank_account",
      entity: "workers",
      entityId: WORKER,
      value,
    });
    expect(plaintext).toBe(NUBAN);
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

  it("refuses a masked role before decrypting or auditing", async () => {
    const { client, rpc } = fakeClient();
    await expect(
      revealPii({
        supabase: client,
        organisationId: ORG,
        role: "finance",
        field: "nin",
        entity: "workers",
        entityId: WORKER,
        value: "\\xnot-even-hex",
      }),
    ).rejects.toBeInstanceOf(PiiAccessError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns nothing when no value is on file, without an audit row", async () => {
    const { client, rpc } = fakeClient();
    await expect(
      revealPii({
        supabase: client,
        organisationId: ORG,
        role: "hr",
        field: "rsa_pin",
        entity: "workers",
        entityId: WORKER,
        value: null,
      }),
    ).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("withholds the value when the audit row cannot be written", async () => {
    const { client } = fakeClient({ data: null, error: { message: "denied" } });
    await expect(
      revealPii({
        supabase: client,
        organisationId: ORG,
        role: "owner",
        field: "bank_account",
        entity: "workers",
        entityId: WORKER,
        value: encryptPiiForDb(NUBAN),
      }),
    ).rejects.toThrow(/audit/);
  });

  it("does not audit a value that fails its integrity check", async () => {
    const { client, rpc } = fakeClient();
    const value = encryptPiiForDb(NUBAN);
    const tampered = `${value.slice(0, -2)}${value.endsWith("00") ? "01" : "00"}`;
    await expect(
      revealPii({
        supabase: client,
        organisationId: ORG,
        role: "hr",
        field: "bank_account",
        entity: "workers",
        entityId: WORKER,
        value: tampered,
      }),
    ).rejects.toBeInstanceOf(PiiDecryptError);
    expect(rpc).not.toHaveBeenCalled();
  });
});
