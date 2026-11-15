import { describe, expect, expectTypeOf, it } from "vitest";
import type { Kobo } from "@/lib/money";
import {
  getPaymentProvider,
  type CreatePaymentLinkInput,
  type CreateVirtualAccountInput,
  type PaymentProvider,
  type PaymentProviderOptions,
  type TransferItem,
  type VerifiedTransaction,
  type WebhookEvent,
} from "@/lib/payments";

describe("payment provider types", () => {
  it("keeps every amount as bigint kobo, never number", () => {
    expectTypeOf<VerifiedTransaction["amountKobo"]>().toEqualTypeOf<Kobo>();
    expectTypeOf<VerifiedTransaction["chargedAmountKobo"]>().toEqualTypeOf<bigint>();
    expectTypeOf<TransferItem["amountKobo"]>().toEqualTypeOf<bigint>();
    expectTypeOf<CreatePaymentLinkInput["amountKobo"]>().toEqualTypeOf<bigint>();
    expectTypeOf<CreateVirtualAccountInput["amountKobo"]>().toEqualTypeOf<bigint | undefined>();
    expectTypeOf<TransferItem["amountKobo"]>().not.toEqualTypeOf<number>();
  });

  it("builds a provider from one organisation's credentials and webhook scheme", () => {
    const provider = getPaymentProvider(
      { publicKey: "pk", secretKey: "sk", encryptionKey: "enc", webhookSecretHash: "hash" },
      { webhookScheme: "hmac-sha256" },
    );
    expectTypeOf(provider).toEqualTypeOf<PaymentProvider>();
    expect(typeof provider.verifyWebhook).toBe("function");
    expectTypeOf(getPaymentProvider).parameter(1).toEqualTypeOf<PaymentProviderOptions>();
  });

  it("keys money idempotency on the transaction, not the webhook delivery", () => {
    expectTypeOf<WebhookEvent["transactionId"]>().toEqualTypeOf<string>();
    expectTypeOf<WebhookEvent>().not.toHaveProperty("eventId");
    expectTypeOf<WebhookEvent>().not.toHaveProperty("raw");
    expectTypeOf<VerifiedTransaction>().not.toHaveProperty("raw");
  });
});
