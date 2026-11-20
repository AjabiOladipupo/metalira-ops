/**
 * Slice 3.2: the roster week (src/lib/roster.ts). Weeks start on Monday by the company's calendar
 * (Lagos keeps West Africa Time all year, so there is no daylight saving to cross); a night shift
 * belongs to the day it starts, in that day's column and week; the grid counts person-shifts
 * required, covered and open, and marks assignments whose copied hours differ from today's
 * requirement.
 */
import { describe, expect, it } from "vitest";

import {
  buildRosterWeek,
  dayLabel,
  formatCoverage,
  formatDayCounts,
  formatHoursTotal,
  formatShiftHours,
  formatShortDay,
  formatWeekOf,
  minutesBetween,
  mondayOf,
  parseWeekParam,
  weekDates,
  type RequiredShift,
  type RosterAssignment,
} from "@/lib/roster";

const LAGOS = "Africa/Lagos";

/** A Lagos wall-clock time as an ISO timestamp (UTC+1, no DST). */
function lagos(date: string, time: string): string {
  return new Date(`${date}T${time}:00+01:00`).toISOString();
}

function shift(
  postId: string,
  postName: string,
  date: string,
  start: string,
  end: string,
  requiredCount = 1,
): RequiredShift {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const endDate = end <= start ? next.toISOString().slice(0, 10) : date;
  return {
    postId,
    postName,
    siteId: "site",
    date,
    startsAt: lagos(date, start),
    endsAt: lagos(endDate, end),
    requiredCount,
  };
}

function assignment(
  id: string,
  required: RequiredShift,
  workerName: string,
  overrides: Partial<RosterAssignment> = {},
): RosterAssignment {
  return {
    id,
    shiftId: `shift-${required.postId}-${required.date}`,
    postId: required.postId,
    date: required.date,
    workerId: `w-${workerName}`,
    workerName,
    staffId: "EMP-0001",
    startsAt: required.startsAt,
    endsAt: required.endsAt,
    mapped: true,
    ...overrides,
  };
}

