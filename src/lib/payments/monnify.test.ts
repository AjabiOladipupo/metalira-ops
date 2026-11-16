// Kept next to the adapter so provider names stay inside src/lib/payments.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createMonnifyProvider,
  fromMonnifyAmount,
  MONNIFY_SANDBOX_BASE_URL,
  MONNIFY_WEBHOOK_IPS,
  redactMonnifyPayload,
  toMonnifyAmount,
} from "./monnify";
import {
  InvalidWebhookPayloadError,
  ProviderNotImplementedError,
  type PaymentProvider,
  type ProviderCredentials,
} from "./provider";

const creds: ProviderCredentials = {
  apiKey: "MK_TEST_METALIRA",
  secretKey: "metalira-test-secret-key",
  contractCode: "1234567890",
};

const otherCreds: ProviderCredentials = { ...creds, secretKey: "some-other-secret-key" };

const transactionBody = JSON.stringify({
  eventType: "SUCCESSFUL_TRANSACTION",
  eventData: {
    transactionReference: "MNFY|20261116|000123",
    paymentReference: "SUB-0001-a1b2",
    amountPaid: "25000.00",
    paymentStatus: "PAID",
  },
});

const sign = (body: string, secret: string) =>
  createHmac("sha512", secret).update(body, "utf8").digest("hex");

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
    const provider = createMonnifyProvider(creds, { fetch: injectedFetch });
    const calls: Promise<unknown>[] = [
      provider.createVirtualAccount({
        orgId: "org",
        reference: "SUBACC-org",
        email: "owner@example.com",
        accountName: "Shield Guards Ltd",
        currency: "NGN",
      }),
      provider.createPaymentLink({
        txRef: "SUB-0001-a1b2",
        amountKobo: 2500000n,
        currency: "NGN",
        customer: { email: "owner@example.com", name: "Shield Guards Ltd" },
        redirectUrl: "https://example.com/paid",
        description: "Metalira Ops subscription",
      }),
      provider.verifyTransaction({ transactionId: "MNFY|20261116|000123" }),
      provider.verifyTransaction({ txRef: "SUB-0001-a1b2" }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(ProviderNotImplementedError);
    }
    expect(injectedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("accepts only Monnify's own hosts", () => {
    expect(() =>
      createMonnifyProvider(creds, { baseUrl: "https://api.monnify.com" }),
    ).not.toThrow();
    for (const baseUrl of [
      "https://evil.example",
      "http://api.monnify.com",
      "https://api.monnify.com.evil.example",
    ]) {
      expect(() => createMonnifyProvider(creds, { baseUrl })).toThrow(TypeError);
    }
  });

  it("defaults to the sandbox host", async () => {
    const provider = createMonnifyProvider(creds);
    await expect(provider.verifyTransaction({ txRef: "x" })).rejects.toThrow(
      MONNIFY_SANDBOX_BASE_URL,
    );
  });
});

