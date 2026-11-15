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
  /** Provider response as received, for the audit trail. Never used for decisions. */
  raw: unknown;
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
  /** Stable id for de-duplication, derived from the event type and the provider's object id. */
  eventId: string;
  type: WebhookEventType;
  transactionId?: string;
  txRef?: string;
  raw: unknown;
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
   * Checks the webhook signature against this organisation's secret, in constant time, using the
   * raw request body exactly as received (before any JSON parsing).
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
