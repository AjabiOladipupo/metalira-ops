/**
 * Slice 4.4: counting leave days (owner decision 3) and the leave year's maths. The database
 * counts the same way (private.leave_count_days, private.leave_prorate); tests/rls/leave-requests
 * checks the SQL side on the same cases.
 */
import { describe, expect, it } from "vitest";

import {
  countLeaveDays,
  formatDayCount,
  formatShiftCover,
  isoWeekday,
  spanDays,
  type LeaveCalendar,
} from "@/lib/leave/days";
import {
  carryOver,
  cleanLeaveText,
  formatLeaveRange,
  ledgerBalance,
  prorateSigned,
  serviceMonths,
  versionAdjustment,
} from "@/lib/leave/requests";

const MON_FRI = [1, 2, 3, 4, 5];

function calendar(over: Partial<LeaveCalendar> = {}): LeaveCalendar {
  return {
    workDays: MON_FRI,
    lastRostered: null,
    holidays: new Set(),
    shifts: [],
    ...over,
  };
}

describe("countLeaveDays", () => {
  it("knows the weekdays (2 Nov 2026 is a Monday)", () => {
    expect(isoWeekday("2026-11-02")).toBe(1);
    expect(isoWeekday("2026-11-08")).toBe(7);
    expect(spanDays("2026-11-02", "2026-11-08")).toBe(7);
    expect(spanDays("2026-11-08", "2026-11-02")).toBe(0);
  });

  it("skips off-days with no roster: Fri to Tue is 3 working days", () => {
    expect(countLeaveDays("2026-11-06", "2026-11-10", "working_days", calendar()).days).toBe(3);
  });

  it("skips the company's holidays", () => {
    const cal = calendar({ holidays: new Set(["2026-12-25", "2026-12-28"]) });
    // Thu 24 to Tue 29 Dec: Thu, (Fri hol), Mon hol, Tue = 2.
    expect(countLeaveDays("2026-12-24", "2026-12-29", "working_days", cal).days).toBe(2);
  });

  it("uses the worker's own week", () => {
    const cal = calendar({ workDays: [1, 2, 3, 4, 5, 6] });
    expect(countLeaveDays("2026-11-02", "2026-11-08", "working_days", cal).days).toBe(6);
  });

  it("counts rostered shifts first, then usual days beyond the last rostered day", () => {
    // Rostered Sat 7 and Sun 8 Nov (weekend shifts), last rostered day Sun 8. Mon 2 to Fri 6 have
    // no shift and fall on or before the last rostered day: off-days. Mon 9 and Tue 10 are beyond
    // the roster and count by the usual week.
    const cal = calendar({
      lastRostered: "2026-11-08",
      shifts: [
        { date: "2026-11-07", site: "Gate A" },
        { date: "2026-11-08", site: "Gate A" },
      ],
    });
    const count = countLeaveDays("2026-11-02", "2026-11-10", "working_days", cal);
    expect(count).toEqual({ days: 4, shifts: 2, sites: ["Gate A"] });
  });

  it("does not count a rostered day that is a holiday", () => {
    const cal = calendar({
      lastRostered: "2026-12-25",
      holidays: new Set(["2026-12-25"]),
      shifts: [{ date: "2026-12-25", site: "Lekki Mall" }],
    });
    expect(countLeaveDays("2026-12-25", "2026-12-25", "working_days", cal)).toEqual({
      days: 0,
      shifts: 1,
      sites: ["Lekki Mall"],
    });
  });

  it("counts every day for calendar-day types (maternity: 12 weeks is 84 days)", () => {
    const cal = calendar({ holidays: new Set(["2026-12-25"]) });
    expect(countLeaveDays("2026-11-02", "2027-01-24", "calendar_days", cal).days).toBe(84);
  });

  it("returns nothing for an empty or reversed range, and refuses more than a year", () => {
    expect(countLeaveDays("2026-11-10", "2026-11-09", "working_days", calendar()).days).toBe(0);
    expect(() => countLeaveDays("2026-01-01", "2027-06-01", "calendar_days", calendar())).toThrow(
      RangeError,
    );
  });

  it("words the count and the shifts it covers", () => {
    expect(formatDayCount(3, "working_days")).toBe("3 working days");
    expect(formatDayCount(1, "calendar_days")).toBe("1 calendar day");
    expect(formatShiftCover({ shifts: 3, sites: ["Gate A"] })).toBe(
      "Covers 3 rostered shifts at Gate A.",
    );
    expect(formatShiftCover({ shifts: 1, sites: ["Gate A", "Lekki Mall"] })).toBe(
      "Covers 1 rostered shift at Gate A and Lekki Mall.",
    );
    expect(formatShiftCover({ shifts: 0, sites: [] })).toBe("No rostered shifts.");
  });
});

