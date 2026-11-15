/**
 * Entry point for payments. Server code (src/server/billing, src/server/payroll) imports from
 * here and never from an adapter file, so provider names stay inside src/lib/payments.
 */
import "server-only";
import { createFlutterwaveProvider } from "./flutterwave";
import type { PaymentProvider, ProviderCredentials } from "./provider";

export * from "./provider";

/** The payment provider for one organisation, built from that organisation's own credentials. */
export function getPaymentProvider(creds: ProviderCredentials): PaymentProvider {
  return createFlutterwaveProvider(creds);
}
