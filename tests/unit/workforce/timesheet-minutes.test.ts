/**
 * Slice 4.2: the minute rules of a timesheet day (src/lib/timesheets/minutes.ts, mirrored in
 * private.timesheet_line_compute; tests/rls/timesheets.test.ts checks the two agree).
 * Times are Africa/Lagos (UTC+1, no daylight saving).
 */
import { describe, expect, it } from "vitest";

import {
  computeLine,
  correctionReasonOk,
  formatMinutes,
  periodEnd,
  periodFor,
  periodStart,
  type LineInput,
} from "@/lib/timesheets/minutes";

/** Lagos wall-clock time to ms epoch. */
const lagos = (iso: string) => Date.parse(`${iso}+01:00`);

const DAY: LineInput = {
  startsAt: lagos("2026-11-10T07:00:00"),
  endsAt: lagos("2026-11-10T19:00:00"),
  inAt: null,
  outAt: null,
  setMinutes: null,
  setOtMinutes: null,
  inFlags: [],
  outFlags: [],
  bySupervisor: false,
  corrected: false,
  shiftRemoved: false,
  graceMinutes: 10,
  noShowAfterMinutes: 60,
  now: lagos("2026-11-11T09:00:00"),
};

const day = (patch: Partial<LineInput>) => computeLine({ ...DAY, ...patch });

describe("the accept examples (07:00 to 19:00)", () => {
  it("in 07:08, out 19:20: 720 worked and 20 overtime", () => {
    const m = day({ inAt: lagos("2026-11-10T07:08:00"), outAt: lagos("2026-11-10T19:20:00") });
    expect(m).toMatchObject({
      scheduledMinutes: 720,
      workedMinutes: 720,
      lateMinutes: 0,
      earlyMinutes: 0,
      otMinutes: 20,
      exceptions: ["overtime"],
      needsReview: false,
    });
  });

  it("in 07:25: 695 worked, 25 late, flagged late", () => {
    const m = day({ inAt: lagos("2026-11-10T07:25:00"), outAt: lagos("2026-11-10T19:00:00") });
    expect(m).toMatchObject({ workedMinutes: 695, lateMinutes: 25, exceptions: ["late"] });
  });

  it("no clock-out: 0 until a correction sets one", () => {
    const missing = day({ inAt: lagos("2026-11-10T07:05:00") });
    expect(missing).toMatchObject({ workedMinutes: 0, exceptions: ["no_clock_out"] });
    const fixed = day({
      inAt: lagos("2026-11-10T07:05:00"),
      outAt: lagos("2026-11-10T19:00:00"),
      corrected: true,
    });
    expect(fixed).toMatchObject({ workedMinutes: 720, exceptions: ["corrected"] });
  });
});

describe("grace edges", () => {
  it("10 minutes late is within grace: a full shift", () => {
    const m = day({ inAt: lagos("2026-11-10T07:10:00"), outAt: lagos("2026-11-10T19:00:00") });
    expect(m).toMatchObject({ workedMinutes: 720, lateMinutes: 0, exceptions: [] });
  });

  it("10 minutes 59 seconds counts as 10 (times truncate to the minute)", () => {
    const m = day({ inAt: lagos("2026-11-10T07:10:59"), outAt: lagos("2026-11-10T19:00:00") });
    expect(m.lateMinutes).toBe(0);
  });

  it("11 minutes late counts from the clock-in and is late", () => {
    const m = day({ inAt: lagos("2026-11-10T07:11:00"), outAt: lagos("2026-11-10T19:00:00") });
    expect(m).toMatchObject({ workedMinutes: 709, lateMinutes: 11, exceptions: ["late"] });
  });

  it("a grace of 0 makes one minute late", () => {
    const m = day({
      graceMinutes: 0,
      inAt: lagos("2026-11-10T07:01:00"),
      outAt: lagos("2026-11-10T19:00:00"),
    });
    expect(m).toMatchObject({ workedMinutes: 719, lateMinutes: 1 });
  });

  it("an early clock-in counts from the rostered start, with no overtime for arriving early", () => {
    const m = day({ inAt: lagos("2026-11-10T06:30:00"), outAt: lagos("2026-11-10T19:00:00") });
    expect(m).toMatchObject({ workedMinutes: 720, otMinutes: 0, exceptions: [] });
  });
});

