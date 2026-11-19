/**
 * Monnify's "Validate Bank Account" (name enquiry) as a `BankAccountResolver` (slice 2.3b).
 *
 * Confirmed in Monnify's official docs on 19 Nov 2026:
 * - https://developers.monnify.com/docs/verification-api/verifying-your-customers
 *   "Name Enquiry": GET {base}/api/v2/disbursements/account/validate?accountNumber=..&bankCode=..
 *   with `Authorization: Bearer {access_token}`. Response:
 *   { requestSuccessful, responseMessage, responseCode: "0", responseBody: { accountNumber,
 *   accountName, bankCode, bankName } }. "The Name Enquiry API is free and available on both the
 *   Sandbox and Live environments." Errors: "Invalid account number", "Invalid bank code",
 *   "Account number could not be validated" (destination bank unavailable; retry later).
 * - https://developers.monnify.com/docs/collections/quickstart
 *   POST {base}/api/v1/auth/login with `Authorization: Basic base64(apiKey:secretKey)` returns
 *   { responseBody: { accessToken, expiresIn: 3600 } }. Tokens expire after 1 hour.
 *
 * Only Metalira's own credentials are used. The bearer token is kept in memory until shortly
 * before it expires (it is Metalira's, not a customer's); lookup answers are never cached.
 * Nothing here logs the account number, the returned name or a response body.
 */
import "server-only";

import {
  validResolveInput,
  type BankAccountResolver,
  type ResolveBankAccountResult,
} from "./bank-lookup";
import { MONNIFY_LIVE_BASE_URL, MONNIFY_SANDBOX_BASE_URL } from "./monnify";

export interface MonnifyLookupCredentials {
  apiKey: string;
  secretKey: string;
}

export interface MonnifyLookupOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Milliseconds per request. */
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Renew the token this long before Monnify says it expires. */
const TOKEN_MARGIN_MS = 60_000;

class LookupTimeout extends Error {
  override name = "LookupTimeout";
}

interface Envelope {
  requestSuccessful?: unknown;
  responseMessage?: unknown;
  responseCode?: unknown;
  responseBody?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maps Monnify's refusal text onto our errors. The message is read, never logged. */
function classifyRefusal(status: number, message: string): ResolveBankAccountResult {
  const text = message.toLowerCase();
  if (text.includes("bank code")) return { ok: false, error: "invalid_bank" };
  if (
    text.includes("invalid account") ||
    text.includes("account number is invalid") ||
    text.includes("not found") ||
    text.includes("does not exist")
  ) {
    return { ok: false, error: "not_found" };
  }
  if (status === 404) return { ok: false, error: "not_found" };
  return { ok: false, error: "unavailable" };
}

export function createMonnifyBankAccountResolver(
  creds: MonnifyLookupCredentials,
  opts: MonnifyLookupOptions = {},
): BankAccountResolver {
  const baseUrl = opts.baseUrl ?? MONNIFY_SANDBOX_BASE_URL;
  // Metalira's API key and secret go to this host: allow only Monnify's own.
  if (baseUrl !== MONNIFY_SANDBOX_BASE_URL && baseUrl !== MONNIFY_LIVE_BASE_URL) {
    throw new TypeError("Monnify bank lookup: baseUrl must be Monnify's sandbox or live host");
  }
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let token: { value: string; expiresAt: number } | null = null;

  async function call(url: string, init: RequestInit): Promise<{ status: number; json: Envelope }> {
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new LookupTimeout();
      }
      throw error;
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json: isRecord(json) ? json : {} };
  }

  async function accessToken(force: boolean): Promise<string | null> {
    if (!force && token && token.expiresAt > now()) return token.value;
    const basic = Buffer.from(`${creds.apiKey}:${creds.secretKey}`, "utf8").toString("base64");
    const { status, json } = await call(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    });
    const body = isRecord(json.responseBody) ? json.responseBody : {};
    const value = typeof body.accessToken === "string" ? body.accessToken : "";
    if (status !== 200 || json.requestSuccessful !== true || !value) {
      token = null;
      return null;
    }
    const seconds = typeof body.expiresIn === "number" ? body.expiresIn : 3600;
    token = { value, expiresAt: now() + Math.max(0, seconds * 1000 - TOKEN_MARGIN_MS) };
    return value;
  }

  async function validate(bankCode: string, accountNumber: string, bearer: string) {
    const query = new URLSearchParams({ accountNumber, bankCode });
    return call(`${baseUrl}/api/v2/disbursements/account/validate?${query.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
    });
  }

  return {
    source: "bank",
    async resolveBankAccount(input): Promise<ResolveBankAccountResult> {
      if (!validResolveInput(input)) return { ok: false, error: "not_found" };
      if (!creds.apiKey.trim() || !creds.secretKey.trim()) {
        return { ok: false, error: "not_configured" };
      }
      try {
        let bearer = await accessToken(false);
        if (!bearer) return { ok: false, error: "unavailable" };
        let result = await validate(input.bankCode, input.accountNumber, bearer);
        if (result.status === 401) {
          // The token was revoked or expired early: log in again once.
          bearer = await accessToken(true);
          if (!bearer) return { ok: false, error: "unavailable" };
          result = await validate(input.bankCode, input.accountNumber, bearer);
        }
        const { status, json } = result;
        const body = isRecord(json.responseBody) ? json.responseBody : {};
        const name = typeof body.accountName === "string" ? body.accountName.trim() : "";
        if (
          status === 200 &&
          json.requestSuccessful === true &&
          String(json.responseCode) === "0" &&
          name
        ) {
          // Only the name leaves this function; the response body is dropped.
          return { ok: true, accountName: name.replace(/\s+/g, " ").slice(0, 200), source: "bank" };
        }
        if (status >= 500 || status === 429 || status === 401 || status === 403) {
          return { ok: false, error: "unavailable" };
        }
        const message = typeof json.responseMessage === "string" ? json.responseMessage : "";
        return classifyRefusal(status, message);
      } catch (error) {
        if (error instanceof LookupTimeout) return { ok: false, error: "timeout" };
        return { ok: false, error: "unavailable" };
      }
    },
  };
}
