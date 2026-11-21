import { describe, expect, it } from "vitest";

import { pageAccess } from "@/lib/nav";
import {
  dayBoundsIn,
  formatPatrolTotals,
  parseDayParam,
  scanMarkers,
  scanNeedsReview,
  summarisePatrolDay,
  type PatrolCheckpoint,
  type PatrolScan,
} from "@/lib/patrols";

const cp = (id: string, sortOrder: number, status: PatrolCheckpoint["status"] = "active") => ({
  id,
  name: `Point ${id}`,
  sortOrder,
  status,
});

let n = 0;
const scan = (checkpointId: string, at: string, over: Partial<PatrolScan> = {}): PatrolScan => {
  n += 1;
  return {
    id: `s${n}`,
    checkpointId,
    workerId: "w1",
    workerName: "Musa Bello",
    recordedAt: at,
    geofence: "inside",
    distanceM: 12,
    flags: [],
    ...over,
  };
};

describe("summarisePatrolDay", () => {
  it("lists checkpoints in round order with their scans, earliest first", () => {
    const day = summarisePatrolDay(
      [cp("c", 2), cp("a", 0), cp("b", 1)],
      [
        scan("a", "2027-01-15T20:30:00Z"),
        scan("a", "2027-01-15T19:00:00Z"),
        scan("c", "2027-01-15T19:10:00Z", { workerId: "w2", workerName: "Ada Obi" }),
      ],
    );
    expect(day.rows.map((r) => r.checkpoint.id)).toEqual(["a", "b", "c"]);
    expect(day.rows[0]!.scans.map((s) => s.recordedAt)).toEqual([
      "2027-01-15T19:00:00Z",
      "2027-01-15T20:30:00Z",
    ]);
    expect(day).toMatchObject({
      totalScans: 3,
      scannedCount: 2,
      activeCount: 3,
      firstScanAt: "2027-01-15T19:00:00Z",
      lastScanAt: "2027-01-15T20:30:00Z",
    });
    expect(day.notScanned.map((c) => c.id)).toEqual(["b"]);
    expect(day.scanners).toEqual([
      { workerId: "w1", name: "Musa Bello", scans: 2 },
      { workerId: "w2", name: "Ada Obi", scans: 1 },
    ]);
  });

  it("shows a retired checkpoint only when it was scanned, and never as not scanned", () => {
    const day = summarisePatrolDay(
      [cp("a", 0), cp("old", 1, "retired"), cp("gone", 2, "retired")],
      [scan("old", "2027-01-15T08:00:00Z")],
    );
    expect(day.rows.map((r) => r.checkpoint.id)).toEqual(["a", "old"]);
    expect(day.notScanned.map((c) => c.id)).toEqual(["a"]);
    expect(day.activeCount).toBe(1);
    expect(day.scannedCount).toBe(0);
    expect(day.totalScans).toBe(1);
  });

  it("counts scans away from the site or without a location as needing a look", () => {
    const day = summarisePatrolDay(
      [cp("a", 0)],
      [
        scan("a", "2027-01-15T08:00:00Z", { geofence: "outside", flags: ["outside"] }),
        scan("a", "2027-01-15T09:00:00Z", { geofence: "unknown", flags: ["no_location"] }),
        scan("a", "2027-01-15T10:00:00Z", { flags: ["late_sync"] }),
      ],
    );
    expect(day.flaggedScans).toBe(2);
    expect(scanNeedsReview({ flags: ["near"] })).toBe(true);
    expect(scanNeedsReview({ flags: ["late_sync"] })).toBe(false);
  });

  it("treats a backdated or offline scan as needing a look, with a marker (review L1, L2)", () => {
    for (const flag of ["delayed", "time_unverified", "clock_drift", "queued_offline"]) {
      expect(scanNeedsReview({ flags: [flag] }), flag).toBe(true);
    }
    expect(scanMarkers(["delayed", "late_sync"])).toEqual(["Sent late"]);
    expect(scanMarkers(["time_unverified", "queued_offline"])).toEqual([
      "Time not verified",
      "Saved offline without sign-in",
    ]);
    expect(scanMarkers(["outside"])).toEqual([]);
  });

  it("ignores scans of checkpoints it wasn't given, and handles an empty day", () => {
    const empty = summarisePatrolDay([], [scan("x", "2027-01-15T08:00:00Z")]);
    expect(empty).toMatchObject({ rows: [], totalScans: 0, firstScanAt: null, lastScanAt: null });
    expect(formatPatrolTotals(empty)).toBe("0 scans");
  });
});

describe("formatPatrolTotals", () => {
  it("puts the numbers first", () => {
    expect(formatPatrolTotals({ scannedCount: 6, activeCount: 8, totalScans: 14 })).toBe(
      "6 of 8 checkpoints scanned · 14 scans",
    );
    expect(formatPatrolTotals({ scannedCount: 1, activeCount: 1, totalScans: 1 })).toBe(
      "1 of 1 checkpoint scanned · 1 scan",
    );
  });
});

describe("parseDayParam", () => {
  it("takes a real past day and falls back to today otherwise", () => {
    expect(parseDayParam("2027-01-10", "2027-01-15")).toBe("2027-01-10");
    expect(parseDayParam("2027-01-20", "2027-01-15")).toBe("2027-01-15");
    expect(parseDayParam("2027-02-30", "2027-03-01")).toBe("2027-03-01");
    expect(parseDayParam("15/01/2027", "2027-01-15")).toBe("2027-01-15");
    expect(parseDayParam(undefined, "2027-01-15")).toBe("2027-01-15");
  });
});

describe("dayBoundsIn", () => {
  it("gives the day in the company's zone (Lagos is UTC+1)", () => {
    const { start, end } = dayBoundsIn("2027-01-15", "Africa/Lagos");
    expect(start.toISOString()).toBe("2027-01-14T23:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-15T23:00:00.000Z");
  });
});

describe("who opens the patrol history (review M1)", () => {
  const path = "/app/attendance/patrols";

  it("follows Live attendance: punch readers in, finance out", () => {
    for (const role of ["owner", "admin", "hr", "ops_manager", "line_manager"] as const) {
      expect(pageAccess(role, path), role).toBe("allow");
    }
    expect(pageAccess("finance", path)).toBe("forbidden");
  });

  it("is switched off with Shifts", () => {
    expect(pageAccess("owner", path, { shifts: false, people: true, payroll: true })).toBe(
      "switched_off",
    );
    expect(pageAccess("finance", path, { shifts: false, people: true, payroll: true })).toBe(
      "forbidden",
    );
  });
});
