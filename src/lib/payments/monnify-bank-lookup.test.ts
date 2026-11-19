// Kept next to the adapter so provider names stay inside src/lib/payments. No network: every
// call goes to an injected fetch, and the global fetch is watched to prove it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMonnifyBankAccountResolver } from "./monnify-bank-lookup";
import { MONNIFY_LIVE_BASE_URL, MONNIFY_SANDBOX_BASE_URL } from "./monnify";
import { TEST_LOOKUP_OTHER_PERSON, createTestBankAccountResolver } from "./test-bank-lookup";

const creds = { apiKey: "MK_TEST_METALIRA", secretKey: "metalira-test-secret" };
const input = { bankCode: "058", accountNumber: "0123456789" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const LOGIN_OK = json(200, {
  requestSuccessful: true,
  responseMessage: "success",
  responseCode: "0",
  responseBody: { accessToken: "token-1", expiresIn: 3600 },
});

const VALIDATE_OK = json(200, {
  requestSuccessful: true,
  responseMessage: "success",
  responseCode: "0",
  responseBody: {
    accountNumber: "0123456789",
    accountName: "  ADEYEMI  JOHN OLUWASEUN ",
    bankCode: "058",
    bankName: "GTBank",
  },
});

let globalFetch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalFetch = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Monnify account name lookup", () => {
  it("logs in with Basic apiKey:secretKey, then validates with the bearer token", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(LOGIN_OK.clone())
      .mockResolvedValueOnce(VALIDATE_OK.clone());
    const resolver = createMonnifyBankAccountResolver(creds, { fetch });
    await expect(resolver.resolveBankAccount(input)).resolves.toEqual({
      ok: true,
      accountName: "ADEYEMI JOHN OLUWASEUN",
      source: "bank",
    });

    const [loginUrl, loginInit] = fetch.mock.calls[0]!;
    expect(loginUrl).toBe(`${MONNIFY_SANDBOX_BASE_URL}/api/v1/auth/login`);
    expect(loginInit?.method).toBe("POST");
    const basic = Buffer.from(`${creds.apiKey}:${creds.secretKey}`).toString("base64");
    expect((loginInit?.headers as Record<string, string>).Authorization).toBe(`Basic ${basic}`);

    const [validateUrl, validateInit] = fetch.mock.calls[1]!;
    expect(validateUrl).toBe(
      `${MONNIFY_SANDBOX_BASE_URL}/api/v2/disbursements/account/validate?accountNumber=0123456789&bankCode=058`,
    );
    expect(validateInit?.method).toBe("GET");
    expect((validateInit?.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    expect(validateInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reuses the token until it nearly expires, then logs in again", async () => {
    let now = 0;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(LOGIN_OK.clone())
      .mockResolvedValueOnce(VALIDATE_OK.clone())
      .mockResolvedValueOnce(VALIDATE_OK.clone())
      .mockResolvedValueOnce(LOGIN_OK.clone())
      .mockResolvedValueOnce(VALIDATE_OK.clone());
    const resolver = createMonnifyBankAccountResolver(creds, { fetch, now: () => now });
    await resolver.resolveBankAccount(input);
    now = 30 * 60_000;
    await resolver.resolveBankAccount(input);
    expect(fetch).toHaveBeenCalledTimes(3);
    now = 60 * 60_000;
    await resolver.resolveBankAccount(input);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(String(fetch.mock.calls[3]![0])).toContain("/api/v1/auth/login");
  });

  it("logs in again once when the token is refused", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(LOGIN_OK.clone())
      .mockResolvedValueOnce(json(401, { requestSuccessful: false }))
      .mockResolvedValueOnce(LOGIN_OK.clone())
      .mockResolvedValueOnce(VALIDATE_OK.clone());
    const resolver = createMonnifyBankAccountResolver(creds, { fetch });
    await expect(resolver.resolveBankAccount(input)).resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["Invalid account number", 400, "not_found"],
    ["Invalid bank code", 400, "invalid_bank"],
    ["Account number could not be validated", 400, "unavailable"],
    ["Internal error", 500, "unavailable"],
    ["Too many requests", 429, "unavailable"],
  ])("maps %j (%i) to %s", async (message, status, error) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(LOGIN_OK.clone())
      .mockResolvedValueOnce(
        json(status, { requestSuccessful: false, responseMessage: message, responseCode: "99" }),
      );
    const resolver = createMonnifyBankAccountResolver(creds, { fetch });
    await expect(resolver.resolveBankAccount(input)).resolves.toEqual({ ok: false, error });
  });

  it("gives a timeout when the provider doesn't answer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const resolver = createMonnifyBankAccountResolver(creds, { fetch });
    await expect(resolver.resolveBankAccount(input)).resolves.toEqual({
      ok: false,
      error: "timeout",
    });
  });

  it("is unavailable when the login fails or the network errors", async () => {
    const refused = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(401, { requestSuccessful: false }));
    await expect(
      createMonnifyBankAccountResolver(creds, { fetch: refused }).resolveBankAccount(input),
    ).resolves.toEqual({ ok: false, error: "unavailable" });
    const broken = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      createMonnifyBankAccountResolver(creds, { fetch: broken }).resolveBankAccount(input),
    ).resolves.toEqual({ ok: false, error: "unavailable" });
  });

  it("never calls out for bad input or missing keys", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolver = createMonnifyBankAccountResolver(creds, { fetch });
    await expect(
      resolver.resolveBankAccount({ bankCode: "058", accountNumber: "123" }),
    ).resolves.toEqual({ ok: false, error: "not_found" });
    await expect(
      createMonnifyBankAccountResolver({ apiKey: "", secretKey: "" }, { fetch }).resolveBankAccount(
        input,
      ),
    ).resolves.toEqual({ ok: false, error: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends Metalira's keys to Monnify's own hosts only", () => {
    expect(() =>
      createMonnifyBankAccountResolver(creds, { baseUrl: MONNIFY_LIVE_BASE_URL }),
    ).not.toThrow();
    for (const baseUrl of ["https://evil.example", "http://api.monnify.com"]) {
      expect(() => createMonnifyBankAccountResolver(creds, { baseUrl })).toThrow(TypeError);
    }
  });
});

