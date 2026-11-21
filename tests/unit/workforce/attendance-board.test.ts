/**
 * Slice 3.7: the live board's status rules (mirror of private.attendance_status) and the pure
 * helpers the screen uses. Owner decision 3: late after the grace period (10 min), no-show after
 * no_show_after_minutes (60 min). Times are Lagos (UTC+1, no daylight saving).
 */
import { describe, expect, it } from "vitest";

import {
  attendanceStatus,
  callTarget,
  defaultTile,
  filterRows,
  flagLabels,
  formatSince,
  headline,
  replacementHref,
  siteSummaries,
  statusCounts,
  statusText,
  subline,
  type BoardRow,
  type StatusInput,
} from "@/lib/attendance-board";
import { replacementTarget, type RosterWeek } from "@/lib/roster";

const MIN = 60_000;
const ZONE = "Africa/Lagos";
// 06:00 Lagos on 21 Nov 2026 is 05:00 UTC.
const START = Date.parse("2026-11-21T05:00:00Z");
const END = START + 12 * 60 * MIN;

function status(at: number, extra: Partial<StatusInput> = {}) {
  return attendanceStatus({
    now: at,
    startsAt: START,
    endsAt: END,
    lateGraceMinutes: 10,
    noShowAfterMinutes: 60,
    lastPunchKind: null,
    ...extra,
  });
}

describe("attendanceStatus", () => {
  it("is starting before the shift, up to 2 hours ahead", () => {
    expect(status(START - 120 * MIN)).toBe("starting");
    expect(status(START - 1)).toBe("starting");
  });

  it("is on time up to and including the end of the grace period", () => {
    expect(status(START)).toBe("starting");
    expect(status(START + 10 * MIN)).toBe("starting");
  });

  it("is late just after the grace period", () => {
    expect(status(START + 10 * MIN + 1)).toBe("late");
    expect(status(START + 22 * MIN)).toBe("late");
  });

  it("is late up to and including the no-show time, a no-show after it", () => {
    expect(status(START + 60 * MIN)).toBe("late");
    expect(status(START + 60 * MIN + 1)).toBe("no_show");
  });

  it("follows the company's own minutes", () => {
    const custom = { lateGraceMinutes: 0, noShowAfterMinutes: 15 };
    expect(status(START, custom)).toBe("starting");
    expect(status(START + 1, custom)).toBe("late");
    expect(status(START + 15 * MIN + 1, custom)).toBe("no_show");
  });

  it("has no late window when grace and no-show are equal", () => {
    const same = { lateGraceMinutes: 30, noShowAfterMinutes: 30 };
    expect(status(START + 30 * MIN, same)).toBe("starting");
    expect(status(START + 30 * MIN + 1, same)).toBe("no_show");
  });

  it("is a no-show once the shift has ended without a clock-in, even before the no-show time", () => {
    const short = { endsAt: START + 30 * MIN, noShowAfterMinutes: 60 };
    expect(status(START + 29 * MIN, short)).toBe("late");
    expect(status(START + 30 * MIN, short)).toBe("no_show");
  });

  it("is on site with a clock-in, early, on time or late", () => {
    for (const at of [START - 30 * MIN, START + 5 * MIN, START + 90 * MIN, END + 60 * MIN]) {
      expect(status(at, { lastPunchKind: "in" })).toBe("on_site");
    }
  });

  it("is clocked out when the latest punch is a clock-out, during or after the shift", () => {
    expect(status(START + 3 * 60 * MIN, { lastPunchKind: "out" })).toBe("clocked_out");
    expect(status(END + MIN, { lastPunchKind: "out" })).toBe("clocked_out");
  });

  it("handles a night shift across midnight (18:00 to 06:00 Lagos)", () => {
    const nightStart = Date.parse("2026-11-20T17:00:00Z");
    const nightEnd = Date.parse("2026-11-21T05:00:00Z");
    const night = { startsAt: nightStart, endsAt: nightEnd };
    // 23:30 Lagos on the 20th: no clock-in for 5.5 hours.
    expect(status(Date.parse("2026-11-20T22:30:00Z"), night)).toBe("no_show");
    // 00:30 Lagos on the 21st, clocked in at 18:05.
    expect(status(Date.parse("2026-11-20T23:30:00Z"), { ...night, lastPunchKind: "in" })).toBe(
      "on_site",
    );
    // 18:10 Lagos is still on time; 18:11 is late.
    expect(status(nightStart + 10 * MIN, night)).toBe("starting");
    expect(status(nightStart + 11 * MIN, night)).toBe("late");
    // After 06:00 on the 21st with no punch: a no-show.
    expect(status(nightEnd, night)).toBe("no_show");
    expect(status(nightEnd + MIN, { ...night, lastPunchKind: "out" })).toBe("clocked_out");
  });
});

