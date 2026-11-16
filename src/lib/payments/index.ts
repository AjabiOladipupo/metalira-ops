/**
 * Entry point for payments. Server code imports from here and never from an adapter file, so
 * provider names stay inside src/lib/payments.
 *
 * Metalira's own subscription billing only (rule 6): customers connect their bank account, not a
 * payment provider.
 */
import "server-only";
import { createMonnifyProvider } from "./monnify";
import type { PaymentProvider, PaymentProviderOptions, ProviderCredentials } from "./provider";

export * from "./provider";

/** The payment provider, built from Metalira's own credentials (server env, src/server/ only). */
export function getPaymentProvider(
  creds: ProviderCredentials,
  opts: PaymentProviderOptions = {},
): PaymentProvider {
  return createMonnifyProvider(creds, opts);
}
