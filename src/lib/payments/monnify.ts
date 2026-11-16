/**
 * Monnify adapter (stub) for Metalira's own subscription billing. No method here makes a network
 * call yet; customer money never goes through it (see ./provider.ts and CLAUDE.md rule 6).
 *
 * Built now:
 * - `verifyWebhook()`: `monnify-signature` is a hex HMAC-SHA512 of the raw body keyed with the
 *   secret key, compared in constant time.
 * - `isTrustedWebhookSource()`: Monnify's published webhook IP allow-list (rule 7). Exact match
 *   on a plain IPv4 address; an IPv4-mapped IPv6 form is rejected (fails closed).
 * - Monnify's own sample code hashes `JSON.stringify(parsedBody)`. We hash the raw body; confirm
 *   with a captured sandbox delivery in Phase 9, and never "fix" a mismatch by re-serialising.
 * - `parseWebhookEvent()`: pure shape parse of the webhook JSON (no amount, no status; rule 7).
 * - `toMonnifyAmount()` / `fromMonnifyAmount()`: Monnify takes and returns major units (naira).
 *
 * TODO(phase-9): confirm each endpoint, the signature scheme and the IP list in Monnify's
 * current docs (developers.monnify.com) before building on them:
 * - POST /api/v1/auth/login                         Basic base64(apiKey:secretKey) -> bearer token
 * - POST /api/v2/bank-transfer/reserved-accounts    createVirtualAccount (needs contractCode)
 * - POST /api/v1/merchant/transactions/init-transaction   createPaymentLink (checkoutUrl)
 * - GET  /api/v2/transactions/{transactionReference}      verifyTransaction({ transactionId })
 * - GET  /api/v2/merchant/transactions/query?paymentReference=   verifyTransaction({ txRef })
 */
import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { constantTimeEqual } from "@/lib/crypto/constant-time";
import { koboToMajorString, KOBO_PER_NAIRA, type Kobo } from "@/lib/money";
import {
  InvalidWebhookPayloadError,
  ProviderNotImplementedError,
  type PaymentProvider,
  type PaymentProviderOptions,
  type ProviderAuditPayload,
  type ProviderCredentials,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookVerification,
} from "./provider";

export const MONNIFY_SANDBOX_BASE_URL = "https://sandbox.monnify.com";
export const MONNIFY_LIVE_BASE_URL = "https://api.monnify.com";

/** Header Monnify sends the webhook signature in. */
export const MONNIFY_SIGNATURE_HEADER = "monnify-signature";

/** Monnify's published webhook source address(es). TODO(phase-9): confirm the current list. */
export const MONNIFY_WEBHOOK_IPS: readonly string[] = ["35.242.133.146"];

/** Monnify amounts are major units (naira): 64231250n gives "642312.50". Positive only. */
export function toMonnifyAmount(kobo: Kobo): string {
  if (kobo <= 0n) throw new RangeError(`toMonnifyAmount: ${kobo} is not a positive amount`);
  return koboToMajorString(kobo);
}

/**
 * Largest JSON number accepted. Below 1e13 naira (15 significant digits with kobo) a double's
 * shortest decimal form is exact, so the string check below cannot be fooled by rounding.
 */
const MAX_NUMERIC_MAJOR = 1e13;

/** Provider amounts only: digits, optionally a point and one or two decimals. No sign, ₦ or commas. */
const PROVIDER_AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Converts a Monnify major-unit amount to kobo without float maths. Strict: rejects negatives,
 * signs, currency symbols, commas, exponents, whitespace and more than two decimals.
 *
 * A JSON number is already a float by the time we see it. It is accepted only when it is finite
 * below `MAX_NUMERIC_MAJOR` and its shortest decimal form passes the same check, which is exact
 * in that range. TODO(phase-9): read amounts from the raw JSON text instead of numbers.
 */
export function fromMonnifyAmount(major: number | string): Kobo {
  if (
    typeof major === "number" &&
    !(Number.isFinite(major) && Math.abs(major) < MAX_NUMERIC_MAJOR)
  ) {
    throw new RangeError(`fromMonnifyAmount: ${major} is not a finite amount in range`);
  }
  const text = typeof major === "number" ? String(major) : major;
  const match = PROVIDER_AMOUNT.exec(text);
  if (!match) {
    throw new RangeError(`fromMonnifyAmount: "${text}" is not a provider amount`);
  }
  const [, whole = "", fraction = ""] = match;
  return BigInt(whole) * KOBO_PER_NAIRA + BigInt(fraction.padEnd(2, "0"));
}

/** Fields kept from a Monnify `eventData` or `responseBody` for the audit trail. Nothing personal. */
const AUDIT_FIELDS = [
  "transactionReference",
  "paymentReference",
  "paymentStatus",
  "amountPaid",
  "totalPayable",
  "settlementAmount",
  "currency",
  "currencyCode",
  "paidOn",
  "paymentMethod",
] as const;

