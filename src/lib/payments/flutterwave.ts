/**
 * Flutterwave adapter (stub). Phase 0 ships the shape only: no method here makes a network call.
 *
 * Built now:
 * - `verifyWebhook()`: signature check on the raw body against the organisation's own secret
 *   hash, compared in constant time.
 * - `parseWebhookEvent()`: pure shape parse of the webhook JSON (no amount, no status; rule 7).
 * - `toFlutterwaveAmount()` / `fromFlutterwaveAmount()`: v3 takes and returns major units.
 *
 * TODO(phase-2, phase-6): confirm each endpoint and the webhook scheme in Flutterwave's current
 * docs before building it (CLAUDE.md rule 7):
 * - POST /virtual-account-numbers                      createVirtualAccount (Phase 2)
 * - POST /payments                                     createPaymentLink (hosted checkout)
 * - GET  /transactions/{id}/verify                     verifyTransaction({ transactionId })
 * - GET  /transactions/verify_by_reference?tx_ref=     verifyTransaction({ txRef })
 * - POST /bulk-transfers                               createBulkTransfer (Phase 5 payouts)
 * - GET  /bulk-transfers/{id}                          getBulkTransfer
 * - Webhook: v3 sends the dashboard secret hash in the `verif-hash` header (plain equality,
 *   scheme `static-hash`). Newer APIs send `flutterwave-signature`, a base64 HMAC-SHA256 of the
 *   raw body keyed with the secret hash (scheme `hmac-sha256`). Both are behind
 *   `verifySignature()` and the caller must choose one; there is no default.
 *   TODO(phase-6): confirm Flutterwave's current scheme and prefer `hmac-sha256` on the raw body.
 *   Value must never be given on a `static-hash` check alone: always re-fetch with
 *   `verifyTransaction()` and match status, amount, currency and tx_ref first.
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
  type WebhookScheme,
  type WebhookVerification,
} from "./provider";

export const FLUTTERWAVE_V3_BASE_URL = "https://api.flutterwave.com/v3";

export interface FlutterwaveOptions extends PaymentProviderOptions {
  /** Override for tests or a sandbox host. Defaults to the v3 API. */
  baseUrl?: string;
  /** Injected fetch for the Phase 2/6 network methods. Unused by the stub. */
  fetch?: typeof fetch;
}

const SIGNATURE_HEADER: Record<WebhookScheme, string> = {
  "static-hash": "verif-hash",
  "hmac-sha256": "flutterwave-signature",
};

/** v3 amounts are major units (naira) as decimal strings: 64231250n gives "642312.50". */
export function toFlutterwaveAmount(kobo: Kobo): string {
  return koboToMajorString(kobo);
}

/** Provider amounts only: digits, optionally a point and one or two decimals. No sign, ₦ or commas. */
const PROVIDER_AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Converts a v3 major-unit amount to kobo without float maths. Strict: rejects negatives, signs,
 * currency symbols, commas, exponents, whitespace and more than two decimals.
 *
 * A JSON number is already a float by the time we see it. It is accepted only when it is finite
 * and its shortest decimal form passes the same check, which is exact for any realistic amount
 * and fails closed otherwise. TODO(phase-6): read amounts as strings where the API allows.
 */
export function fromFlutterwaveAmount(major: number | string): Kobo {
  if (typeof major === "number" && !Number.isFinite(major)) {
    throw new RangeError(`fromFlutterwaveAmount: ${major} is not a finite amount`);
  }
  const text = typeof major === "number" ? String(major) : major;
  const match = PROVIDER_AMOUNT.exec(text);
  if (!match) {
    throw new RangeError(`fromFlutterwaveAmount: "${text}" is not a provider amount`);
  }
  const [, whole = "", fraction = ""] = match;
  return BigInt(whole) * KOBO_PER_NAIRA + BigInt(fraction.padEnd(2, "0"));
}

/** Fields kept from a Flutterwave `data` object for the audit trail. Nothing personal. */
const AUDIT_FIELDS = [
  "id",
  "tx_ref",
  "flw_ref",
  "reference",
  "status",
  "amount",
  "charged_amount",
  "currency",
  "created_at",
] as const;

