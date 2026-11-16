// Kept next to the adapter so provider names stay inside src/lib/payments.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createFlutterwaveProvider,
  fromFlutterwaveAmount,
  redactFlutterwavePayload,
  toFlutterwaveAmount,
} from "./flutterwave";
import {
  InvalidWebhookPayloadError,
  ProviderNotImplementedError,
  type PaymentProvider,
  type PaymentProviderOptions,
  type ProviderCredentials,
} from "./provider";

const staticHash: PaymentProviderOptions = { webhookScheme: "static-hash" };

const credsA: ProviderCredentials = {
  publicKey: "pk_test_org_a",
  secretKey: "sk_test_org_a",
  encryptionKey: "enc_test_org_a",
  webhookSecretHash: "org-a-webhook-secret-hash",
};

const credsB: ProviderCredentials = {
  publicKey: "pk_test_org_b",
  secretKey: "sk_test_org_b",
  encryptionKey: "enc_test_org_b",
  webhookSecretHash: "org-b-webhook-secret-hash",
};

const chargeBody = JSON.stringify({
  event: "charge.completed",
  data: { id: 285959875, tx_ref: "INV-0412-a1b2", amount: 642312.5, currency: "NGN" },
});

describe("network methods (stub)", () => {
  const injectedFetch = vi.fn<typeof fetch>();
  let globalFetch: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    globalFetch = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    injectedFetch.mockReset();
  });

  it("rejects with ProviderNotImplementedError and never calls fetch", async () => {
    const provider = createFlutterwaveProvider(credsA, { ...staticHash, fetch: injectedFetch });
    const calls: Promise<unknown>[] = [
      provider.createVirtualAccount({
        orgId: "org",
        clientId: "client",
        reference: "va-1",
        email: "billing@example.com",
        accountName: "Coastline",
        permanent: true,
        currency: "NGN",
      }),
      provider.createPaymentLink({
        txRef: "INV-0412-a1b2",
        amountKobo: 64231250n,
        currency: "NGN",
        customer: { email: "billing@example.com", name: "Coastline" },
        redirectUrl: "https://example.com/paid",
        description: "INV-0412",
      }),
      provider.verifyTransaction({ transactionId: "285959875" }),
      provider.verifyTransaction({ txRef: "INV-0412-a1b2" }),
      provider.createBulkTransfer({ reference: "run-1", title: "October payroll", items: [] }),
      provider.getBulkTransfer("batch-1"),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(ProviderNotImplementedError);
    }
    expect(injectedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("verifyWebhook (static-hash, v3 verif-hash header)", () => {
  const provider = createFlutterwaveProvider(credsA, staticHash);

  it("accepts the organisation's own secret hash", () => {
    const headers = new Headers({ "verif-hash": credsA.webhookSecretHash });
    expect(provider.verifyWebhook(chargeBody, headers)).toEqual({ ok: true });
  });

  it("looks the header up case-insensitively", () => {
    const headers = new Headers({ "Verif-Hash": credsA.webhookSecretHash });
    expect(provider.verifyWebhook(chargeBody, headers)).toEqual({ ok: true });
  });

  it("rejects a wrong value", () => {
    const headers = new Headers({ "verif-hash": "org-a-webhook-secret-hasX" });
    expect(provider.verifyWebhook(chargeBody, headers)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a different-length value without throwing", () => {
    const headers = new Headers({ "verif-hash": "x" });
    expect(() => provider.verifyWebhook(chargeBody, headers)).not.toThrow();
    expect(provider.verifyWebhook(chargeBody, headers)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("reports a missing or empty header", () => {
    expect(provider.verifyWebhook(chargeBody, new Headers())).toEqual({
      ok: false,
      reason: "missing_header",
    });
    expect(provider.verifyWebhook(chargeBody, new Headers({ "verif-hash": "" }))).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("does not accept another organisation's hash (per-organisation credentials)", () => {
    const providerB = createFlutterwaveProvider(credsB, staticHash);
    const signedForA = new Headers({ "verif-hash": credsA.webhookSecretHash });
    const signedForB = new Headers({ "verif-hash": credsB.webhookSecretHash });
    expect(providerB.verifyWebhook(chargeBody, signedForA)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(provider.verifyWebhook(chargeBody, signedForB)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(providerB.verifyWebhook(chargeBody, signedForB)).toEqual({ ok: true });
  });

  it("fails closed when the organisation has no secret hash", () => {
    const unconfigured = createFlutterwaveProvider(
      { ...credsA, webhookSecretHash: "" },
      staticHash,
    );
    const headers = new Headers({ "verif-hash": "" });
    expect(unconfigured.verifyWebhook(chargeBody, headers)).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(
      unconfigured.verifyWebhook(chargeBody, new Headers({ "verif-hash": "anything" })),
    ).toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("verifyWebhook (hmac-sha256 scheme)", () => {
  const provider = createFlutterwaveProvider(credsA, { webhookScheme: "hmac-sha256" });
  const sign = (body: string, secret: string) =>
    createHmac("sha256", secret).update(body, "utf8").digest("base64");

  it("accepts an HMAC of the exact raw body", () => {
    const headers = new Headers({
      "flutterwave-signature": sign(chargeBody, credsA.webhookSecretHash),
    });
    expect(provider.verifyWebhook(chargeBody, headers)).toEqual({ ok: true });
  });

  it("rejects when the body was changed after signing", () => {
    const headers = new Headers({
      "flutterwave-signature": sign(chargeBody, credsA.webhookSecretHash),
    });
    const tampered = chargeBody.replace("642312.5", "999999.5");
    expect(provider.verifyWebhook(tampered, headers)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects an HMAC keyed with another organisation's secret", () => {
    const headers = new Headers({
      "flutterwave-signature": sign(chargeBody, credsB.webhookSecretHash),
    });
    expect(provider.verifyWebhook(chargeBody, headers)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("does not fall back to the verif-hash header", () => {
    const headers = new Headers({ "verif-hash": credsA.webhookSecretHash });
    expect(provider.verifyWebhook(chargeBody, headers)).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });
});

describe("parseWebhookEvent", () => {
  const provider = createFlutterwaveProvider(credsA, staticHash);

  it("parses a charge event without exposing amount or status", () => {
    const event = provider.parseWebhookEvent(chargeBody);
    expect(event).toMatchObject({
      deliveryKey: "charge.completed:285959875",
      type: "charge.completed",
      transactionId: "285959875",
      txRef: "INV-0412-a1b2",
    });
    expect(event).not.toHaveProperty("amountKobo");
    expect(event).not.toHaveProperty("status");
  });

  it("uses the transfer reference for transfer events", () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ event: "transfer.completed", data: { id: 33286, reference: "PAY-001" } }),
    );
    expect(event).toMatchObject({
      deliveryKey: "transfer.completed:33286",
      type: "transfer.completed",
      txRef: "PAY-001",
    });
  });

  it("maps other events to unknown", () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ event: "subscription.cancelled", data: { id: "abc" } }),
    );
    expect(event.type).toBe("unknown");
    expect(event.txRef).toBeUndefined();
  });

  it.each([
    "",
    "not json",
    "{",
    "null",
    "[]",
    JSON.stringify({ data: { id: 1 } }),
    JSON.stringify({ event: "charge.completed" }),
    JSON.stringify({ event: "charge.completed", data: {} }),
    JSON.stringify({ event: "charge.completed", data: { id: -1 } }),
    JSON.stringify({ event: "charge.completed", data: { id: 1.5 } }),
  ])("rejects malformed payload %j", (body) => {
    expect(() => provider.parseWebhookEvent(body)).toThrow(InvalidWebhookPayloadError);
  });
});

describe("amount conversion", () => {
  it("sends major-unit strings", () => {
    expect(toFlutterwaveAmount(64231250n)).toBe("642312.50");
    expect(toFlutterwaveAmount(5n)).toBe("0.05");
  });

  it("reads major-unit numbers and strings into kobo without floats", () => {
    expect(fromFlutterwaveAmount(642312.5)).toBe(64231250n);
    expect(fromFlutterwaveAmount("642312.50")).toBe(64231250n);
    expect(fromFlutterwaveAmount(100)).toBe(10000n);
    expect(fromFlutterwaveAmount(0)).toBe(0n);
    expect(fromFlutterwaveAmount("0.05")).toBe(5n);
    expect(() => fromFlutterwaveAmount(0.1 + 0.2)).toThrow(RangeError);
    expect(() => fromFlutterwaveAmount("1.234")).toThrow(RangeError);
  });

  it.each<number | string>([
    -1,
    "-1",
    -642312.5,
    "-642312.50",
    "₦100",
    "1,000",
    " 100",
    "100 ",
    "+100",
    "1e3",
    1e21,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    ".5",
    "1.",
  ])("rejects provider amount %j", (major) => {
    expect(() => fromFlutterwaveAmount(major)).toThrow(RangeError);
  });
});

describe("audit payload redaction", () => {
  const verifyResponse = {
    status: "success",
    message: "Transaction fetched successfully",
    data: {
      id: 285959875,
      tx_ref: "INV-0412-a1b2",
      flw_ref: "FLW-MOCK-1",
      amount: 642312.5,
      charged_amount: 642312.5,
      currency: "NGN",
      status: "successful",
      created_at: "2026-11-15T10:00:00.000Z",
      customer: { name: "Ada Obi", email: "ada@example.com", phone_number: "08030000000" },
      card: { first_6digits: "539983", last_4digits: "8381", issuer: "MASTERCARD" },
      account_number: "0690000031",
      meta: { note: "free text" },
      ip: "197.210.0.1",
    },
  };

  it("keeps only allow-listed, non-personal fields", () => {
    expect(redactFlutterwavePayload(verifyResponse)).toEqual({
      id: 285959875,
      tx_ref: "INV-0412-a1b2",
      flw_ref: "FLW-MOCK-1",
      amount: 642312.5,
      charged_amount: 642312.5,
      currency: "NGN",
      status: "successful",
      created_at: "2026-11-15T10:00:00.000Z",
    });
  });

  it("drops nested objects even under an allow-listed key", () => {
    expect(redactFlutterwavePayload({ data: { id: { email: "ada@example.com" } } })).toEqual({});
  });

  it("returns an empty payload for junk", () => {
    expect(redactFlutterwavePayload(null)).toEqual({});
    expect(redactFlutterwavePayload("text")).toEqual({});
    expect(redactFlutterwavePayload({ data: "x" })).toEqual({});
  });

  it("puts no personal data on a parsed webhook event", () => {
    const provider = createFlutterwaveProvider(credsA, staticHash);
    const event = provider.parseWebhookEvent(
      JSON.stringify({ event: "charge.completed", data: verifyResponse.data }),
    );
    expect(event).not.toHaveProperty("raw");
    expect(event.auditPayload).toMatchObject({ event: "charge.completed", id: 285959875 });
    const serialised = JSON.stringify(event);
    for (const secret of ["ada@example.com", "08030000000", "8381", "0690000031", "Ada Obi"]) {
      expect(serialised).not.toContain(secret);
    }
  });
});

describe("types", () => {
  it("returns a PaymentProvider", () => {
    expectTypeOf(createFlutterwaveProvider(credsA, staticHash)).toEqualTypeOf<PaymentProvider>();
  });

  it("requires an explicit webhook scheme", () => {
    // @ts-expect-error the scheme has no default
    expect(() => createFlutterwaveProvider(credsA)).toThrow(TypeError);
    // @ts-expect-error the scheme has no default
    expect(() => createFlutterwaveProvider(credsA, {})).toThrow(TypeError);
    expect(() =>
      createFlutterwaveProvider(credsA, {
        webhookScheme: "verif-hash" as unknown as PaymentProviderOptions["webhookScheme"],
      }),
    ).toThrow(TypeError);
  });
});