describe("leaving early and overtime", () => {
  it("leaving 30 minutes early counts the actual minutes (no grace)", () => {
    const m = day({ inAt: lagos("2026-11-10T07:00:00"), outAt: lagos("2026-11-10T18:30:00") });
    expect(m).toMatchObject({ workedMinutes: 690, earlyMinutes: 30, exceptions: ["early_out"] });
  });

  it("leaving one minute early is early", () => {
    const m = day({ inAt: lagos("2026-11-10T07:00:00"), outAt: lagos("2026-11-10T18:59:30") });
    expect(m).toMatchObject({ workedMinutes: 719, earlyMinutes: 1 });
  });

  it("late and early together", () => {
    const m = day({ inAt: lagos("2026-11-10T07:40:00"), outAt: lagos("2026-11-10T18:00:00") });
    expect(m).toMatchObject({
      workedMinutes: 620,
      lateMinutes: 40,
      earlyMinutes: 60,
      exceptions: ["late", "early_out"],
    });
  });

  it("clocking out exactly at the end is neither", () => {
    const m = day({ inAt: lagos("2026-11-10T07:00:00"), outAt: lagos("2026-11-10T19:00:45") });
    expect(m).toMatchObject({ workedMinutes: 720, otMinutes: 0, exceptions: [] });
  });
});

describe("missing punches", () => {
  it("no clock-in: no-show once no_show_after_minutes have passed, nothing before", () => {
    expect(day({ now: lagos("2026-11-10T07:59:00") }).exceptions).toEqual([]);
    expect(day({ now: lagos("2026-11-10T08:00:00") })).toMatchObject({
      workedMinutes: 0,
      exceptions: ["no_show"],
    });
  });

  it("no clock-out: nothing while the window is open, no_clock_out once it closes (end + 4 h)", () => {
    const open = day({ inAt: lagos("2026-11-10T07:00:00"), now: lagos("2026-11-10T22:59:00") });
    expect(open).toMatchObject({ workedMinutes: 0, exceptions: [] });
    const closed = day({ inAt: lagos("2026-11-10T07:00:00"), now: lagos("2026-11-10T23:00:00") });
    expect(closed.exceptions).toEqual(["no_clock_out"]);
  });
});

describe("night shifts across midnight", () => {
  const NIGHT: Partial<LineInput> = {
    startsAt: lagos("2026-11-10T19:00:00"),
    endsAt: lagos("2026-11-11T07:00:00"),
    now: lagos("2026-11-12T09:00:00"),
  };

  it("counts across midnight with overtime after 07:00", () => {
    const m = day({
      ...NIGHT,
      inAt: lagos("2026-11-10T18:55:00"),
      outAt: lagos("2026-11-11T07:15:00"),
    });
    expect(m).toMatchObject({ scheduledMinutes: 720, workedMinutes: 720, otMinutes: 15 });
  });

  it("late after midnight is still late against the 19:00 start", () => {
    const m = day({
      ...NIGHT,
      inAt: lagos("2026-11-11T00:30:00"),
      outAt: lagos("2026-11-11T07:00:00"),
    });
    expect(m).toMatchObject({ workedMinutes: 390, lateMinutes: 330, exceptions: ["late"] });
  });

  it("belongs to the pay period of the day it starts", () => {
    // A night shift starting on the 19th ends on the 20th: it stays in the period ending the 19th.
    expect(periodStart("2026-11-19", 20)).toBe("2026-10-20");
    expect(periodStart("2026-11-20", 20)).toBe("2026-11-20");
  });
});

describe("no-shift clock-ins", () => {
  const LONE: Partial<LineInput> = { startsAt: null, endsAt: null };

  it("count from clock-in to clock-out, with no schedule and no overtime", () => {
    const m = day({
      ...LONE,
      inAt: lagos("2026-11-10T08:00:00"),
      outAt: lagos("2026-11-10T16:30:00"),
    });
    expect(m).toMatchObject({
      scheduledMinutes: 0,
      workedMinutes: 510,
      otMinutes: 0,
      exceptions: ["no_shift"],
    });
  });

  it("never count more than a 24-hour day (security review M1)", () => {
    const m = day({
      ...LONE,
      inAt: lagos("2026-11-10T07:00:00"),
      outAt: lagos("2026-11-11T13:00:00"),
    });
    expect(m.workedMinutes).toBe(1440);
    const shift = day({
      inAt: lagos("2026-11-10T07:00:00"),
      outAt: lagos("2026-11-12T07:00:00"),
    });
    expect(shift.otMinutes).toBe(1440);
  });

  it("with no clock-out: 0, and no_clock_out once 20 hours have passed", () => {
    const early = day({
      ...LONE,
      inAt: lagos("2026-11-10T08:00:00"),
      now: lagos("2026-11-11T03:59:00"),
    });
    expect(early.exceptions).toEqual(["no_shift"]);
    const late = day({
      ...LONE,
      inAt: lagos("2026-11-10T08:00:00"),
      now: lagos("2026-11-11T04:00:00"),
    });
    expect(late).toMatchObject({ workedMinutes: 0, exceptions: ["no_shift", "no_clock_out"] });
  });
});

