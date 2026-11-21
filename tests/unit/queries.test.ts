import { describe, expect, it } from "vitest";

import { inboxMessageSchema } from "@/lib/inbox";
import {
  MAX_REPLY_DAYS,
  QUERY_LIMITS,
  hasLongDigitRun,
  hasWebAddress,
  isQueryOpen,
  isQueryOverdue,
  newQueryNotice,
  normaliseQueryText,
  queryClosedNotice,
  queryFollowUpNotice,
  queryReminderNotice,
  queryStatusLabel,
  queryText,
  queryTextProblem,
  replyByRange,
  summariseQueries,
} from "@/lib/queries";

/**
 * Slice 4.6: the query text rule (mirrored by private.staff_query_text_ok; tests/rls/queries
 * checks the database refuses the same cases), overdue worked out on read, and the worker notices
 * staying inside the inbox rules.
 */

describe("query text", () => {
  const body = QUERY_LIMITS.body;

  it("accepts plain facts with dates and times", () => {
    for (const text of [
      "You clocked in at 06:41 for your 06:00 shift at Gate A. Please explain what happened.",
      "Absent on 21/11/2026 and 22/11/2026 without leave.",
      "Seen sleeping on post at 02:15.\nSecond line.",
      "Ref 12345 6789",
    ]) {
      expect(queryTextProblem(text, body, true), text).toBeNull();
    }
  });

  it("refuses web addresses, including bare domains", () => {
    for (const text of [
      "See https://example.test",
      "Go to www.pay-me.test",
      "Pay into acme-pay.com today",
      "Visit pay.ng",
      "Send it to SITE.COM",
    ]) {
      expect(hasWebAddress(text), text).toBe(true);
      expect(queryTextProblem(text, body, true), text).toBe("web");
    }
    // A full stop between words is not an address.
    expect(hasWebAddress("He left at 06:00.Then he came back")).toBe(false);
    expect(hasWebAddress("Mr. Adebayo saw it")).toBe(false);
  });

  it("refuses runs of 10 or more digits, as the inbox rule", () => {
    for (const text of ["Call 08031234567", "Call 0803 123 4567", "Account 0123-456-789"]) {
      expect(hasLongDigitRun(text), text).toBe(true);
      expect(queryTextProblem(text, body, true), text).toBe("number");
    }
    expect(hasLongDigitRun("123456789")).toBe(false);
    expect(hasLongDigitRun("21/11/2026 08:00")).toBe(false);
  });

  it("refuses markup and control characters; line breaks only where allowed", () => {
    expect(queryTextProblem("Hello <b>there</b>", body, true)).toBe("markup");
    expect(queryTextProblem("Tab\there", body, true)).toBe("markup");
    expect(queryTextProblem("Line\nbreak", QUERY_LIMITS.subject, false)).toBe("markup");
    expect(queryTextProblem("Line\nbreak", body, true)).toBeNull();
  });

  it("checks the length after trimming and normalising line breaks", () => {
    expect(normaliseQueryText("  Late\r\nagain \r ")).toBe("Late\nagain");
    expect(queryTextProblem("ab", QUERY_LIMITS.subject, false)).toBe("length");
    expect(queryTextProblem("x".repeat(121), QUERY_LIMITS.subject, false)).toBe("length");
    expect(queryTextProblem("x".repeat(120), QUERY_LIMITS.subject, false)).toBeNull();
    expect(queryTextProblem("ok", QUERY_LIMITS.reply, true)).toBeNull();
  });

  it("builds a Zod field that normalises and explains", () => {
    const field = queryText("subject", QUERY_LIMITS.subject, false);
    expect(field.parse("  Lateness on 23 October ")).toBe("Lateness on 23 October");
    const refused = field.safeParse("See acme.com");
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("Leave web addresses out.");
    expect(field.safeParse("ab").error?.issues[0]?.message).toBe(
      "The subject needs 3 to 120 characters.",
    );
  });
});

describe("overdue and status", () => {
  const today = "2026-11-21";

  it("is overdue only while awaiting a reply after the reply-by date", () => {
    expect(isQueryOverdue({ status: "awaiting_reply", replyBy: "2026-11-20" }, today)).toBe(true);
    expect(isQueryOverdue({ status: "awaiting_reply", replyBy: "2026-11-21" }, today)).toBe(false);
    expect(isQueryOverdue({ status: "replied", replyBy: "2026-11-01" }, today)).toBe(false);
    expect(isQueryOverdue({ status: "closed", replyBy: "2026-11-01" }, today)).toBe(false);
  });

  it("labels each status, overdue first", () => {
    expect(queryStatusLabel({ status: "awaiting_reply", replyBy: "2026-11-20" }, today)).toBe(
      "Overdue",
    );
    expect(queryStatusLabel({ status: "awaiting_reply", replyBy: "2026-11-24" }, today)).toBe(
      "Awaiting reply",
    );
    expect(queryStatusLabel({ status: "replied", replyBy: "2026-11-24" }, today)).toBe("Replied");
    expect(queryStatusLabel({ status: "withdrawn", replyBy: "2026-11-24" }, today)).toBe(
      "Withdrawn",
    );
    expect(isQueryOpen("replied")).toBe(true);
    expect(isQueryOpen("closed")).toBe(false);
  });

  it("counts for the HR file heading", () => {
    expect(
      summariseQueries(
        [
          { status: "awaiting_reply", replyBy: "2026-11-20" },
          { status: "awaiting_reply", replyBy: "2026-11-25" },
          { status: "replied", replyBy: "2026-11-10" },
          { status: "closed", replyBy: "2026-11-01" },
        ],
        today,
      ),
    ).toEqual({ total: 4, open: 3, overdue: 1, closed: 1 });
  });

  it("allows reply-by dates from today to 60 days ahead", () => {
    expect(replyByRange(today)).toEqual({ min: "2026-11-21", max: "2027-01-20" });
    expect(MAX_REPLY_DAYS).toBe(60);
  });
});

describe("worker notices", () => {
  const subject = "Lateness on 23 October";

  it("pass the inbox rules and link to /m/queries", () => {
    for (const notice of [
      newQueryNotice({ subject, replyBy: "2026-11-24" }),
      queryReminderNotice({ subject, replyBy: "2026-11-24" }),
      queryFollowUpNotice({ subject }),
      queryClosedNotice({ subject }),
    ]) {
      expect(inboxMessageSchema.safeParse(notice).success, notice.title).toBe(true);
      expect(notice.link).toBe("/m/queries");
    }
    expect(newQueryNotice({ subject, replyBy: "2026-11-24" }).body).toBe(
      "Reply by 24 Nov 2026. Open Queries in the app to read it and reply.",
    );
  });

  it("never carries the query's text, and keeps a long subject inside the title limit", () => {
    const long = "x".repeat(120);
    const notice = newQueryNotice({ subject: long, replyBy: "2026-11-24" });
    expect(notice.title.length).toBeLessThanOrEqual(120);
    expect(notice.title).toBe(notice.title.trim());
    expect(inboxMessageSchema.safeParse(notice).success).toBe(true);
  });
});
