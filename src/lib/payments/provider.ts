/**
 * Payment provider interface. Provider-neutral types only; adapters live next to this file and
 * callers (src/server/billing, src/server/payroll) use `getPaymentProvider()` from ./index.
 *
 * Rules this interface encodes:
 * - Money is integer kobo (`Kobo`, a bigint) plus a currency. Never a JS number (rule 1).
 * - Credentials are always the organisation's own (rule 6, no custody of funds). An adapter never
 *   reads provider keys from `process.env`; the caller loads them for the organisation.
 * - A webhook is a hint, never proof of payment (rule 7). Value is given only after
 *   `verifyWebhook()` passes on the raw body, `verifyTransaction()` re-fetches the transaction,
 *   and its status, amount, currency and txRef all match what we expect. Each transaction id is
 *   processed exactly once (unique index plus an idempotent handler, Phase 6).
 *
 * Phase 6 webhook route contract (read before building it):
 * - Find the organisation from the request URL, never from the body. Use an unguessable,
 *   per-organisation token in the path (for example `/api/webhooks/payments/[orgWebhookToken]`),
 *   looked up server-side. Anything in the body (tx_ref prefix, meta, customer) is unverified
 *   until `verifyWebhook()` passes, so reading the organisation from it would let a sender pick
 *   whose secret is checked.
 * - After `verifyTransaction()`, require that its txRef belongs to an invoice or payment link in
 *   that same organisation, and that amount and currency match that document.
 * - Value-giving idempotency is a unique index on (organisation_id, provider, transaction_id) on
 *   the payments table, keyed on `VerifiedTransaction.transactionId`. Never key it on
 *   `WebhookEvent.deliveryKey`: one transaction can arrive under more than one event name.
 * - Never log `WebhookEvent`, `VerifiedTransaction` or a raw body, and never attach them to
 *   Sentry. Store only `auditPayload`, which the adapter has already reduced to an allow-list of
 *   non-personal fields (rule 9).
 *
 * Open question for the owner (docs/PHASE_0.md Decisions names `FLUTTERWAVE_WEBHOOK_SECRET_HASH`):
 * this interface uses each organisation's own secret hash (rule 6). Until the owner records an
 * answer, treat the env var as being for Metalira's own subscription billing or a sandbox only,
 * never for tenant webhooks.
 */
import type { Currency, Kobo } from "@/lib/money";

/** One organisation's provider credentials. Loaded per organisation, never from env. */
export interface ProviderCredentials {
  publicKey: string;
  secretKey: string;
  encryptionKey: string;
  /** Shared secret the provider uses to sign or tag webhooks for this organisation. */
  webhookSecretHash: string;
}

/**
 * How a provider proves a webhook came from it. Chosen per organisation (or per provider API
 * version) and always passed explicitly: there is no default.
 *
 * - `hmac-sha256`: an HMAC-SHA256 of the raw body keyed with the secret hash. Preferred, because
 *   it binds the signature to this exact body.
 * - `static-hash`: the provider echoes the secret hash in a header. It does not cover the body,
 *   so a leaked or replayed hash passes for any body. Acceptable only because value is never
 *   given on a webhook alone (see `verifyTransaction()`).
 */
export type WebhookScheme = "hmac-sha256" | "static-hash";

/** Options for building one organisation's provider. */
export interface PaymentProviderOptions {
  webhookScheme: WebhookScheme;
}

/**
 * Provider payload reduced to an allow-list of non-personal fields (ids, reference, status,
 * amounts, currency, timestamps). Safe to store in `audit_log` or a payments table. Customer,
 * card and bank account objects are dropped by construction.
 */
export type ProviderAuditPayload = Readonly<Record<string, string | number | boolean | null>>;

export interface CreateVirtualAccountInput {
  orgId: string;
  clientId: string;
  /** Our unique reference for this account (idempotency key on the provider side). */
  reference: string;
  email: string;
  accountName: string;
  /** Required by some providers for permanent accounts. Encrypted at rest (rule 9). */
  bvn?: string;
  permanent: boolean;
  /** Fixed expected amount, for a one-off (temporary) account. */
  amountKobo?: Kobo;
  currency: Currency;
}

