/**
 * Slice 4.5: approved leave meets the roster (src/lib/leave/roster.ts). The preview's wording for
 * the shifts an approval opens, and the leave lookups the roster's suggestions use.
 */
import { describe, expect, it } from "vitest";

import {
  formatDayRuns,
  formatOpenedAtSites,
  formatOpenedShifts,
  leaveOn,
  onLeaveLabel,
  pendingLeaveLabel,
  toOpenedShifts,
  type LeaveSpan,
  type OpenedShift,
} from "@/lib/leave/roster";

function shift(
  date: string,
  post = "Gate A · Day",
  site = "Apapa Warehouse 3",
  time = "06:00",
): OpenedShift {
  return {
    assignmentId: `${post}-${date}`,
    shiftDate: date,
    startsAt: new Date(`${date}T${time}:00+01:00`).toISOString(),
    endsAt: new Date(`${date}T18:00:00+01:00`).toISOString(),
    siteId: site,
    siteName: site,
    postId: post,
    postName: post,
  };
}

describe("formatOpenedShifts", () => {
  it("names the count, the post and the days as a run", () => {
    expect(
      formatOpenedShifts([shift("2026-11-04"), shift("2026-11-05"), shift("2026-11-06")]),
    ).toBe("Opens 3 shifts: Gate A · Day, 4 to 6 Nov");
  });

  it("splits days that don't follow one another and groups by post", () => {
    expect(
      formatOpenedShifts([
        shift("2026-11-04"),
        shift("2026-11-05"),
        shift("2026-11-09"),
        shift("2026-11-07", "Gate B · Night", "Lekki Phase 1", "18:00"),
      ]),
    ).toBe("Opens 4 shifts: Gate A · Day, 4 to 5 Nov, 9 Nov; Gate B · Night, 7 Nov");
  });

  it("says when there is nothing to open, and counts one shift", () => {
    expect(formatOpenedShifts([])).toBe("Opens no shifts");
    expect(formatOpenedShifts([shift("2026-11-30")])).toBe("Opens 1 shift: Gate A · Day, 30 Nov");
  });

  it("runs across a month end", () => {
    expect(formatDayRuns(["2026-12-01", "2026-11-30", "2026-11-29"])).toBe("29 Nov to 1 Dec");
  });
});

describe("formatOpenedAtSites", () => {
  it("names each site once", () => {
    expect(formatOpenedAtSites([shift("2026-11-04"), shift("2026-11-05")])).toBe(
      "2 shifts at Apapa Warehouse 3",
    );
    expect(
      formatOpenedAtSites([
        shift("2026-11-04"),
        shift("2026-11-05", "Gate B · Night", "Lekki Phase 1"),
      ]),
    ).toBe("2 shifts at Apapa Warehouse 3 and Lekki Phase 1");
  });
});

describe("toOpenedShifts", () => {
  it("reads decide_leave_hr's open_shifts and drops malformed rows", () => {
    const rows = toOpenedShifts([
      {
        assignment_id: "a1",
        shift_date: "2026-11-04",
        starts_at: "2026-11-04T05:00:00+00:00",
        ends_at: "2026-11-04T17:00:00+00:00",
        site_id: "s1",
        site_name: "Apapa Warehouse 3",
        post_id: "p1",
        post_name: "Gate A · Day",
      },
      { shift_date: "2026-11-05" },
      "nonsense",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.postName).toBe("Gate A · Day");
    expect(toOpenedShifts(null)).toEqual([]);
  });
});

describe("leave lookups", () => {
  const spans: LeaveSpan[] = [
    { workerId: "w1", startDate: "2026-11-04", endDate: "2026-11-06", status: "approved" },
    { workerId: "w2", startDate: "2026-11-05", endDate: "2026-11-05", status: "pending" },
  ];

  it("finds the span covering a day by status", () => {
    expect(leaveOn(spans, "w1", "2026-11-04", "approved")).not.toBeNull();
    expect(leaveOn(spans, "w1", "2026-11-07", "approved")).toBeNull();
    expect(leaveOn(spans, "w2", "2026-11-05", "approved")).toBeNull();
    expect(leaveOn(spans, "w2", "2026-11-05", "pending")).not.toBeNull();
  });

  it("words them like the database", () => {
    expect(onLeaveLabel(spans[0]!)).toBe("On leave 4 to 6 Nov");
    expect(pendingLeaveLabel(spans[1]!)).toBe("Leave waiting for a decision 5 Nov");
  });
});