/**
 * Reduces a Flutterwave webhook or verify response to `ProviderAuditPayload`: the top-level
 * `event` plus allow-listed primitive fields of `data`. Customer, card, account and meta objects,
 * and any field not listed, are dropped.
 */
export function redactFlutterwavePayload(payload: unknown): ProviderAuditPayload {
  const out: Record<string, string | number | boolean | null> = {};
  if (typeof payload !== "object" || payload === null) return out;
  const { event, data } = payload as { event?: unknown; data?: unknown };
  if (typeof event === "string") out.event = event;
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

/** The one place the webhook scheme lives. Returns true when the header matches. */
function verifySignature(
  scheme: WebhookScheme,
  rawBody: string,
  headerValue: string,
  secretHash: string,
): boolean {
  if (scheme === "hmac-sha256") {
    const expected = createHmac("sha256", secretHash).update(rawBody, "utf8").digest("base64");
    return constantTimeEqual(headerValue, expected);
  }
  return constantTimeEqual(headerValue, secretHash);
}

const objectId = z.union([z.number().int().nonnegative(), z.string().min(1)]);

const webhookSchema = z.object({
  event: z.string().min(1),
  data: z.object({
    id: objectId,
    tx_ref: z.string().min(1).optional(),
    reference: z.string().min(1).optional(),
  }),
});

const KNOWN_EVENTS: readonly WebhookEventType[] = ["charge.completed", "transfer.completed"];

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
  const { event, data } = parsed.data;
  const type: WebhookEventType = (KNOWN_EVENTS as readonly string[]).includes(event)
    ? (event as WebhookEventType)
    : "unknown";
  const transactionId = String(data.id);
  const txRef = type === "transfer.completed" ? data.reference : data.tx_ref;
  return {
    deliveryKey: `${event}:${transactionId}`,
    type,
    transactionId,
    ...(txRef ? { txRef } : {}),
    auditPayload: redactFlutterwavePayload(json),
  };
}

/**
 * Builds a Flutterwave provider for one organisation. Credentials always come from the
 * organisation's own record (rule 6), never from `process.env`. The webhook scheme is required;
 * there is deliberately no default, so the weaker `static-hash` is never picked silently.
 */
export function createFlutterwaveProvider(
  creds: ProviderCredentials,
  opts: FlutterwaveOptions,
): PaymentProvider {
  const scheme = opts?.webhookScheme;
  if (!scheme || !Object.hasOwn(SIGNATURE_HEADER, scheme)) {
    throw new TypeError("createFlutterwaveProvider: webhookScheme is required");
  }
  const baseUrl = opts.baseUrl ?? FLUTTERWAVE_V3_BASE_URL;

  const notImplemented = (method: string, endpoint: string, phase: string) =>
    new ProviderNotImplementedError(`flutterwave.${method} (${endpoint} on ${baseUrl}, ${phase})`);

  return {
    name: "flutterwave",

    async createVirtualAccount() {
      throw notImplemented("createVirtualAccount", "POST /virtual-account-numbers", "Phase 2");
    },

    async createPaymentLink() {
      throw notImplemented("createPaymentLink", "POST /payments", "Phase 6");
    },

    async verifyTransaction(input) {
      const endpoint =
        "transactionId" in input
          ? "GET /transactions/{id}/verify"
          : "GET /transactions/verify_by_reference";
      throw notImplemented("verifyTransaction", endpoint, "Phase 6");
    },

    async createBulkTransfer() {
      throw notImplemented("createBulkTransfer", "POST /bulk-transfers", "Phase 5");
    },

    async getBulkTransfer() {
      throw notImplemented("getBulkTransfer", "GET /bulk-transfers/{id}", "Phase 5");
    },

    verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
      if (!creds.webhookSecretHash) return { ok: false, reason: "not_configured" };
      const headerValue = headers.get(SIGNATURE_HEADER[scheme]);
      if (!headerValue) return { ok: false, reason: "missing_header" };
      return verifySignature(scheme, rawBody, headerValue, creds.webhookSecretHash)
        ? { ok: true }
        : { ok: false, reason: "mismatch" };
    },

    parseWebhookEvent: parseEvent,
  };
}