describe("the test resolver", () => {
  const resolver = createTestBankAccountResolver();
  const person = { kind: "person" as const, firstName: "John", lastName: "Adeyemi" };
  const company = { kind: "company" as const, names: ["Adebayo Facility Services Ltd"] };

  it("chooses the answer by the last digit, labelled as a test", async () => {
    await expect(
      resolver.resolveBankAccount({
        bankCode: "058",
        accountNumber: "0123456781",
        expectedNames: person,
      }),
    ).resolves.toEqual({ ok: true, accountName: "ADEYEMI JOHN", source: "test" });
    await expect(
      resolver.resolveBankAccount({
        bankCode: "058",
        accountNumber: "0123456787",
        expectedNames: person,
      }),
    ).resolves.toMatchObject({ accountName: "ADEYEMI J" });
    await expect(
      resolver.resolveBankAccount({
        bankCode: "058",
        accountNumber: "0123456788",
        expectedNames: person,
      }),
    ).resolves.toMatchObject({ accountName: TEST_LOOKUP_OTHER_PERSON });
    await expect(
      resolver.resolveBankAccount({ bankCode: "058", accountNumber: "0123456789" }),
    ).resolves.toEqual({ ok: false, error: "not_found" });
    await expect(
      resolver.resolveBankAccount({ bankCode: "058", accountNumber: "0000000000" }),
    ).resolves.toEqual({ ok: false, error: "timeout" });
  });

  it("prints a company's name as a bank would", async () => {
    await expect(
      resolver.resolveBankAccount({
        bankCode: "058",
        accountNumber: "0123454410",
        expectedNames: company,
      }),
    ).resolves.toMatchObject({ accountName: "ADEBAYO FACILITY SERVICES LIMITED" });
    await expect(
      resolver.resolveBankAccount({
        bankCode: "058",
        accountNumber: "0123454417",
        expectedNames: company,
      }),
    ).resolves.toMatchObject({ accountName: "ADEBAY FACILITY SERVICES LIMITED" });
  });
});