describe("the leave year", () => {
  it("prorates a joiner half up, and a lowering version half away from zero", () => {
    // 15 days, joined 1 Jul 2026: 184 of 365 days → 7.56 → 8.
    expect(prorateSigned(15, "2026-07-01", 2026)).toBe(8);
    expect(prorateSigned(-15, "2026-07-01", 2026)).toBe(-8);
    expect(prorateSigned(0, "2026-07-01", 2026)).toBe(0);
  });

  it("adds a mid-year version only from its own date", () => {
    // 15 to 18 days from 1 Oct 2026: +3 × 92/365 = 0.76 → 1.
    expect(versionAdjustment(15, 18, "2026-10-01", "2025-01-06", 2026)).toBe(1);
    // 15 to 21 from 2 Jul: +6 × 183/365 = 3.01 → 3.
    expect(versionAdjustment(15, 21, "2026-07-02", "2025-01-06", 2026)).toBe(3);
    // A worker who joined after the change gets it from their start.
    expect(versionAdjustment(15, 21, "2026-07-02", "2026-12-01", 2026)).toBe(
      prorateSigned(6, "2026-12-01", 2026),
    );
    // A version from 1 January is the year's grant, not an adjustment.
    expect(versionAdjustment(15, 18, "2026-01-01", "2025-01-06", 2026)).toBe(0);
    expect(versionAdjustment(18, 12, "2026-07-02", "2025-01-06", 2026)).toBe(-3);
  });

  it("carries over up to the cap, never a negative remainder, none without a cap", () => {
    expect(carryOver(7, 5)).toBe(5);
    expect(carryOver(3, 5)).toBe(3);
    expect(carryOver(-2, 5)).toBe(0);
    expect(carryOver(7, null)).toBe(0);
    expect(carryOver(7, 0)).toBe(0);
  });

  it("sums the ledger for a balance", () => {
    expect(
      ledgerBalance([
        { kind: "grant", days: 15 },
        { kind: "carry_over", days: 3 },
        { kind: "taken", days: -3 },
        { kind: "returned", days: 3 },
        { kind: "adjustment", days: -1 },
      ]),
    ).toBe(17);
  });

  it("counts whole months of service", () => {
    expect(serviceMonths("2026-01-06", "2026-07-05")).toBe(5);
    expect(serviceMonths("2026-01-06", "2026-07-06")).toBe(6);
    expect(serviceMonths("2026-07-06", "2026-01-06")).toBe(0);
  });
});

describe("words and text", () => {
  it("words a range", () => {
    expect(formatLeaveRange("2026-11-30", "2026-12-02")).toBe("30 Nov to 2 Dec 2026");
    expect(formatLeaveRange("2026-11-04", "2026-11-06")).toBe("4 to 6 Nov 2026");
    expect(formatLeaveRange("2026-11-04", "2026-11-04")).toBe("4 Nov 2026");
    expect(formatLeaveRange("2026-11-04", "2026-11-06", false)).toBe("4 to 6 Nov");
  });

  it("keeps reasons plain: no web addresses, markup or personal numbers", () => {
    expect(cleanLeaveText("  Family visit  ")).toBe("Family visit");
    expect(cleanLeaveText("")).toBeNull();
    expect(cleanLeaveText("see www.example.com")).toBeNull();
    expect(cleanLeaveText("<b>hi</b>")).toBeNull();
    expect(cleanLeaveText("call 0803 123 4567")).toBeNull();
    expect(cleanLeaveText("back on 21/11/2026 at 08:00")).toBe("back on 21/11/2026 at 08:00");
    expect(cleanLeaveText("x".repeat(501))).toBeNull();
  });
});
