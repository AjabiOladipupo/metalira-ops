import { describe, expect, expectTypeOf, it } from "vitest";
import type { Kobo } from "@/lib/money";
import {
  getPaymentProvider,
  type CreatePaymentLinkInput,
  type PaymentProvider,
  type PaymentProviderOptions,
  type VerifiedTransaction,
  type WebhookEvent,
} from "@/lib/payments";

describe("payment provider types", () => {
  it("keeps every amount as bigint kobo, never number", () => {
    expectTypeOf<VerifiedTransaction["amountKobo"]>().toEqualTypeOf<Kobo>();
    expectTypeOf<VerifiedTransaction["paidAmountKobo"]>().toEqualTypeOf<bigint>();
    expectTypeOf<CreatePaymentLinkInput["amountKobo"]>().toEqualTypeOf<bigint>();
    expectTypeOf<CreatePaymentLinkInput["amountKobo"]>().not.toEqualTypeOf<number>();
  });

  it("builds the provider from Metalira's own credentials", () => {
    const provider = getPaymentProvider({ apiKey: "ak", secretKey: "sk", contractCode: "cc" });
    expectTypeOf(provider).toEqualTypeOf<PaymentProvider>();
    expect(typeof provider.verifyWebhook).toBe("function");
    expect(typeof provider.isTrustedWebhookSource).toBe("function");
    expectTypeOf(getPaymentProvider)
      .parameter(1)
      .toEqualTypeOf<PaymentProviderOptions | undefined>();
  });

  it("has no payout methods: customers pay staff from their own bank (rule 6)", () => {
    expectTypeOf<PaymentProvider>().not.toHaveProperty("createBulkTransfer");
    expectTypeOf<PaymentProvider>().not.toHaveProperty("getBulkTransfer");
  });

  it("keys money idempotency on the transaction, not the webhook delivery", () => {
    expectTypeOf<WebhookEvent["transactionId"]>().toEqualTypeOf<string>();
    expectTypeOf<WebhookEvent>().not.toHaveProperty("eventId");
    expectTypeOf<WebhookEvent>().not.toHaveProperty("raw");
    expectTypeOf<VerifiedTransaction>().not.toHaveProperty("raw");
  });
});