/**
 * Reduces a Monnify webhook (`eventType` + `eventData`) or API response (`responseBody`) to
 * `ProviderAuditPayload`: the event type plus allow-listed primitive fields. Customer, account,
 * card, product and settlement objects, and any field not listed, are dropped.
 */
export function redactMonnifyPayload(payload: unknown): ProviderAuditPayload {
  const out: Record<string, string | number | boolean | null> = {};
  if (typeof payload !== "object" || payload === null) return out;
  const { eventType, eventData, responseBody } = payload as {
    eventType?: unknown;
    eventData?: unknown;
    responseBody?: unknown;
  };
  if (typeof eventType === "string") out.eventType = eventType;
  const data = "eventData" in payload ? eventData : responseBody;
  if (typeof data !== "object" || data === null) return out;
  const record = data as Record<string, unknown>;
  for (const field of AUDIT_FIELDS) {
    const value = record[field];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      out[field] = value;
    }
  }
  return out;
}

const HEX_SHA512 = /^[0-9a-f]{128}$/;

/** True when `headerValue` is the hex HMAC-SHA512 of the exact raw body under `secretKey`. */
function verifySignature(rawBody: string, headerValue: string, secretKey: string): boolean {
  const expected = createHmac("sha512", secretKey).update(rawBody, "utf8").digest("hex");
  // Hex case carries no meaning; normalise so an upper-case digest still compares equal.
  const provided = headerValue.trim().toLowerCase();
  return HEX_SHA512.test(provided) && constantTimeEqual(provided, expected);
}

/** Provider references: bounded, and only characters that are safe in logs and URL paths. */
const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9|_.-]+$/);

const webhookSchema = z.object({
  eventType: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z_]+$/),
  eventData: z.object({
    transactionReference: reference,
    paymentReference: reference.optional(),
  }),
});

const EVENT_TYPES: Readonly<Record<string, WebhookEventType>> = {
  SUCCESSFUL_TRANSACTION: "payment.completed",
};

function parseEvent(rawBody: string): WebhookEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new InvalidWebhookPayloadError("Webhook payload is not valid JSON");
  }
  const parsed = webhookSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidWebhookPayloadError("Webhook payload does not have the expected shape");
  }
  const { eventType, eventData } = parsed.data;
  const type: WebhookEventType = Object.hasOwn(EVENT_TYPES, eventType)
    ? (EVENT_TYPES[eventType] ?? "unknown")
    : "unknown";
  const transactionId = eventData.transactionReference;
  return {
    deliveryKey: `${eventType}:${transactionId}`,
    type,
    transactionId,
    ...(eventData.paymentReference ? { txRef: eventData.paymentReference } : {}),
    auditPayload: redactMonnifyPayload(json),
  };
}

/**
 * Builds the Monnify provider from Metalira's own credentials (server env, `src/server/` only).
 * Defaults to the sandbox host, so reaching live always needs an explicit `baseUrl`.
 */
export function createMonnifyProvider(
  creds: ProviderCredentials,
  opts: PaymentProviderOptions = {},
): PaymentProvider {
  const baseUrl = opts.baseUrl ?? MONNIFY_SANDBOX_BASE_URL;
  // Phase 9 sends Metalira's API key and secret to this host: allow only Monnify's own.
  if (baseUrl !== MONNIFY_SANDBOX_BASE_URL && baseUrl !== MONNIFY_LIVE_BASE_URL) {
    throw new TypeError("createMonnifyProvider: baseUrl must be Monnify's sandbox or live host");
  }

  const notImplemented = (method: string, endpoint: string) =>
    new ProviderNotImplementedError(`monnify.${method} (${endpoint} on ${baseUrl}, Phase 9)`);

  return {
    name: "monnify",

    async createVirtualAccount() {
      throw notImplemented("createVirtualAccount", "POST /api/v2/bank-transfer/reserved-accounts");
    },

    async createPaymentLink() {
      throw notImplemented(
        "createPaymentLink",
        "POST /api/v1/merchant/transactions/init-transaction",
      );
    },

    async verifyTransaction(input) {
      const endpoint =
        "transactionId" in input
          ? "GET /api/v2/transactions/{transactionReference}"
          : "GET /api/v2/merchant/transactions/query";
      throw notImplemented("verifyTransaction", endpoint);
    },

    isTrustedWebhookSource(ip: string | null): boolean {
      if (!ip) return false;
      return MONNIFY_WEBHOOK_IPS.includes(ip.trim());
    },

    verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
      if (!creds.secretKey.trim()) return { ok: false, reason: "not_configured" };
      const headerValue = headers.get(MONNIFY_SIGNATURE_HEADER);
      if (!headerValue) return { ok: false, reason: "missing_header" };
      return verifySignature(rawBody, headerValue, creds.secretKey)
        ? { ok: true }
        : { ok: false, reason: "mismatch" };
    },

    parseWebhookEvent: parseEvent,
  };
}
