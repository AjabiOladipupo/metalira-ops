import { describe, expect, it } from "vitest";

import {
  addDays,
  firstOfNextMonth,
  formatDate,
  formatDateTime,
  isWithin,
  lagosToday,
} from "@/lib/dates";

describe("dates", () => {
  it("formats ISO dates as 14 Nov 2026", () => {
    expect(formatDate("2026-11-14")).toBe("14 Nov 2026");
    expect(formatDate("2027-01-01")).toBe("1 Jan 2027");
    expect(() => formatDate("14/11/2026")).toThrow(RangeError);
  });

  it("gives today's date in Lagos, not UTC", () => {
    // 23:30 UTC on 30 Nov is 00:30 on 1 Dec in Lagos (UTC+1).
    expect(lagosToday(new Date("2026-11-30T23:30:00Z"))).toBe("2026-12-01");
    expect(lagosToday(new Date("2026-11-30T22:30:00Z"))).toBe("2026-11-30");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("finds the first of next month", () => {
    expect(firstOfNextMonth("2026-11-16")).toBe("2026-12-01");
    expect(firstOfNextMonth("2026-12-31")).toBe("2027-01-01");
  });

  it("checks a date against a dated range, open-ended when to is null", () => {
    expect(isWithin("2026-11-16", "2026-11-01", null)).toBe(true);
    expect(isWithin("2026-11-16", "2026-11-16", "2026-11-16")).toBe(true);
    expect(isWithin("2026-11-16", "2026-11-17", null)).toBe(false);
    expect(isWithin("2026-11-16", "2026-10-01", "2026-11-15")).toBe(false);
  });

  it("formats a moment in Lagos time on a 24-hour clock", () => {
    expect(formatDateTime("2026-11-19T13:05:00Z")).toBe("19 Nov 2026, 14:05");
    // Just before midnight UTC is already the next day in Lagos.
    expect(formatDateTime(new Date("2026-12-31T23:30:00Z"))).toBe("1 Jan 2027, 00:30");
    expect(formatDateTime("2026-09-02T09:00:00+01:00")).toBe("2 Sep 2026, 09:00");
    expect(() => formatDateTime("not a date")).toThrow(RangeError);
  });
});