export interface VirtualAccount {
  accountNumber: string;
  bankName: string;
  providerRef: string;
  /** ISO 8601 timestamp; absent for permanent accounts. */
  expiresAt?: string;
}

export interface PaymentLinkCustomer {
  email: string;
  name: string;
  phone?: string;
}

export interface CreatePaymentLinkInput {
  txRef: string;
  amountKobo: Kobo;
  currency: Currency;
  customer: PaymentLinkCustomer;
  redirectUrl: string;
  description: string;
  meta?: Record<string, string>;
}

export interface PaymentLink {
  url: string;
  txRef: string;
}

export type VerifyTransactionInput = { transactionId: string } | { txRef: string };

export type TransactionStatus = "successful" | "failed" | "pending";

export interface VerifiedTransaction {
  transactionId: string;
  txRef: string;
  status: TransactionStatus;
  /** Amount the invoice or link asked for. */
  amountKobo: Kobo;
  /** Amount actually charged to the payer (may include fees borne by the payer). */
  chargedAmountKobo: Kobo;
  currency: Currency;
  /** ISO 8601 timestamp. */
  paidAt?: string;
  /**
   * Redacted provider response for the audit trail (allow-listed fields only). Never used for
   * decisions. The full response is never exposed: it carries customer email, phone and card or
   * account fragments (rule 9).
   */
  auditPayload: ProviderAuditPayload;
}

export interface TransferItem {
  /** Our unique reference per payee line (idempotency). */
  reference: string;
  bankCode: string;
  accountNumber: string;
  amountKobo: Kobo;
  currency: Currency;
  narration: string;
  beneficiaryName: string;
}

export interface CreateBulkTransferInput {
  reference: string;
  title: string;
  items: readonly TransferItem[];
}

export type BulkTransferStatus = "queued" | "processing" | "completed" | "failed";

export interface BulkTransfer {
  providerBatchId: string;
  status: BulkTransferStatus;
}

export type WebhookVerification =
  { ok: true } | { ok: false; reason: "missing_header" | "mismatch" | "not_configured" };

export type WebhookEventType = "charge.completed" | "transfer.completed" | "unknown";

/**
 * Parsed webhook payload. Deliberately carries no amount or status: the handler must re-fetch
 * with `verifyTransaction()` and decide from that (rule 7).
 */
export interface WebhookEvent {
  /**
   * Event type plus the provider's object id. For logging and for dropping repeat deliveries of
   * the same webhook only. It is NOT the money idempotency key: that is a unique index on
   * (organisation_id, provider, transactionId) taken from `verifyTransaction()`.
   */
  deliveryKey: string;
  type: WebhookEventType;
  /** Provider transaction id. Pass it to `verifyTransaction()`; trust nothing else in the body. */
  transactionId: string;
  txRef?: string;
  /** Redacted payload (allow-listed fields only), safe to store. Never log the raw body. */
  auditPayload: ProviderAuditPayload;
}

export interface PaymentProvider {
  /** Provider key, stored alongside provider references (e.g. on payout batches). */
  readonly name: string;
  createVirtualAccount(input: CreateVirtualAccountInput): Promise<VirtualAccount>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink>;
  verifyTransaction(input: VerifyTransactionInput): Promise<VerifiedTransaction>;
  createBulkTransfer(input: CreateBulkTransferInput): Promise<BulkTransfer>;
  getBulkTransfer(providerBatchId: string): Promise<BulkTransfer>;
  /**
   * Checks the webhook signature against this organisation's secret with this organisation's
   * `WebhookScheme`, in constant time, using the raw request body exactly as received (before
   * any JSON parsing). Passing it never gives value on its own (rule 7).
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
  /** Parses the raw body into a `WebhookEvent`. Throws `InvalidWebhookPayloadError`. */
  parseWebhookEvent(rawBody: string): WebhookEvent;
}

/** Thrown by adapter methods that are not built yet (network calls arrive in Phases 2 and 6). */
export class ProviderNotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} is not implemented yet`);
    this.name = "ProviderNotImplementedError";
  }
}

/** Thrown when a webhook body is not valid JSON or not the expected shape. */
export class InvalidWebhookPayloadError extends Error {
  constructor(message = "Webhook payload is not valid") {
    super(message);
    this.name = "InvalidWebhookPayloadError";
  }
}