function row(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    assignmentId: "a1",
    shiftDate: "2026-11-21",
    startsAt: new Date(START).toISOString(),
    endsAt: new Date(END).toISOString(),
    siteId: "s1",
    siteName: "Apapa Warehouse 3",
    postId: "p1",
    postName: "Gate A · Day",
    workerId: "w1",
    workerName: "Daniel Okon",
    staffId: "EMP-0001",
    phone: "08031234410",
    phoneLast4: "4410",
    published: true,
    firstInAt: null,
    lastPunchKind: null,
    lastPunchAt: null,
    flags: [],
    bySupervisor: false,
    status: "late",
    lateMinutes: 22,
    siteLastSyncAt: null,
    siteLateSyncs: 0,
    ...overrides,
  };
}

describe("board helpers", () => {
  const now = START + 22 * MIN;

  it("counts tiles and opens what needs action first", () => {
    const rows = [
      row({ assignmentId: "1", status: "on_site" }),
      row({ assignmentId: "2", status: "late" }),
      row({ assignmentId: "3", status: "no_show" }),
    ];
    const counts = statusCounts(rows);
    expect(counts).toEqual({ on_site: 1, late: 1, no_show: 1, starting: 0, clocked_out: 0 });
    expect(defaultTile(counts)).toBe("no_show");
    expect(defaultTile({ ...counts, no_show: 0, late: 0 })).toBe("on_site");
    expect(defaultTile({ on_site: 0, late: 0, no_show: 0, starting: 0, clocked_out: 0 })).toBe(
      "on_site",
    );
  });

  it("filters by status, site and a search on name, staff ID or post", () => {
    const rows = [
      row({ assignmentId: "1", workerName: "Daniel Okon", status: "late" }),
      row({ assignmentId: "2", workerName: "Halima Bello", siteId: "s2", status: "late" }),
      row({ assignmentId: "3", workerName: "Chidi Eze", postName: "Patrol", status: "on_site" }),
    ];
    const ids = (f: Parameters<typeof filterRows>[1]) => filterRows(rows, f).map((r) => r.assignmentId);
    expect(ids({ status: "late", siteId: "all", search: "" })).toEqual(["1", "2"]);
    expect(ids({ status: "late", siteId: "s2", search: "" })).toEqual(["2"]);
    expect(ids({ status: "all", siteId: "all", search: "patrol" })).toEqual(["3"]);
    expect(ids({ status: "all", siteId: "all", search: "emp-0001" })).toEqual(["1", "2", "3"]);
    expect(ids({ status: "all", siteId: "all", search: "  halima " })).toEqual(["2"]);
  });

  it("summarises each site from the same rows, most no-shows first", () => {
    const rows = [
      row({ assignmentId: "1", status: "on_site", siteLastSyncAt: new Date(now - 6 * MIN).toISOString() }),
      row({ assignmentId: "2", status: "late" }),
      row({
        assignmentId: "3",
        siteId: "s2",
        siteName: "Lekki Estate",
        status: "no_show",
        siteLateSyncs: 3,
      }),
      row({
        assignmentId: "4",
        siteId: "s2",
        siteName: "Lekki Estate",
        status: "starting",
        startsAt: new Date(now + 60 * MIN).toISOString(),
        siteLateSyncs: 3,
      }),
    ];
    const [first, second] = siteSummaries(rows, now);
    expect(first).toMatchObject({ siteName: "Lekki Estate", rosteredNow: 1, noShow: 1, lateSyncs: 3 });
    expect(second).toMatchObject({ siteName: "Apapa Warehouse 3", rosteredNow: 2, onSite: 1, late: 1 });
    expect(formatSince(second!.lastSyncAt, now)).toBe("6 min ago");
    expect(headline(rows, now)).toBe("3 on shift now");
    expect(subline(rows)).toBe("2 sites · 3 punches sent late today");
  });

  it("says how long ago a site last synced", () => {
    expect(formatSince(null, now)).toBe("No punches today");
    expect(formatSince(new Date(now - 30_000).toISOString(), now)).toBe("Just now");
    expect(formatSince(new Date(now - 125 * MIN).toISOString(), now)).toBe("2 h ago");
  });

  it("writes each status in words, numbers first, in Lagos time", () => {
    expect(statusText(row(), ZONE, now)).toBe("Late 22 min");
    expect(statusText(row({ status: "no_show" }), ZONE, now)).toBe("No-show");
    expect(
      statusText(row({ status: "starting", startsAt: new Date(now + 60 * MIN).toISOString() }), ZONE, now),
    ).toBe("Starts 07:22");
    expect(statusText(row({ status: "starting" }), ZONE, START + 5 * MIN)).toBe("Due 06:00");
    expect(statusText(row({ status: "on_site", lateMinutes: 14 }), ZONE, now)).toBe(
      "On site · 14 min late",
    );
    expect(statusText(row({ status: "on_site", lateMinutes: null }), ZONE, now)).toBe("On site");
    expect(
      statusText(row({ status: "clocked_out", lastPunchAt: "2026-11-21T17:04:00Z" }), ZONE, now),
    ).toBe("Clocked out 18:04");
  });

  it("lists punch flags in words, with supervisor and unpublished notes", () => {
    expect(flagLabels(row({ flags: ["outside", "late", "no_selfie"] }))).toEqual([
      "Outside the site",
      "No selfie",
    ]);
    expect(flagLabels(row({ flags: ["near"], bySupervisor: true, published: false }))).toEqual([
      "Near the site",
      "By supervisor",
      "Not published",
    ]);
  });

  it("dials only a number returned in full, and masks it otherwise", () => {
    expect(callTarget(row())).toEqual({ href: "tel:08031234410", label: "0803 ••• 4410" });
    expect(callTarget(row({ phone: null }))).toEqual({ masked: "••• 4410" });
    expect(callTarget(row({ phone: null, phoneLast4: null }))).toBeNull();
  });

  it("sends a replacement to the roster week, post-day and assignment", () => {
    expect(replacementHref(row(), "2026-11-16")).toBe(
      "/app/roster?site=s1&week=2026-11-16&post=p1&date=2026-11-21&replace=a1",
    );
  });
});

