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
    "bank_account_number",
    "bankAccountNumber",
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
    expect(event.request?.data).toBeUndefined();
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

  it.each([
    ["JSON", '{"email":"a@b.com","password":"hunter2","pin":"1234","nin":"12345678901"}'],
    ["urlencoded", "email=a%40b.com&password=hunter2&pin=1234&nin=12345678901"],
    ["multipart", '--x\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--x--'],
  ])("drops a %s request body string", (_kind, body) => {
    const event = scrubEvent({ request: { url: "https://ops.example.com/sign-in", data: body } });
    expect(event.request).toEqual({ url: "https://ops.example.com/sign-in" });
    expect(JSON.stringify(event)).not.toMatch(/hunter2|1234|a@b\.com|12345678901/);
  });

  it("filters IP, location and credential headers", () => {
    const event = scrubEvent({
      request: {
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "x-vercel-forwarded-for": "1.2.3.4",
          "x-real-ip": "1.2.3.4",
          "x-vercel-ip-city": "Lagos",
          "x-vercel-ip-latitude": "6.45",
          "x-vercel-ip-longitude": "3.39",
          apikey: "sb_publishable_x",
          "x-supabase-auth": "jwt",
          "x-api-token": "t",
          accept: "text/html",
        },
      },
    });
    expect(event.request?.headers).toEqual({
      "x-forwarded-for": FILTERED,
      "x-vercel-forwarded-for": FILTERED,
      "x-real-ip": FILTERED,
      "x-vercel-ip-city": FILTERED,
      "x-vercel-ip-latitude": FILTERED,
      "x-vercel-ip-longitude": FILTERED,
      apikey: FILTERED,
      "x-supabase-auth": FILTERED,
      "x-api-token": FILTERED,
      accept: "text/html",
    });
  });

  it("scrubs transaction spans, trace context and the transaction name", () => {
    const supabase = "https://abc.supabase.co/rest/v1/people?email=eq.a%40b.com&staff_id=eq.S1";
    const event = scrubEvent({
      transaction: "GET /invite?token=abc",
      contexts: {
        trace: {
          trace_id: "12345678901234567890abcd",
          data: { "http.url": supabase, "url.query": "?email=eq.a", "http.method": "GET" },
        },
      },
      spans: [
        {
          description: `GET ${supabase}`,
          data: {
            url: supabase,
            "url.full": supabase,
            "http.query": "?email=eq.a%40b.com",
            "http.response.status_code": 200,
            "db.statement": "select * from people where email = 'a@b.com'",
          },
        },
      ],
    });

    const stripped = `https://abc.supabase.co/rest/v1/people?${FILTERED}`;
    expect(event.transaction).toBe(`GET /invite?${FILTERED}`);
    expect(event.contexts).toEqual({
      trace: {
        trace_id: "12345678901234567890abcd",
        data: { "http.url": stripped, "url.query": FILTERED, "http.method": "GET" },
      },
    });
    expect(event.spans?.[0]).toEqual({
      description: `GET ${stripped}`,
      data: {
        url: stripped,
        "url.full": stripped,
        "http.query": FILTERED,
        "http.response.status_code": 200,
        "db.statement": `select * from people where email = '${FILTERED}'`,
      },
    });
  });

  it("strips query strings from breadcrumb URLs", () => {
    const event = scrubEvent({
      breadcrumbs: [
        {
          message: "fetch",
          data: {
            method: "GET",
            url: "/auth/confirm?token_hash=abc&type=invite",
            status_code: 200,
          },
        },
        { message: "navigation", data: { from: "/reset?code=abc", to: "/home?ref=x" } },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      {
        message: "fetch",
        data: { method: "GET", url: `/auth/confirm?${FILTERED}`, status_code: 200 },
      },
      { message: "navigation", data: { from: `/reset?${FILTERED}`, to: `/home?${FILTERED}` } },
    ]);
  });

  it("scrubs log entries, mechanism data and drops local variables", () => {
    const event = scrubEvent({
      logentry: { message: "Payout to %s failed for %s", params: ["0123456789", "a@b.com"] },
      exception: {
        values: [
          {
            value: "boom",
            mechanism: { data: { handler: "action", password: "hunter2" } },
            stacktrace: {
              frames: [{ vars: { nin: "12345678901", pin: "1234", name: "Ada" } }, {}],
            },
          },
        ],
      },
    });
    expect(event.logentry).toEqual({
      message: "Payout to %s failed for %s",
      params: [FILTERED, FILTERED],
    });
    expect(event.exception?.values?.[0]).toEqual({
      value: "boom",
      mechanism: { data: { handler: "action", password: FILTERED } },
      stacktrace: { frames: [{}, {}] },
    });
  });
});

describe("scrubText free-text patterns", () => {
  it("redacts RSA PINs, long digit runs and emails", () => {
    expect(scrubText("RSA PIN PEN100012345678 rejected")).toBe(`RSA PIN ${FILTERED} rejected`);
    expect(scrubText("pen100012345678")).toBe(FILTERED);
    expect(scrubText("ref 1234567890123456")).toBe(`ref ${FILTERED}`);
    expect(scrubText("invite for ada.obi+ops@example.com.ng sent")).toBe(
      `invite for ${FILTERED} sent`,
    );
  });

  it("strips query strings from URLs and paths in text", () => {
    expect(scrubText("GET https://x.supabase.co/rest/v1/people?email=eq.x 400")).toBe(
      `GET https://x.supabase.co/rest/v1/people?${FILTERED} 400`,
    );
    expect(scrubText("POST /auth/v1/verify?token=abc")).toBe(`POST /auth/v1/verify?${FILTERED}`);
    expect(scrubText("Is this ok? yes")).toBe("Is this ok? yes");
  });
});
