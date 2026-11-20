import { describe, expect, it } from "vitest";

import { attendanceSettingsSchema } from "@/lib/attendance";
import { INBOX_EMAIL_CAPS, emailFits, inboxMessageSchema, isWorkerAppPath } from "@/lib/inbox";
import { CONSENT_NOTICES } from "@/lib/messages/consent";

describe("isWorkerAppPath", () => {
  it.each(["/m", "/m/inbox", "/m/shifts", "/m/me/consent", "/m/a_b-c/9"])("accepts %s", (path) =>
    expect(isWorkerAppPath(path)).toBe(true),
  );

  it.each([
    "",
    "/",
    "/m/",
    "/app/people",
    "/mm",
    "//evil.example",
    "/m//evil.example",
    "https://evil.example/m",
    "/m/../app",
    "/m/./x",
    "/m?next=https://evil.example",
    "/m#x",
    "/m/%2e%2e",
    "/m/inbox\n",
    "javascript:alert(1)",
    "/m/" + "a".repeat(200),
  ])("refuses %j", (path) => expect(isWorkerAppPath(path)).toBe(false));
});

describe("inboxMessageSchema", () => {
  const ok = { kind: "shift_published", title: "Roster published", body: "Line one\nLine two" };

  it("accepts plain text with line breaks and an internal link", () => {
    expect(inboxMessageSchema.parse({ ...ok, link: "/m/shifts" }).link).toBe("/m/shifts");
    expect(inboxMessageSchema.parse(ok).link).toBeUndefined();
  });

  it.each([
    { title: "See https://evil.example" },
    { body: "Go to www.evil.example" },
    { body: "Click http://x.y" },
    { title: "<b>Hi</b>" },
    { body: "Tab\there" },
    { link: "https://evil.example" },
    { link: "/app/people" },
    { kind: "Bad Kind" },
    { title: "" },
    { body: "x".repeat(1001) },
    { body: "Your new account is 0123456789." },
    { body: "NIN 1234 5678 901 on file" },
  ])("refuses %j", (patch) => {
    expect(inboxMessageSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});

describe("emailFits (the inbox email caps)", () => {
  it("keeps headroom under Resend Free's 100 a day", () => {
    expect(INBOX_EMAIL_CAPS.overall).toBeLessThan(100);
    expect(INBOX_EMAIL_CAPS.perCompany).toBeLessThanOrEqual(INBOX_EMAIL_CAPS.overall);
  });

  it("allows an email until either cap is reached", () => {
    expect(emailFits({ company: 0, overall: 0 })).toBe(true);
    expect(emailFits({ company: 29, overall: 79 })).toBe(true);
    expect(emailFits({ company: 30, overall: 30 })).toBe(false);
    expect(emailFits({ company: 1, overall: 80 })).toBe(false);
    expect(emailFits({ company: 0, overall: 0 }, { perCompany: 0, overall: 10 })).toBe(false);
  });
});

describe("attendance settings", () => {
  const parse = (late: string, noShow: string) =>
    attendanceSettingsSchema.safeParse({ lateGraceMinutes: late, noShowAfterMinutes: noShow });

  it("accepts the defaults and the edges", () => {
    expect(parse("10", "60").data).toEqual({ lateGraceMinutes: 10, noShowAfterMinutes: 60 });
    expect(parse("0", "15").success).toBe(true);
    expect(parse("120", "480").success).toBe(true);
    expect(parse("20", "20").success).toBe(true);
  });

  it.each([
    ["-1", "60"],
    ["121", "200"],
    ["10", "14"],
    ["10", "481"],
    ["100", "30"],
    ["1.5", "60"],
    ["", "60"],
  ])("refuses %s and %s", (late, noShow) => expect(parse(late, noShow).success).toBe(false));
});

describe("consent notices", () => {
  it("version every notice as YYYY-MM-DD.n, as the database expects", () => {
    for (const notice of Object.values(CONSENT_NOTICES)) {
      expect(notice.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/);
      expect(notice.body.length).toBeGreaterThan(0);
    }
  });
});
