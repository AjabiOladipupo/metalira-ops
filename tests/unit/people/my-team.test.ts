import { describe, expect, it } from "vitest";

import {
  formatLeaveBalance,
  minutesByWorker,
  nextShift,
  summariseMyTeam,
  teamHeadline,
  todayStatus,
  type TeamShift,
} from "@/lib/my-team";

const TZ = "Africa/Lagos";
const now = new Date("2026-11-21T09:00:00+01:00");

function shift(workerId: string, date: string, start: string, end: string): TeamShift {
  return {
    assignmentId: `${workerId}-${date}-${start}`,
    workerId,
    shiftDate: date,
    startsAt: `${date}T${start}:00+01:00`,
    endsAt: `${date}T${end}:00+01:00`,
    siteId: "s",
    siteName: "Apapa Warehouse 3",
    postId: "p",
    postName: "Gate A · Day",
    canRemove: true,
  };
}

describe("my team", () => {
  it("says how many people report to you", () => {
    expect(teamHeadline(0)).toBe("No one reports to you yet");
    expect(teamHeadline(1)).toBe("1 person reports to you");
    expect(teamHeadline(9)).toBe("9 people report to you");
  });

  it("works out today from the board, then leave, then a shift later today", () => {
    const base = { onLeave: false, laterToday: undefined, now, timeZone: TZ };
    expect(
      todayStatus({
        ...base,
        board: { workerId: "a", status: "on_site", startsAt: "2026-11-21T07:00:00+01:00", lateMinutes: null },
      }),
    ).toMatchObject({ kind: "on_site", label: "On site", tone: "done" });
    expect(
      todayStatus({
        ...base,
        board: { workerId: "a", status: "late", startsAt: "2026-11-21T08:46:00+01:00", lateMinutes: null },
      }),
    ).toMatchObject({ kind: "late", label: "Late 14 min", tone: "action" });
    expect(
      todayStatus({
        ...base,
        board: { workerId: "a", status: "no_show", startsAt: "2026-11-21T06:00:00+01:00", lateMinutes: null },
      }).label,
    ).toBe("No-show");
    expect(todayStatus({ ...base, board: undefined, onLeave: true }).label).toBe("On leave");
    expect(
      todayStatus({
        ...base,
        board: undefined,
        laterToday: shift("a", "2026-11-21", "18:00", "23:00"),
      }).label,
    ).toBe("Starts 18:00");
    expect(todayStatus({ ...base, board: undefined })).toMatchObject({
      kind: "off",
      label: "Off today",
    });
  });

  it("adds worked and overtime minutes per worker", () => {
    const m = minutesByWorker([
      { workerId: "a", workedMinutes: 720, otMinutes: 20 },
      { workerId: "a", workedMinutes: 480, otMinutes: 0 },
      { workerId: "b", workedMinutes: 0, otMinutes: 0 },
    ]);
    expect(m.get("a")).toBe(1220);
    expect(m.get("b")).toBe(0);
  });

  it("finds the next shift that hasn't ended", () => {
    const shifts = [
      shift("a", "2026-11-20", "07:00", "19:00"),
      shift("a", "2026-11-23", "07:00", "19:00"),
      shift("a", "2026-11-21", "07:00", "19:00"),
      shift("b", "2026-11-21", "18:00", "23:00"),
    ];
    expect(nextShift(shifts, "a", now)?.shiftDate).toBe("2026-11-21");
    expect(nextShift(shifts, "c", now)).toBeUndefined();
  });

  it("shows the balance before and after a pending request", () => {
    expect(formatLeaveBalance(8, 3)).toBe("Balance 11 days, 8 after this");
    expect(formatLeaveBalance(null, 3)).toBe("No balance for this type");
  });

  it("counts only, with no names", () => {
    const summary = summariseMyTeam({
      today: ["on_site", "late", "late", "no_show", "off", "on_leave"],
      minutesThisWeek: 2880,
      leaveToDecide: 1,
      timesheetDaysOpen: 3,
      openQueries: 2,
      overdueQueries: 1,
      openShifts: 4,
    });
    expect(summary).toEqual({
      reportees: 6,
      onSite: 1,
      late: 2,
      noShow: 1,
      onLeaveToday: 1,
      offToday: 1,
      minutesThisWeek: 2880,
      leaveToDecide: 1,
      timesheetDaysOpen: 3,
      openQueries: 2,
      overdueQueries: 1,
      openShifts: 4,
    });
  });
});
