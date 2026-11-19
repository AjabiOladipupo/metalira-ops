/**
 * Entry point for payments. Server code imports from here and never from an adapter file, so
 * provider names stay inside src/lib/payments.
 *
 * Metalira's own subscription billing (rule 6: customers connect their bank account, not a
 * payment provider), and the account name lookup Metalira runs with its own provider account
 * (slice 2.3b; called only from src/server/billing/bank-lookup.ts).
 */
import "server-only";
import type { BankAccountResolver } from "./bank-lookup";
import { createMonnifyProvider } from "./monnify";
import { createMonnifyBankAccountResolver, type MonnifyLookupOptions } from "./monnify-bank-lookup";
import type { PaymentProvider, PaymentProviderOptions, ProviderCredentials } from "./provider";

export * from "./provider";
export * from "./bank-lookup";
export { createTestBankAccountResolver } from "./test-bank-lookup";

/** The payment provider, built from Metalira's own credentials (server env, src/server/ only). */
export function getPaymentProvider(
  creds: ProviderCredentials,
  opts: PaymentProviderOptions = {},
): PaymentProvider {
  return createMonnifyProvider(creds, opts);
}

/** The account name resolver, built from Metalira's own credentials (server env only). */
export function getBankAccountResolver(
  creds: Pick<ProviderCredentials, "apiKey" | "secretKey">,
  opts: MonnifyLookupOptions = {},
): BankAccountResolver {
  return createMonnifyBankAccountResolver(creds, opts);
}
