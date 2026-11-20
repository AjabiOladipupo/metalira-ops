/**
 * Slice 2.3b: "Check" in the employee forms and "Check bank details" on the person page, with
 * the session, the user's client and the secret-key client mocked (no network, no database).
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "a0000000-0000-4000-8000-000000000001";
const USER = "b0000000-0000-4000-8000-000000000002";
const WORKER = "c0000000-0000-4000-8000-000000000003";
const LOOKUP = "d0000000-0000-4000-8000-000000000004";

const session = { current: null as null | { role: string } };
vi.mock("@/server/identity/session", () => ({
  getSession: async () =>
    session.current
      ? {
          user: { id: USER },
          active: { organisationId: ORG, role: session.current.role },
        }
      : null,
}));

const adminRpc = vi.fn();
vi.mock("@/server/supabase/admin", () => ({ createAdminSupabase: () => ({ rpc: adminRpc }) }));

const userRpc = vi.fn(async () => ({ data: "audit-id", error: null }));
const workerRow = { current: null as Record<string, unknown> | null };
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    rpc: userRpc,
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: workerRow.current, error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const { sealPii } = await import("@/server/crypto/pii");
const { bankAccountContext } = await import("@/server/people/bank-changes");
const { checkWorkerBankDetails, lookupWorkerBankAccount } =
  await import("@/server/people/bank-lookups");

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("MONNIFY_API_KEY", "");
  vi.stubEnv("MONNIFY_SECRET_KEY", "");
  session.current = { role: "hr" };
  adminRpc.mockReset();
  adminRpc
    .mockResolvedValueOnce({ data: LOOKUP, error: null })
    .mockResolvedValue({ data: true, error: null });
  userRpc.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lookupWorkerBankAccount", () => {
  it("compares with the names typed for a new employee", async () => {
    const result = await lookupWorkerBankAccount({
      firstName: "Chidinma",
      lastName: "Okafor",
      bankCode: "999992",
      bankAccountNumber: "8012345671",
    });
    expect(result).toMatchObject({
      ok: true,
      lookupId: LOOKUP,
      accountName: "OKAFOR CHIDINMA",
      result: "match",
      bankName: "OPay",
    });
    expect(adminRpc.mock.calls[0]![1]).toMatchObject({ p_purpose: "worker_bank", p_user_id: USER });
  });

  it("needs the names before checking a new employee's account", async () => {
    const result = await lookupWorkerBankAccount({
      bankCode: "058",
      bankAccountNumber: "0123456781",
    });
    expect(result).toMatchObject({ ok: false });
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("is for owner, admin and HR only", async () => {
    session.current = { role: "finance" };
    const result = await lookupWorkerBankAccount({
      firstName: "A",
      lastName: "B",
      bankCode: "058",
      bankAccountNumber: "0123456781",
    });
    expect(result).toEqual({
      ok: false,
      message: "Only an owner, an admin or HR can check bank details.",
    });
    expect(adminRpc).not.toHaveBeenCalled();
  });
});

describe("checkWorkerBankDetails", () => {
  it("looks up the number on file, never returns it, and audits the check", async () => {
    const number = "0123457712";
    workerRow.current = {
      first_name: "Musa",
      last_name: "Ibrahim",
      bank_account_enc: sealPii(number, bankAccountContext(ORG, WORKER)).enc,
    };
    const result = await checkWorkerBankDetails({ workerId: WORKER, bankCode: "058" });
    expect(result).toMatchObject({
      ok: true,
      accountName: "IBRAHIM MUSA",
      result: "match",
      lookupId: "",
    });
    expect(JSON.stringify(result)).not.toContain(number);
    expect(adminRpc.mock.calls[0]![1]).toMatchObject({
      p_purpose: "worker_check",
      p_worker_id: WORKER,
      p_bank_account_last4: "7712",
    });
    expect(userRpc).toHaveBeenCalledWith(
      "log_audit",
      expect.objectContaining({
        p_action: "people.bank_details_checked",
        p_entity: "workers",
        p_entity_id: WORKER,
      }),
    );
    expect(JSON.stringify(userRpc.mock.calls)).not.toContain(number);
  });

  it("says so when there is no account on file or it can't be read", async () => {
    workerRow.current = { first_name: "Musa", last_name: "Ibrahim", bank_account_enc: null };
    await expect(
      checkWorkerBankDetails({ workerId: WORKER, bankCode: "058" }),
    ).resolves.toMatchObject({
      ok: false,
      message: "This employee has no bank account on file to check.",
    });
    workerRow.current = {
      first_name: "Musa",
      last_name: "Ibrahim",
      bank_account_enc: sealPii("0123457712", bankAccountContext(ORG, LOOKUP)).enc,
    };
    await expect(
      checkWorkerBankDetails({ workerId: WORKER, bankCode: "058" }),
    ).resolves.toMatchObject({
      ok: false,
      message: "The account number on file can't be read, so it can't be checked.",
    });
    expect(adminRpc).not.toHaveBeenCalled();
  });
});