describe("flags and corrections", () => {
  it("copies the punch flags in order, and only delayed, late_sync and time_unverified need review", () => {
    const m = day({
      inAt: lagos("2026-11-10T07:00:00"),
      outAt: lagos("2026-11-10T19:00:00"),
      inFlags: ["outside", "late", "no_selfie", "no_shift"],
      outFlags: ["double_in", "clock_drift", "out_without_in"],
    });
    expect(m.exceptions).toEqual([
      "outside",
      "no_selfie",
      "clock_drift",
      "double_in",
      "out_without_in",
    ]);
    expect(m.needsReview).toBe(false);
    for (const flag of ["delayed", "late_sync", "time_unverified"]) {
      expect(day({ inFlags: [flag] }).needsReview, flag).toBe(true);
    }
  });

  it("a supervisor punch's no_location is copied but never alone sets needs_review", () => {
    const m = day({
      inAt: lagos("2026-11-10T07:00:00"),
      outAt: lagos("2026-11-10T19:00:00"),
      inFlags: ["no_location", "no_selfie"],
      bySupervisor: true,
    });
    expect(m.exceptions).toEqual(["no_location", "no_selfie", "supervisor"]);
    expect(m.needsReview).toBe(false);
  });

  it("set_minutes replaces the worked and overtime minutes and clears the minute rules", () => {
    const m = day({
      inAt: lagos("2026-11-10T07:30:00"),
      setMinutes: 600,
      setOtMinutes: 30,
      corrected: true,
    });
    expect(m).toMatchObject({
      workedMinutes: 600,
      otMinutes: 30,
      lateMinutes: 0,
      exceptions: ["corrected"],
    });
  });

  it("marks a day whose shift was taken off after the punches", () => {
    const m = day({
      inAt: lagos("2026-11-10T07:00:00"),
      outAt: lagos("2026-11-10T19:00:00"),
      shiftRemoved: true,
    });
    expect(m.exceptions).toEqual(["shift_removed"]);
  });
});

describe("pay periods (pay_cycle_start_day)", () => {
  it("runs from the 20th to the 19th", () => {
    expect(periodFor("2026-11-21", 20)).toEqual({ start: "2026-11-20", end: "2026-12-19" });
    expect(periodFor("2026-11-19", 20)).toEqual({ start: "2026-10-20", end: "2026-11-19" });
  });

  it("crosses the year", () => {
    expect(periodFor("2026-01-05", 20)).toEqual({ start: "2025-12-20", end: "2026-01-19" });
    expect(periodEnd("2026-12-20")).toBe("2027-01-19");
  });

  it("a start day of 1 is the calendar month", () => {
    expect(periodFor("2026-02-14", 1)).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("a start day of 28 handles February", () => {
    expect(periodFor("2026-03-10", 28)).toEqual({ start: "2026-02-28", end: "2026-03-27" });
  });
});

describe("correction reasons", () => {
  it("accepts plain text", () => {
    expect(correctionReasonOk("Phone died; gate log shows 19:05")).toBe(true);
  });

  it("refuses empty, untrimmed, long, links, markup and long numbers", () => {
    expect(correctionReasonOk("")).toBe(false);
    expect(correctionReasonOk(" padded")).toBe(false);
    expect(correctionReasonOk("x".repeat(501))).toBe(false);
    expect(correctionReasonOk("see https://example.com")).toBe(false);
    expect(correctionReasonOk("see www.example.com")).toBe(false);
    expect(correctionReasonOk("<b>bold</b>")).toBe(false);
    expect(correctionReasonOk("call 0803 123 4567")).toBe(false);
    expect(correctionReasonOk("account 0123456789")).toBe(false);
    expect(correctionReasonOk("ref 123456789")).toBe(true);
  });
});

describe("formatMinutes", () => {
  it("reads as hours and minutes", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(720)).toBe("12 h");
    expect(formatMinutes(740)).toBe("12 h 20 min");
  });
});
