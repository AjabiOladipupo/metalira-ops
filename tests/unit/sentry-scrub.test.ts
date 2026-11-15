import { describe, expect, it } from "vitest";

import {
  FILTERED,
  isSensitiveKey,
  scrubEvent,
  scrubText,
  scrubValue,
} from "@/lib/observability/scrub";

describe("isSensitiveKey", () => {
  it.each([
    "nin",
    "bvn",
    "NIN",
    "rsa_pin",
    "rsaPin",
    "pin_hash",
    "password",
    "newPassword",
    "client_secret",
    "accessToken",
    "account_number",
    "accountNumber",
    "bank_account",
    "nin_enc",
    "bank_account_number_enc",
    "Authorization",
    "cookie",
  ])("flags %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["name", "planning", "warning", "spinner", "opening", "site_id", "trace_id", "span_id"])(
    "leaves %s alone",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("scrubText", () => {
  it("redacts account numbers, NIN, BVN and phone numbers", () => {
    expect(scrubText("account 0123456789 failed")).toBe(`account ${FILTERED} failed`);
    expect(scrubText("NIN 12345678901")).toBe(`NIN ${FILTERED}`);
    expect(scrubText("call 08031234567 or +2348031234567")).toBe(`call ${FILTERED} or ${FILTERED}`);
  });

  it("keeps short numbers, money and dates", () => {
    const text = "Shift 42 for 642312 kobo on 2026-11-14T08:00:00.000Z";
    expect(scrubText(text)).toBe(text);
  });
});

describe("scrubValue", () => {
  it("replaces sensitive keys at any depth and redacts digits in strings", () => {
    expect(
      scrubValue({
        worker: { name: "Ada", bvn: "22222222222", bank: { accountNumber: "0123456789" } },
        notes: ["paid to 0123456789"],
      }),
    ).toEqual({
      worker: { name: "Ada", bvn: FILTERED, bank: { accountNumber: FILTERED } },
      notes: [`paid to ${FILTERED}`],
    });
  });

  it("leaves strings untouched when text scrubbing is off", () => {
    expect(scrubValue({ trace_id: "12345678901234567890" }, { text: false })).toEqual({
      trace_id: "12345678901234567890",
    });
  });
});

describe("scrubEvent", () => {
  it("strips cookies, auth headers, query strings and request PII", () => {
    const event = scrubEvent({
      message: "Payout to 0123456789 failed",
      request: {
        url: "https://ops.example.com/reset?token=abc",
        query_string: "token=abc",
        cookies: { "sb-access-token": "x" },
        headers: {
          Authorization: "Bearer x",
          Cookie: "a=b",
          "x-debug-token": "t",
          "user-agent": "test",
        },
        data: { email: "a@b.com", password: "hunter2", nin: "12345678901" },
      },
      user: { id: "u1", email: "a@b.com", ip_address: "1.2.3.4" },
      extra: { rsa_pin: "1234", site: "Lekki" },
      contexts: { trace: { trace_id: "12345678901234567890abcd" } },
      exception: { values: [{ value: "Bad BVN 22222222222" }] },
      breadcrumbs: [{ message: "GET /x 08031234567", data: { secret: "s", status: 200 } }],
    });

    expect(event.message).toBe(`Payout to ${FILTERED} failed`);
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.url).toBe(`https://ops.example.com/reset?${FILTERED}`);
    expect(event.request?.query_string).toBe(FILTERED);
    expect(event.request?.headers).toEqual({
      Authorization: FILTERED,
      Cookie: FILTERED,
      "x-debug-token": FILTERED,
      "user-agent": "test",
    });
    expect(event.request?.data).toEqual({ email: "a@b.com", password: FILTERED, nin: FILTERED });
    expect(event.user).toEqual({ id: "u1" });
    expect(event.extra).toEqual({ rsa_pin: FILTERED, site: "Lekki" });
    expect(event.contexts).toEqual({ trace: { trace_id: "12345678901234567890abcd" } });
    expect(event.exception?.values?.[0]?.value).toBe(`Bad BVN ${FILTERED}`);
    expect(event.breadcrumbs?.[0]).toEqual({
      message: `GET /x ${FILTERED}`,
      data: { secret: FILTERED, status: 200 },
    });
  });

  it("drops a user without an id", () => {
    expect(scrubEvent({ user: { email: "a@b.com" } }).user).toBeUndefined();
  });
});
