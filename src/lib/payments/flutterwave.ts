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
 * - Webhook: v3 sends the dashboard secret hash in the `verif-hash` header (plain equality).
 *   Newer APIs send `flutterwave-signature`, a base64 HMAC-SHA256 of the raw body keyed with the
 *   secret hash. Both schemes are behind `verifySignature()`; pick one in Phase 6.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { constantTimeEqual } from "@/lib/crypto/constant-time";
import { koboToMajorString, parseNairaToKobo, type Kobo } from "@/lib/money";
import {
  InvalidWebhookPayloadError,
  ProviderNotImplementedError,
  type PaymentProvider,
  type ProviderCredentials,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookVerification,
} from "./provider";

export const FLUTTERWAVE_V3_BASE_URL = "https://api.flutterwave.com/v3";

export type FlutterwaveWebhookScheme = "verif-hash" | "hmac-sha256";

export interface FlutterwaveOptions {
  /** Override for tests or a sandbox host. Defaults to the v3 API. */
  baseUrl?: string;
  /** Injected fetch for the Phase 2/6 network methods. Unused by the stub. */
  fetch?: typeof fetch;
  /** Webhook signature scheme. Defaults to v3 `verif-hash`. */
  webhookScheme?: FlutterwaveWebhookScheme;
}

const SIGNATURE_HEADER: Record<FlutterwaveWebhookScheme, string> = {
  "verif-hash": "verif-hash",
  "hmac-sha256": "flutterwave-signature",
};

/** v3 amounts are major units (naira) as decimal strings: 64231250n gives "642312.50". */
export function toFlutterwaveAmount(kobo: Kobo): string {
  return koboToMajorString(kobo);
}

/**
 * Converts a v3 major-unit amount (JSON number or string) to kobo without float maths.
 * Throws if it has more than two decimals or is not a plain decimal.
 */
export function fromFlutterwaveAmount(major: number | string): Kobo {
  return parseNairaToKobo(typeof major === "number" ? String(major) : major);
}

/** The one place the webhook scheme lives. Returns true when the header matches. */
function verifySignature(
  scheme: FlutterwaveWebhookScheme,
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
    eventId: `${event}:${transactionId}`,
    type,
    transactionId,
    ...(txRef ? { txRef } : {}),
    raw: json,
  };
}

/**
 * Builds a Flutterwave provider for one organisation. Credentials always come from the
 * organisation's own record (rule 6), never from `process.env`.
 */
export function createFlutterwaveProvider(
  creds: ProviderCredentials,
  opts: FlutterwaveOptions = {},
): PaymentProvider {
  const baseUrl = opts.baseUrl ?? FLUTTERWAVE_V3_BASE_URL;
  const scheme = opts.webhookScheme ?? "verif-hash";

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
