import { describe, expect, expectTypeOf, it } from "vitest";
import type { Kobo } from "@/lib/money";
import {
  getPaymentProvider,
  type CreatePaymentLinkInput,
  type CreateVirtualAccountInput,
  type PaymentProvider,
  type TransferItem,
  type VerifiedTransaction,
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

  it("builds a provider from one organisation's credentials", () => {
    const provider = getPaymentProvider({
      publicKey: "pk",
      secretKey: "sk",
      encryptionKey: "enc",
      webhookSecretHash: "hash",
    });
    expectTypeOf(provider).toEqualTypeOf<PaymentProvider>();
    expect(typeof provider.verifyWebhook).toBe("function");
  });
});
