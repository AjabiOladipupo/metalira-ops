/**
 * Payment provider interface for **Metalira's own subscription billing only**. Provider-neutral
 * types; the adapter lives next to this file and callers use `getPaymentProvider()` from ./index.
 *
 * Who this is for (owner decision, 16 Nov 2026):
 * - Customer companies connect only their own bank account. Their clients pay invoices by bank
 *   transfer into it, collections are matched from imported bank statements, and payroll is a
 *   bank file the company uploads to its own bank. No customer money ever goes through this
 *   provider (rule 6).
 * - This provider collects the fees organisations pay Metalira for their subscription. The
 *   credentials are Metalira's own, loaded from server env under `src/server/` only (rule 2).
 *
 * Rules this interface encodes:
 * - Money is integer kobo (`Kobo`, a bigint) plus a currency. Never a JS number (rule 1).
 *
 * Phase 9 webhook route contract (read before building it, rule 7):
 * 1. Source IP: pass only the platform-set client IP (`ipAddress()` from `@vercel/functions` or
 *    `x-real-ip`) to `isTrustedWebhookSource()`. Never `x-forwarded-for`, and never reuse
 *    `clientIp()` from src/server/identity (it falls back to `x-forwarded-for`). Fail closed when
 *    not running on Vercel unless a test flag is set explicitly.
 * 2. `verifyWebhook()` on the raw body exactly as received. A webhook is a hint, never proof.
 * 3. Re-fetch with `verifyTransaction()` by the event's `transactionId`, and require the returned
 *    `transactionId` to equal it.
 * 4. Attribution: find the organisation and subscription invoice ONLY from our own reference on
 *    the re-fetched transaction (`txRef` for checkout, `accountReference` for a dedicated
 *    account), looked up server-side. Never from webhook body fields (customer email,
 *    description, payer account): the payer chooses those.
 * 5. Give value only when `status` is `successful` (Monnify `PAID` only) and `paidAmountKobo`
 *    and `currency` equal that invoice exactly. Overpaid, partly paid, reversed or any other
 *    status goes to manual review, never to automatic value.
 * 6. Exactly once: a unique index on (provider, transaction_id) keyed on
 *    `VerifiedTransaction.transactionId`, plus an idempotent handler. Never key it on
 *    `WebhookEvent.deliveryKey`.
 * 7. Never log `WebhookEvent`, `VerifiedTransaction` or a raw body, and never attach them to
 *    Sentry. Store only `auditPayload`, already reduced to non-personal fields (rule 9).
 */
import type { Currency, Kobo } from "@/lib/money";

/** Metalira's own provider credentials. Loaded server-side from env, never sent to a client. */
export interface ProviderCredentials {
  apiKey: string;
  /** Also the key the provider signs webhooks with. */
  secretKey: string;
  /** Merchant contract the collections settle under. */
  contractCode: string;
}

/** Options for building the provider. */
export interface PaymentProviderOptions {
  /** Sandbox or live API host. The adapter defaults to sandbox, so live is always explicit. */
  baseUrl?: string;
  /** Injected fetch for the network methods (tests). */
  fetch?: typeof fetch;
}

/**
 * Provider payload reduced to an allow-list of non-personal fields (references, status, amounts,
 * currency, timestamps). Safe to store in `audit_log` or a payments table. Customer, card and
 * bank account objects are dropped by construction.
 */
export type ProviderAuditPayload = Readonly<Record<string, string | number | boolean | null>>;

/** A dedicated account number one subscribing organisation pays its Metalira fees into. */
export interface CreateVirtualAccountInput {
  orgId: string;
  /** Our unique reference for this account (idempotency key on the provider side). */
  reference: string;
  email: string;
  accountName: string;
  /** Some providers require one for a dedicated account. Encrypted at rest (rule 9). */
  bvn?: string;
  currency: Currency;
}

export interface VirtualAccount {
  accountNumber: string;
  bankName: string;
  providerRef: string;
}

export interface PaymentLinkCustomer {
  email: string;
  name: string;
}

/** Hosted checkout for a subscription invoice. */
export interface CreatePaymentLinkInput {
  /** Our reference for this payment, unique per attempt. */
  txRef: string;
  amountKobo: Kobo;
  currency: Currency;
  customer: PaymentLinkCustomer;
  redirectUrl: string;
  description: string;
}

export interface PaymentLink {
  url: string;
  txRef: string;
}

/** Look a transaction up by the provider's reference or by ours. */
export type VerifyTransactionInput = { transactionId: string } | { txRef: string };

/**
 * `successful` means paid in full and nothing else (Monnify `PAID`). `needs_review` covers
 * overpaid, partly paid and reversed payments: never automatic value.
 */
export type TransactionStatus = "successful" | "needs_review" | "failed" | "pending";

export interface VerifiedTransaction {
  /** The provider's own reference for the transaction. The money idempotency key. */
  transactionId: string;
  /** Our reference for a hosted-checkout payment, as sent when the payment was set up. */
  txRef: string;
  /** Our reference for the dedicated account the payment arrived in, when it came that way. */
  accountReference?: string;
  status: TransactionStatus;
  /** Amount the invoice or link asked for. */
  amountKobo: Kobo;
  /** Amount the payer actually paid. */
  paidAmountKobo: Kobo;
  currency: Currency;
  /** ISO 8601 timestamp. */
  paidAt?: string;
  /**
   * Redacted provider response for the audit trail (allow-listed fields only). Never used for
   * decisions. The full response carries customer and account details (rule 9).
   */
  auditPayload: ProviderAuditPayload;
}

export type WebhookVerification =
  { ok: true } | { ok: false; reason: "missing_header" | "mismatch" | "not_configured" };

export type WebhookEventType = "payment.completed" | "unknown";

/**
 * Parsed webhook payload. Deliberately carries no amount or status: the handler must re-fetch
 * with `verifyTransaction()` and decide from that (rule 7).
 */
export interface WebhookEvent {
  /**
   * Event type plus the provider's transaction reference. For logging and for dropping repeat
   * deliveries only; NOT the money idempotency key (that is `VerifiedTransaction.transactionId`).
   */
  deliveryKey: string;
  type: WebhookEventType;
  /** Provider transaction reference. Pass it to `verifyTransaction()`; trust nothing else. */
  transactionId: string;
  txRef?: string;
  /** Redacted payload (allow-listed fields only), safe to store. Never log the raw body. */
  auditPayload: ProviderAuditPayload;
}

export interface PaymentProvider {
  /** Provider key, stored alongside provider references. */
  readonly name: string;
  createVirtualAccount(input: CreateVirtualAccountInput): Promise<VirtualAccount>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink>;
  verifyTransaction(input: VerifyTransactionInput): Promise<VerifiedTransaction>;
  /**
   * True only when `ip` is one of the provider's published webhook source addresses. The caller
   * passes the client IP as resolved by the platform (on Vercel, `x-real-ip`), never a value it
   * parsed out of a client-controlled list.
   */
  isTrustedWebhookSource(ip: string | null): boolean;
  /**
   * Checks the webhook signature with the secret key, in constant time, using the raw request
   * body exactly as received (before any JSON parsing). Passing it never gives value on its own.
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
  /** Parses the raw body into a `WebhookEvent`. Throws `InvalidWebhookPayloadError`. */
  parseWebhookEvent(rawBody: string): WebhookEvent;
}

/** Thrown by adapter methods that are not built yet (network calls arrive in Phase 9). */
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