describe("week maths", () => {
  it("starts every week on Monday", () => {
    expect(mondayOf("2026-11-23")).toBe("2026-11-23");
    expect(mondayOf("2026-11-26")).toBe("2026-11-23");
    expect(mondayOf("2026-11-29")).toBe("2026-11-23");
    expect(mondayOf("2026-11-30")).toBe("2026-11-30");
  });

  it("crosses months and years", () => {
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
    expect(weekDates("2026-12-28")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
    // 2028 is a leap year.
    expect(weekDates("2028-02-28")[1]).toBe("2028-02-29");
  });

  it("reads ?week= as the Monday of that week, else this week", () => {
    expect(parseWeekParam("2026-11-27", "2026-11-20")).toBe("2026-11-23");
    expect(parseWeekParam(undefined, "2026-11-20")).toBe("2026-11-16");
    expect(parseWeekParam("next week", "2026-11-20")).toBe("2026-11-16");
    expect(parseWeekParam("2026-11-20T00:00", "2026-11-20")).toBe("2026-11-16");
  });

  it("labels days and weeks the design-system way", () => {
    expect(formatWeekOf("2026-11-23")).toBe("Week of 23 Nov 2026");
    expect(dayLabel("2026-11-28")).toEqual({ short: "Sat", long: "Saturday", date: "28" });
    expect(formatShortDay("2026-12-01")).toBe("Tue 1 Dec");
  });

  it("shows times in Lagos time on a 24-hour clock", () => {
    const night = shift("p", "Gate A · Night", "2026-11-29", "18:00", "06:00");
    expect(formatShiftHours(night.startsAt, night.endsAt, LAGOS)).toBe("18:00–06:00");
    expect(minutesBetween(night.startsAt, night.endsAt)).toBe(720);
    expect(formatHoursTotal(2160)).toBe("36 h");
    expect(formatHoursTotal(2250)).toBe("37.5 h");
    expect(formatHoursTotal(0)).toBe("0 h");
  });
});

describe("buildRosterWeek", () => {
  const week = "2026-11-23";
  const days = weekDates(week);
  const dayShifts = days.map((d) => shift("day", "Gate A · Day", d, "06:00", "18:00"));
  const nightShifts = days.map((d) => shift("night", "Gate A · Night", d, "18:00", "06:00", 2));

  it("puts an overnight shift in the column of the day it starts", () => {
    // Sunday night runs into Monday 30 Nov, next week, but belongs to Sunday 29 Nov.
    const sunday = nightShifts[6]!;
    const roster = buildRosterWeek({
      weekStart: week,
      required: [sunday],
      assignments: [assignment("a1", sunday, "Daniel Okafor")],
      timeZone: LAGOS,
    });
    const row = roster.posts[0]!;
    expect(row.cells.map((c) => c.required)).toEqual([null, null, null, null, null, null, 2]);
    expect(row.cells[6]!.assigned.map((a) => a.workerName)).toEqual(["Daniel Okafor"]);
    expect(row.cells[6]!.open).toBe(1);
    expect(row.hours).toBe("18:00–06:00");
    // Next week's grid doesn't show it.
    const next = buildRosterWeek({
      weekStart: "2026-11-30",
      required: [sunday],
      assignments: [assignment("a1", sunday, "Daniel Okafor")],
      timeZone: LAGOS,
    });
    expect(next.posts).toEqual([]);
  });

  it("counts required, scheduled and open per day and for the week", () => {
    const roster = buildRosterWeek({
      weekStart: week,
      required: [...dayShifts, ...nightShifts],
      assignments: [
        ...dayShifts.map((s, i) => assignment(`d${i}`, s, "Musa Ibrahim")),
        assignment("n0", nightShifts[0]!, "Ibrahim Sule"),
        assignment("n1", nightShifts[0]!, "Daniel Okafor"),
        assignment("n2", nightShifts[1]!, "Daniel Okafor"),
      ],
      timeZone: LAGOS,
    });
    // Posts in order of start time: day first.
    expect(roster.posts.map((p) => p.name)).toEqual(["Gate A · Day", "Gate A · Night"]);
    expect(roster.days[0]).toEqual({ date: "2026-11-23", required: 3, scheduled: 3, gap: false });
    expect(roster.days[1]).toEqual({ date: "2026-11-24", required: 3, scheduled: 2, gap: true });
    expect(formatDayCounts(roster.days[1]!)).toBe("Required 3 · Scheduled 2");
    expect(roster.totals).toEqual({ required: 21, covered: 10, open: 11 });
    expect(formatCoverage(roster.totals)).toBe("10 of 21 shifts covered · 11 open");
    expect(roster.uncovered[0]).toMatchObject({
      postName: "Gate A · Night",
      date: "2026-11-24",
      open: 1,
    });
    expect(roster.uncovered).toHaveLength(6);
    // Names sorted inside a cell.
    expect(roster.posts[1]!.cells[0]!.assigned.map((a) => a.workerName)).toEqual([
      "Daniel Okafor",
      "Ibrahim Sule",
    ]);
  });

  it("never counts more covered than required, and keeps assignments on days no longer staffed", () => {
    const monday = shift("day", "Gate A · Day", days[0]!, "06:00", "18:00", 1);
    const tuesday = shift("day", "Gate A · Day", days[1]!, "06:00", "18:00", 1);
    const roster = buildRosterWeek({
      weekStart: week,
      // The requirement dropped Tuesday after Kunle was assigned.
      required: [monday],
      assignments: [
        assignment("a", monday, "Musa Ibrahim"),
        assignment("b", monday, "Kunle Ade"),
        assignment("c", tuesday, "Kunle Ade"),
      ],
      timeZone: LAGOS,
    });
    expect(roster.totals).toEqual({ required: 1, covered: 1, open: 0 });
    const cells = roster.posts[0]!.cells;
    expect(cells[0]!.open).toBe(0);
    expect(cells[1]!.required).toBeNull();
    expect(cells[1]!.assigned.map((a) => a.workerName)).toEqual(["Kunle Ade"]);
    expect(roster.days[1]).toMatchObject({ required: 0, scheduled: 1, gap: false });
  });

  it("marks assignments whose hours differ from today's requirement", () => {
    const monday = shift("day", "Gate A · Day", days[0]!, "07:00", "19:00");
    const roster = buildRosterWeek({
      weekStart: week,
      required: [monday],
      assignments: [
        assignment("a", monday, "Musa Ibrahim", {
          startsAt: lagos(days[0]!, "06:00"),
          endsAt: lagos(days[0]!, "18:00"),
        }),
      ],
      timeZone: LAGOS,
    });
    expect(roster.posts[0]!.cells[0]!.assigned[0]!.hoursChanged).toBe(true);
  });

  it("names posts that are no longer required from the names given", () => {
    const monday = shift("closed", "Patrol · Night", days[0]!, "18:00", "06:00");
    const roster = buildRosterWeek({
      weekStart: week,
      required: [],
      assignments: [assignment("a", monday, "Sadiq Musa")],
      postNames: { closed: "Patrol · Night" },
      timeZone: LAGOS,
    });
    expect(roster.posts.map((p) => p.name)).toEqual(["Patrol · Night"]);
    expect(roster.totals).toEqual({ required: 0, covered: 0, open: 0 });
  });

  it("ignores rows outside the week", () => {
    const before = shift("day", "Gate A · Day", "2026-11-22", "06:00", "18:00");
    const roster = buildRosterWeek({
      weekStart: week,
      required: [before],
      assignments: [assignment("a", before, "Musa Ibrahim")],
      timeZone: LAGOS,
    });
    expect(roster.posts).toEqual([]);
    expect(roster.totals.required).toBe(0);
  });
});
