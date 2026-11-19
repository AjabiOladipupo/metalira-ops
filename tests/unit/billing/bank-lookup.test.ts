/**
 * Slice 2.3b: the server side of the account name lookup, with the provider and the secret-key
 * client mocked (no network, no database).
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matchCompanyName, matchPersonName } from "@/lib/bank-name-match";
import { createTestBankAccountResolver } from "@/lib/payments/test-bank-lookup";

const rpc = vi.fn();
vi.mock("@/server/supabase/admin", () => ({ createAdminSupabase: () => ({ rpc }) }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const {
  bankAccountDigest,
  digestMatches,
  isProductionLookupEnv,
  lookupMode,
  refuseCheckedRequest,
  runBankLookup,
  LOOKUP_MESSAGES,
} = await import("@/server/billing/bank-lookup");

const ORG = "a0000000-0000-4000-8000-000000000001";
const USER = "b0000000-0000-4000-8000-000000000002";
const LOOKUP = "c0000000-0000-4000-8000-000000000003";
const person = { kind: "person" as const, firstName: "John", lastName: "Adeyemi" };

beforeEach(() => {
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("MONNIFY_API_KEY", "");
  vi.stubEnv("MONNIFY_SECRET_KEY", "");
  vi.stubEnv("VERCEL_ENV", "preview");
  rpc.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("which resolver runs", () => {
  it("uses the provider when Metalira's keys are set, live by default only in production", () => {
    const keys = { MONNIFY_API_KEY: "k", MONNIFY_SECRET_KEY: "s" };
    expect(lookupMode({ ...keys, VERCEL_ENV: "production" })).toMatchObject({
      mode: "provider",
      baseUrl: "https://api.monnify.com",
    });
    expect(lookupMode({ ...keys, VERCEL_ENV: "preview" })).toMatchObject({
      mode: "provider",
      baseUrl: "https://sandbox.monnify.com",
    });
    expect(
      lookupMode({ ...keys, VERCEL_ENV: "preview", MONNIFY_BASE_URL: "https://api.monnify.com/" }),
    ).toMatchObject({ baseUrl: "https://api.monnify.com" });
  });

  it("uses the test resolver without keys outside production, and refuses in production", () => {
    expect(lookupMode({ VERCEL_ENV: "preview" })).toEqual({ mode: "test" });
    expect(lookupMode({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toEqual({ mode: "test" });
    expect(lookupMode({ VERCEL_ENV: "production" })).toEqual({ mode: "off" });
    expect(lookupMode({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual({ mode: "off" });
    // A local production build (the Playwright run) may opt in; Vercel production never can.
    expect(
      isProductionLookupEnv({
        NODE_ENV: "production",
        METALIRA_TEST_BANK_LOOKUP: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isProductionLookupEnv({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        METALIRA_TEST_BANK_LOOKUP: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("the account digest", () => {
  it("binds the number to the company and the bank, and compares in constant time", () => {
    const digest = bankAccountDigest(ORG, "058", "0123456789");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("0123456789");
    expect(digestMatches(ORG, "058", "0123456789", digest)).toBe(true);
    expect(digestMatches(ORG, "057", "0123456789", digest)).toBe(false);
    expect(digestMatches(ORG, "058", "0123456788", digest)).toBe(false);
    expect(digestMatches(USER, "058", "0123456789", digest)).toBe(false);
    expect(digestMatches(ORG, "058", "0123456789", "abc")).toBe(false);
  });
});

describe("runBankLookup", () => {
  const input = {
    organisationId: ORG,
    userId: USER,
    purpose: "worker_bank" as const,
    workerId: null,
    bankCode: "058",
    accountNumber: "0123456781",
    expected: person,
  };

  it("records the lookup with a digest only, and returns the name and the match", async () => {
    rpc.mockResolvedValueOnce({ data: LOOKUP, error: null }).mockResolvedValueOnce({ error: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runBankLookup(input);
    expect(result).toEqual({
      ok: true,
      lookupId: LOOKUP,
      bankCode: "058",
      bankName: "GTBank (Guaranty Trust Bank)",
      accountName: "ADEYEMI JOHN",
      test: true,
      result: "match",
      expected: "John Adeyemi",
    });
    const [begin, finish] = rpc.mock.calls;
    expect(begin![0]).toBe("begin_bank_account_lookup");
    expect(begin![1]).toMatchObject({
      p_organisation_id: ORG,
      p_user_id: USER,
      p_purpose: "worker_bank",
      p_bank_code: "058",
      p_bank_account_last4: "6781",
    });
    expect(JSON.stringify(begin)).not.toContain("0123456781");
    expect(finish).toEqual([
      "finish_bank_account_lookup",
      { p_id: LOOKUP, p_status: "resolved", p_account_name: "ADEYEMI JOHN", p_source: "test" },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it("passes on the hourly limits", async () => {
    const message = "You have checked 30 bank accounts in the last hour. Try again later.";
    rpc.mockResolvedValueOnce({ data: null, error: { code: "MLBL1", message } });
    await expect(runBankLookup(input)).resolves.toEqual({ ok: false, message });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("asks to retry when the bank doesn't answer, and logs the kind only", async () => {
    rpc.mockResolvedValueOnce({ data: LOOKUP, error: null }).mockResolvedValueOnce({ error: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runBankLookup({ ...input, accountNumber: "0000000000" });
    expect(result).toEqual({ ok: false, message: LOOKUP_MESSAGES.timeout });
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_status: "failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("0000000000");
  });

  it("says when the bank has no such account", async () => {
    rpc.mockResolvedValueOnce({ data: LOOKUP, error: null }).mockResolvedValueOnce({ error: null });
    await expect(runBankLookup({ ...input, accountNumber: "0123456789" })).resolves.toEqual({
      ok: false,
      message: LOOKUP_MESSAGES.not_found,
      field: "bankAccountNumber",
    });
  });

  it("refuses in production without keys, before recording anything", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(runBankLookup(input)).resolves.toEqual({
      ok: false,
      message: LOOKUP_MESSAGES.not_configured,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a bank that isn't in the list", async () => {
    await expect(runBankLookup({ ...input, bankCode: "999" })).resolves.toMatchObject({
      ok: false,
      field: "bankCode",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("refuseCheckedRequest (on approval)", () => {
  const number = "0123456781";
  const stored = (
    accountName: string,
    nameCheck: "match" | "near" | "not_checked" | null,
    reason: string | null = null,
  ) => ({
    bank_code: nameCheck === "match" || nameCheck === "near" ? "058" : null,
    bank_lookup_id: nameCheck === "match" || nameCheck === "near" ? LOOKUP : null,
    bank_account_digest:
      nameCheck === "match" || nameCheck === "near" ? bankAccountDigest(ORG, "058", number) : null,
    name_check: nameCheck,
    name_check_reason: reason,
    account_name: accountName,
  });

  it("lets a match through, and requests without a check", () => {
    expect(refuseCheckedRequest(ORG, stored("ADEYEMI JOHN", "match"), number, person)).toBeNull();
    expect(refuseCheckedRequest(ORG, stored("Anything", "not_checked"), number, person)).toBeNull();
    expect(refuseCheckedRequest(ORG, stored("Anything", null), number, person)).toBeNull();
  });

  it("refuses a number other than the one checked", () => {
    expect(
      refuseCheckedRequest(ORG, stored("ADEYEMI JOHN", "match"), "0123456782", person),
    ).toMatch(/isn't the one the bank checked/);
  });

  it("refuses when the employee's name no longer matches, or a close match has no reason", () => {
    const renamed = { kind: "person" as const, firstName: "Mary", lastName: "Okafor" };
    expect(refuseCheckedRequest(ORG, stored("ADEYEMI JOHN", "match"), number, renamed)).toMatch(
      /doesn't match Mary Okafor/,
    );
    expect(refuseCheckedRequest(ORG, stored("ADEYEMI J", "match"), number, person)).toMatch(
      /no reason/,
    );
    expect(
      refuseCheckedRequest(
        ORG,
        stored("ADEYEMI J", "near", "First initial only on the account"),
        number,
        person,
      ),
    ).toBeNull();
  });
});

describe("the test resolver's answers compare as labelled", () => {
  const resolver = createTestBankAccountResolver();
  const company = ["Adebayo Facility Services Ltd", "Shield Ltd", "Bank Test Ltd"];

  it.each([
    ["1", "match"],
    ["7", "near"],
    ["8", "no_match"],
  ])("last digit %s gives %s for people and companies", async (digit, expected) => {
    for (const p of [
      person,
      { kind: "person" as const, firstName: "Chidinma", lastName: "Okafor" },
    ]) {
      const r = await resolver.resolveBankAccount({
        bankCode: "058",
        accountNumber: `012345678${digit}`,
        expectedNames: p,
      });
      expect(r.ok && matchPersonName(r.accountName, p).result).toBe(expected);
    }
    for (const name of company) {
      const r = await resolver.resolveBankAccount({
        bankCode: "058",
        accountNumber: `012345678${digit}`,
        expectedNames: { kind: "company", names: [name] },
      });
      expect(r.ok && matchCompanyName(r.accountName, [name]).result).toBe(expected);
    }
  });
});
