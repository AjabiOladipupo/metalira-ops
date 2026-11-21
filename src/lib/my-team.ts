/** The status dot (src/components/status.tsx). */
type StatusTone = "done" | "pending" | "partial" | "action";
import type { AttendanceStatus } from "@/lib/attendance-board";
import { formatHoursTotal, formatShortDay, formatShiftHours, timeIn } from "@/lib/roster";

/**
 * My team (slice 4.7, Team board): the pure pieces of a line manager's page, so the screen, the
 * Lira summary and the unit tests agree. Nothing here reads the database or holds personal
 * numbers; names come from public.my_reportees and the definer reads.
 */

/** One of the reportee's assigned shifts (public.team_shifts). */
export interface TeamShift {
  assignmentId: string;
  workerId: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  siteId: string;
  siteName: string;
  postId: string;
  postName: string;
  /** At the line manager's sites and not started yet. */
  canRemove: boolean;
}

/** A post-day at the line manager's sites that still needs people (public.team_open_shifts). */
export interface OpenShift {
  postId: string;
  postName: string;
  siteId: string;
  siteName: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  required: number;
  assigned: number;
}

/** A reportee's row on the live board, reduced to what "Today" needs. */
export interface TodayBoardRow {
  workerId: string;
  status: AttendanceStatus;
  startsAt: string;
  lateMinutes: number | null;
}

export type TodayKind = "on_site" | "late" | "no_show" | "starting" | "clocked_out" | "on_leave" | "off";

export interface TodayStatus {
  kind: TodayKind;
  label: string;
  tone: StatusTone;
}

/** Whole minutes from `from` to `to` (0 when `to` is earlier). */
function minutesSince(from: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - Date.parse(from)) / 60_000));
}

/**
 * "On site", "Late 14 min", "No-show", "Starts 18:00", "Clocked out", "On leave" or "Off today",
 * from the live board (punches) first, then approved leave, then a shift later today. Late and
 * no-show need the manager (signal); on site is done; the rest are plain.
 */
export function todayStatus(input: {
  board: TodayBoardRow | undefined;
  onLeave: boolean;
  laterToday: TeamShift | undefined;
  now: Date;
  timeZone: string;
}): TodayStatus {
  const { board, now, timeZone } = input;
  if (board) {
    switch (board.status) {
      case "on_site":
        return board.lateMinutes && board.lateMinutes > 0
          ? { kind: "on_site", label: `On site · late ${board.lateMinutes} min`, tone: "done" }
          : { kind: "on_site", label: "On site", tone: "done" };
      case "late":
        return {
          kind: "late",
          label: `Late ${minutesSince(board.startsAt, now)} min`,
          tone: "action",
        };
      case "no_show":
        return { kind: "no_show", label: "No-show", tone: "action" };
      case "clocked_out":
        return { kind: "clocked_out", label: "Clocked out", tone: "done" };
      case "starting":
        return {
          kind: "starting",
          label: `Starts ${timeIn(board.startsAt, timeZone)}`,
          tone: "pending",
        };
    }
  }
  if (input.onLeave) return { kind: "on_leave", label: "On leave", tone: "pending" };
  if (input.laterToday) {
    return {
      kind: "starting",
      label: `Starts ${timeIn(input.laterToday.startsAt, timeZone)}`,
      tone: "pending",
    };
  }
  return { kind: "off", label: "Off today", tone: "pending" };
}

/** Worked plus overtime minutes per worker. */
export function minutesByWorker(
  lines: readonly { workerId: string; workedMinutes: number; otMinutes: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.workerId, (out.get(l.workerId) ?? 0) + l.workedMinutes + l.otMinutes);
  return out;
}

/** "48 h", "0 h". */
export function formatWeekHours(minutes: number): string {
  return formatHoursTotal(minutes);
}

/** The worker's next shift that hasn't ended, earliest first. */
export function nextShift(
  shifts: readonly TeamShift[],
  workerId: string,
  now: Date,
): TeamShift | undefined {
  return shifts
    .filter((s) => s.workerId === workerId && Date.parse(s.endsAt) > now.getTime())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
}

/** "Sun 1 Nov · Gate A · Day · 06:00–18:00". */
export function formatTeamShift(shift: Pick<TeamShift | OpenShift, "shiftDate" | "postName" | "startsAt" | "endsAt">, timeZone: string): string {
  return `${formatShortDay(shift.shiftDate)} · ${shift.postName} · ${formatShiftHours(shift.startsAt, shift.endsAt, timeZone)}`;
}

/** "Balance 11 days, 8 after this" (available before and after the request's days). */
export function formatLeaveBalance(available: number | null, days: number): string {
  if (available === null) return "No balance for this type";
  const unit = (n: number) => `${n} ${Math.abs(n) === 1 ? "day" : "days"}`;
  // A pending request is already counted out of `available`; add it back for "before".
  const before = available + days;
  return `Balance ${unit(before)}, ${available} after this`;
}

/** "9 people report to you", "1 person reports to you", "No one reports to you yet". */
export function teamHeadline(count: number): string {
  if (count === 0) return "No one reports to you yet";
  return count === 1 ? "1 person reports to you" : `${count} people report to you`;
}

/** Counts only, for the page's tabs and Lira (`team.board_summary`): no names or ids. */
export interface MyTeamSummary {
  reportees: number;
  onSite: number;
  late: number;
  noShow: number;
  onLeaveToday: number;
  offToday: number;
  /** Worked plus overtime minutes this week (Monday to today), all reportees. */
  minutesThisWeek: number;
  /** Leave requests waiting for the caller's step-1 decision. */
  leaveToDecide: number;
  /** Timesheet days of reportees still pending or disputed in the current pay period. */
  timesheetDaysOpen: number;
  openQueries: number;
  overdueQueries: number;
  /** Post-days at the team's sites that still need people in the next 14 days. */
  openShifts: number;
}

export function summariseMyTeam(input: {
  today: readonly TodayKind[];
  minutesThisWeek: number;
  leaveToDecide: number;
  timesheetDaysOpen: number;
  openQueries: number;
  overdueQueries: number;
  openShifts: number;
}): MyTeamSummary {
  const count = (kind: TodayKind) => input.today.filter((k) => k === kind).length;
  return {
    reportees: input.today.length,
    onSite: count("on_site"),
    late: count("late"),
    noShow: count("no_show"),
    onLeaveToday: count("on_leave"),
    offToday: count("off"),
    minutesThisWeek: input.minutesThisWeek,
    leaveToDecide: input.leaveToDecide,
    timesheetDaysOpen: input.timesheetDaysOpen,
    openQueries: input.openQueries,
    overdueQueries: input.overdueQueries,
    openShifts: input.openShifts,
  };
}