describe("replacementTarget (roster side of Send replacement)", () => {
  const cell = {
    date: "2026-11-21",
    required: 1,
    startsAt: "2026-11-21T05:00:00Z",
    endsAt: "2026-11-21T17:00:00Z",
    assigned: [
      {
        id: "a1",
        shiftId: "sh1",
        postId: "p1",
        date: "2026-11-21",
        workerId: "w1",
        workerName: "Daniel Okon",
        staffId: "EMP-0001",
        startsAt: "2026-11-21T05:00:00Z",
        endsAt: "2026-11-21T17:00:00Z",
        mapped: true,
        hoursChanged: false,
      },
    ],
    open: 0,
  };
  const week = {
    weekStart: "2026-11-16",
    days: [],
    posts: [{ postId: "p1", name: "Gate A · Day", hours: "06:00–18:00", cells: [cell] }],
    totals: { required: 1, covered: 1, open: 0 },
    uncovered: [],
  } as RosterWeek;

  it("removes the worker first, then picks for the same post-day", () => {
    expect(replacementTarget(week, { postId: "p1", date: "2026-11-21", assignmentId: "a1" })).toEqual({
      postId: "p1",
      postName: "Gate A · Day",
      date: "2026-11-21",
      startsAt: cell.startsAt,
      endsAt: cell.endsAt,
      remove: { assignmentId: "a1", workerName: "Daniel Okon" },
    });
  });

  it("opens the picker at once when the place is already open, and nothing when full", () => {
    const open = {
      ...week,
      posts: [{ ...week.posts[0]!, cells: [{ ...cell, assigned: [], open: 1 }] }],
    };
    expect(
      replacementTarget(open, { postId: "p1", date: "2026-11-21", assignmentId: "a1" })?.remove,
    ).toBeNull();
    expect(replacementTarget(week, { postId: "p1", date: "2026-11-21", assignmentId: "zz" })).toBeNull();
    expect(replacementTarget(week, { postId: "p9", date: "2026-11-21", assignmentId: "a1" })).toBeNull();
  });
});