describe("verifyWebhook (HMAC-SHA512 of the raw body)", () => {
  const provider = createMonnifyProvider(creds);

  it("accepts an HMAC of the exact raw body", () => {
    const headers = new Headers({ "monnify-signature": sign(transactionBody, creds.secretKey) });
    expect(provider.verifyWebhook(transactionBody, headers)).toEqual({ ok: true });
  });

  it("looks the header up case-insensitively and accepts upper-case hex", () => {
    const headers = new Headers({
      "Monnify-Signature": sign(transactionBody, creds.secretKey).toUpperCase(),
    });
    expect(provider.verifyWebhook(transactionBody, headers)).toEqual({ ok: true });
  });

  it("rejects when the body was changed after signing", () => {
    const headers = new Headers({ "monnify-signature": sign(transactionBody, creds.secretKey) });
    const tampered = transactionBody.replace("25000.00", "99999.00");
    expect(provider.verifyWebhook(tampered, headers)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects an HMAC keyed with another secret", () => {
    const headers = new Headers({
      "monnify-signature": sign(transactionBody, otherCreds.secretKey),
    });
    expect(provider.verifyWebhook(transactionBody, headers)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects the bare secret key sent as the header", () => {
    const headers = new Headers({ "monnify-signature": creds.secretKey });
    expect(provider.verifyWebhook(transactionBody, headers)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a different-length value without throwing", () => {
    const headers = new Headers({ "monnify-signature": "x" });
    expect(() => provider.verifyWebhook(transactionBody, headers)).not.toThrow();
    expect(provider.verifyWebhook(transactionBody, headers)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("reports a missing or empty header", () => {
    expect(provider.verifyWebhook(transactionBody, new Headers())).toEqual({
      ok: false,
      reason: "missing_header",
    });
    expect(
      provider.verifyWebhook(transactionBody, new Headers({ "monnify-signature": "" })),
    ).toEqual({ ok: false, reason: "missing_header" });
  });

  it.each(["", "   ", "\n"])("fails closed when the secret key is %j", (secretKey) => {
    const unconfigured = createMonnifyProvider({ ...creds, secretKey });
    const signed = new Headers({ "monnify-signature": sign(transactionBody, secretKey) });
    expect(unconfigured.verifyWebhook(transactionBody, signed)).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("binds the signature to the exact bytes: a re-serialised body fails", () => {
    const headers = new Headers({ "monnify-signature": sign(transactionBody, creds.secretKey) });
    const pretty = JSON.stringify(JSON.parse(transactionBody), null, 2);
    expect(provider.verifyWebhook(pretty, headers)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a duplicated header, a prefixed value and non-hex of the right length", () => {
    const good = sign(transactionBody, creds.secretKey);
    const duplicated = new Headers();
    duplicated.append("monnify-signature", good);
    duplicated.append("monnify-signature", good);
    for (const headers of [
      duplicated,
      new Headers({ "monnify-signature": `sha512=${good}` }),
      new Headers({ "monnify-signature": "z".repeat(128) }),
    ]) {
      expect(provider.verifyWebhook(transactionBody, headers)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    }
  });

  it("tolerates surrounding whitespace on a valid digest", () => {
    const headers = new Headers({
      "monnify-signature": ` ${sign(transactionBody, creds.secretKey)} `,
    });
    expect(provider.verifyWebhook(transactionBody, headers)).toEqual({ ok: true });
  });
});

describe("isTrustedWebhookSource", () => {
  const provider = createMonnifyProvider(creds);

  it("accepts each published Monnify address", () => {
    expect(MONNIFY_WEBHOOK_IPS.length).toBeGreaterThan(0);
    for (const ip of MONNIFY_WEBHOOK_IPS) {
      expect(provider.isTrustedWebhookSource(ip)).toBe(true);
    }
  });

  it("ignores surrounding whitespace on a listed address", () => {
    expect(provider.isTrustedWebhookSource(" 35.242.133.146 ")).toBe(true);
  });

  it.each([
    null,
    "",
    "127.0.0.1",
    "35.242.133.147",
    "035.242.133.146",
    "::ffff:35.242.133.146",
    "35.242.133.146, 1.2.3.4",
    "1.2.3.4, 35.242.133.146",
  ])("rejects %j", (ip) => {
    expect(provider.isTrustedWebhookSource(ip)).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  const provider = createMonnifyProvider(creds);

  it("parses a successful transaction without exposing amount or status", () => {
    const event = provider.parseWebhookEvent(transactionBody);
    expect(event).toMatchObject({
      deliveryKey: "SUCCESSFUL_TRANSACTION:MNFY|20261116|000123",
      type: "payment.completed",
      transactionId: "MNFY|20261116|000123",
      txRef: "SUB-0001-a1b2",
    });
    expect(event).not.toHaveProperty("amountKobo");
    expect(event).not.toHaveProperty("status");
  });

  it.each(["SUCCESSFUL_DISBURSEMENT", "SUCCESSFUL_REFUND", "SETTLEMENT"])(
    "maps %s to unknown",
    (eventType) => {
      const event = provider.parseWebhookEvent(
        JSON.stringify({ eventType, eventData: { transactionReference: "MNFY|1" } }),
      );
      expect(event.type).toBe("unknown");
      expect(event.txRef).toBeUndefined();
    },
  );

  it.each([
    "",
    "not json",
    "{",
    "null",
    "[]",
    JSON.stringify({ eventData: { transactionReference: "MNFY|1" } }),
    JSON.stringify({ eventType: "SUCCESSFUL_TRANSACTION" }),
    JSON.stringify({ eventType: "SUCCESSFUL_TRANSACTION", eventData: {} }),
    JSON.stringify({
      eventType: "SUCCESSFUL_TRANSACTION",
      eventData: { transactionReference: "" },
    }),
    JSON.stringify({ eventType: "SUCCESSFUL_TRANSACTION", eventData: { transactionReference: 1 } }),
    JSON.stringify({ eventType: "SUCCESSFUL_TRANSACTION", eventData: [] }),
    JSON.stringify({
      eventType: "SUCCESSFUL_TRANSACTION",
      eventData: { transactionReference: "MNFY|1", paymentReference: 7 },
    }),
    JSON.stringify({
      eventType: "SUCCESSFUL_TRANSACTION",
      eventData: { transactionReference: "x".repeat(129) },
    }),
    JSON.stringify({
      eventType: "SUCCESSFUL_TRANSACTION",
      eventData: { transactionReference: "../../admin" + "/x" },
    }),
    // Prototype keys are not event types.
    JSON.stringify({ eventType: "toString", eventData: { transactionReference: "MNFY|1" } }),
    JSON.stringify({ eventType: "__proto__", eventData: { transactionReference: "MNFY|1" } }),
    JSON.stringify({ eventType: "constructor", eventData: { transactionReference: "MNFY|1" } }),
    // Written by hand: JSON.stringify would not emit an own "__proto__" key.
    '{"eventType":"SUCCESSFUL_TRANSACTION","eventData":{"__proto__":{"transactionReference":"x"}}}',
  ])("rejects malformed payload %j", (body) => {
    expect(() => provider.parseWebhookEvent(body)).toThrow(InvalidWebhookPayloadError);
  });
});

describe("amount conversion", () => {
  it("sends major-unit strings", () => {
    expect(toMonnifyAmount(64231250n)).toBe("642312.50");
    expect(toMonnifyAmount(5n)).toBe("0.05");
  });

  it("refuses to send a zero or negative amount", () => {
    expect(() => toMonnifyAmount(0n)).toThrow(RangeError);
    expect(() => toMonnifyAmount(-5n)).toThrow(RangeError);
  });

  it("rejects JSON numbers too large to convert exactly", () => {
    expect(fromMonnifyAmount(9_999_999_999_999.99)).toBe(999_999_999_999_999n);
    expect(() => fromMonnifyAmount(99_999_999_999_999.99)).toThrow(RangeError);
    expect(() => fromMonnifyAmount(9_007_199_254_740_993)).toThrow(RangeError);
    expect(fromMonnifyAmount("99999999999999.99")).toBe(9_999_999_999_999_999n);
  });

  it("reads major-unit numbers and strings into kobo without floats", () => {
    expect(fromMonnifyAmount(642312.5)).toBe(64231250n);
    expect(fromMonnifyAmount("642312.50")).toBe(64231250n);
    expect(fromMonnifyAmount(100)).toBe(10000n);
    expect(fromMonnifyAmount(0)).toBe(0n);
    expect(fromMonnifyAmount("0.05")).toBe(5n);
    expect(() => fromMonnifyAmount(0.1 + 0.2)).toThrow(RangeError);
    expect(() => fromMonnifyAmount("1.234")).toThrow(RangeError);
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
    expect(() => fromMonnifyAmount(major)).toThrow(RangeError);
  });
});

describe("audit payload redaction", () => {
  const webhook = {
    eventType: "SUCCESSFUL_TRANSACTION",
    eventData: {
      transactionReference: "MNFY|20261116|000123",
      paymentReference: "SUB-0001-a1b2",
      paymentStatus: "PAID",
      amountPaid: "25000.00",
      totalPayable: "25000.00",
      settlementAmount: "24850.00",
      currency: "NGN",
      paidOn: "16/11/2026 10:00:00 AM",
      paymentMethod: "ACCOUNT_TRANSFER",
      paymentDescription: "free text",
      customer: { name: "Ada Obi", email: "ada@example.com" },
      paymentSourceInformation: [{ accountNumber: "0690000031", accountName: "Ada Obi" }],
      destinationAccountInformation: { accountNumber: "5000000001", bankName: "Wema" },
      product: { type: "WEB_SDK", reference: "SUB-0001-a1b2" },
    },
  };

  it("keeps only allow-listed, non-personal fields", () => {
    expect(redactMonnifyPayload(webhook)).toEqual({
      eventType: "SUCCESSFUL_TRANSACTION",
      transactionReference: "MNFY|20261116|000123",
      paymentReference: "SUB-0001-a1b2",
      paymentStatus: "PAID",
      amountPaid: "25000.00",
      totalPayable: "25000.00",
      settlementAmount: "24850.00",
      currency: "NGN",
      paidOn: "16/11/2026 10:00:00 AM",
      paymentMethod: "ACCOUNT_TRANSFER",
    });
  });

  it("reads an API responseBody the same way", () => {
    expect(
      redactMonnifyPayload({
        requestSuccessful: true,
        responseBody: { transactionReference: "MNFY|1", customer: { email: "ada@example.com" } },
      }),
    ).toEqual({ transactionReference: "MNFY|1" });
  });

  it("never reads responseBody when eventData is present, even if null", () => {
    expect(
      redactMonnifyPayload({ eventData: null, responseBody: { transactionReference: "MNFY|1" } }),
    ).toEqual({});
  });

  it("drops arrays under an allow-listed key", () => {
    expect(redactMonnifyPayload({ eventData: { paymentReference: ["a@example.com"] } })).toEqual(
      {},
    );
  });

  it("drops nested objects even under an allow-listed key", () => {
    expect(
      redactMonnifyPayload({ eventData: { transactionReference: { email: "ada@example.com" } } }),
    ).toEqual({});
  });

  it("returns an empty payload for junk", () => {
    expect(redactMonnifyPayload(null)).toEqual({});
    expect(redactMonnifyPayload("text")).toEqual({});
    expect(redactMonnifyPayload({ eventData: "x" })).toEqual({});
  });

  it("puts no personal data on a parsed webhook event", () => {
    const provider = createMonnifyProvider(creds);
    const event = provider.parseWebhookEvent(JSON.stringify(webhook));
    expect(event).not.toHaveProperty("raw");
    expect(event.auditPayload).toMatchObject({ eventType: "SUCCESSFUL_TRANSACTION" });
    const serialised = JSON.stringify(event);
    for (const secret of ["ada@example.com", "Ada Obi", "0690000031", "5000000001", "free text"]) {
      expect(serialised).not.toContain(secret);
    }
  });
});

describe("types", () => {
  it("returns a PaymentProvider", () => {
    expectTypeOf(createMonnifyProvider(creds)).toEqualTypeOf<PaymentProvider>();
  });
});
