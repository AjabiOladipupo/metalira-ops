import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, todayIn } from "@/lib/dates";
import type { OpenedShift } from "@/lib/leave/roster";
import {
  minutesByWorker,
  nextShift,
  summariseMyTeam,
  todayStatus,
  type MyTeamSummary,
  type OpenShift,
  type TeamShift,
  type TodayBoardRow,
  type TodayStatus,
} from "@/lib/my-team";
import { isQueryOpen, isQueryOverdue } from "@/lib/queries";
import { mondayOf } from "@/lib/roster";
import { periodFor } from "@/lib/timesheets/minutes";
import { loadAttendanceBoard } from "@/server/workforce/attendance-board";
import {
  loadTimesheetLines,
  loadTimesheetSettings,
  refreshTimesheetRange,
} from "@/server/workforce/timesheets-data";
import type { Database } from "@/types/db";

import { loadBalances, loadLeaveRequests, type LeaveRequestRow } from "./leave-data";
import { loadTeamQueries, type QueryView } from "./queries";
import { loadTeamMembers, type TeamMember } from "./team";

/**
 * My team (slice 4.7, /app/team): everything a line manager's page shows, read with their own
 * client. Reportee details only through public.my_reportees (never public.workers); shifts and
 * open shifts through public.team_shifts and public.team_open_shifts; today from the live board
 * (public.attendance_board, reportees only); hours from timesheet lines (RLS: reportees); leave
 * from public.leave_request_list and public.leave_balances; queries through RLS. Every read the
 * database refuses (42501 for any role but line_manager) comes back empty, so an owner or admin
 * opening My team simply sees no one.
 */

type Client = SupabaseClient<Database>;

/** How far ahead "next shift" and the leave cover look, and how far open shifts look. */
export const TEAM_SHIFT_DAYS = 42;
export const OPEN_SHIFT_DAYS = 14;

export interface TeamRow {
  member: TeamMember;
  today: TodayStatus;
  minutesThisWeek: number;
  /** Available annual leave days this year, or null with no annual type or balance. */
  annualLeft: number | null;
  next: TeamShift | null;
}

export interface TeamBoard {
  timeZone: string;
  today: string;
  weekStart: string;
  rows: TeamRow[];
  shifts: TeamShift[];
  openShifts: OpenShift[];
  /** Waiting for the line manager (step 1) or with HR, the caller's reportees only. */
  leave: LeaveRequestRow[];
  /** Per step-1 request: the shifts HR's approval would open (4.5's rule). */
  leaveOpens: Map<string, OpenedShift[]>;
  /** Available days per worker and leave type this year. */
  balances: Map<string, number>;
  queries: QueryView[];
  summary: MyTeamSummary;
  /** The sites the reportees are mapped to (for the subtitle). */
  siteNames: string[];
}

export function balanceKey(workerId: string, leaveTypeId: string): string {
  return `${workerId}:${leaveTypeId}`;
}

function rowsOf<T>(promise: PromiseLike<{ data: T[] | null; error: { code: string } | null }>) {
  return Promise.resolve(promise).then(({ data, error }) => {
    if (error) throw new Error(`Could not read your team (${error.code})`);
    return data ?? [];
  });
}

/** The reportees' assigned shifts from `from` to `to` (public.team_shifts). */
export async function loadTeamShifts(
  supabase: Client,
  organisationId: string,
  from: string,
  to: string,
): Promise<TeamShift[]> {
  const data = await rowsOf(
    supabase.rpc("team_shifts", { p_organisation_id: organisationId, p_from: from, p_to: to }),
  );
  return data.map((r) => ({
    assignmentId: r.assignment_id,
    workerId: r.worker_id,
    shiftDate: r.shift_date,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    siteId: r.site_id,
    siteName: r.site_name,
    postId: r.post_id,
    postName: r.post_name,
    canRemove: r.can_remove,
  }));
}

/** Post-days at the team's sites that still need people (public.team_open_shifts). */
export async function loadOpenShifts(
  supabase: Client,
  organisationId: string,
  from: string,
  to: string,
): Promise<OpenShift[]> {
  const data = await rowsOf(
    supabase.rpc("team_open_shifts", { p_organisation_id: organisationId, p_from: from, p_to: to }),
  );
  return data.map((r) => ({
    postId: r.post_id,
    postName: r.post_name,
    siteId: r.site_id,
    siteName: r.site_name,
    shiftDate: r.shift_date,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    required: r.required_count,
    assigned: r.assigned_count,
  }));
}

/** For each step-1 request the caller decides, the shifts it opens (team_leave_open_shifts). */
export async function loadLeaveOpens(
  supabase: Client,
  organisationId: string,
): Promise<Map<string, OpenedShift[]>> {
  const data = await rowsOf(
    supabase.rpc("team_leave_open_shifts", { p_organisation_id: organisationId }),
  );
  const out = new Map<string, OpenedShift[]>();
  for (const r of data) {
    const list = out.get(r.request_id) ?? [];
    list.push({
      assignmentId: r.assignment_id,
      shiftDate: r.shift_date,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      siteId: r.site_id,
      siteName: r.site_name,
      postId: r.post_id,
      postName: r.post_name,
    });
    out.set(r.request_id, list);
  }
  return out;
}

/** Logs the error's name only and answers `fallback`. */
async function orEmpty<T>(label: string, promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    console.error(`team.${label}_failed:`, error instanceof Error ? error.name : "unknown");
    return fallback;
  }
}

/** Everything /app/team shows, for the signed-in line manager, at `now`. */
export async function loadTeamBoard(
  supabase: Client,
  organisationId: string,
  now: Date = new Date(),
  { refresh = true }: { refresh?: boolean } = {},
): Promise<TeamBoard> {
  const settings = await loadTimesheetSettings(supabase, organisationId);
  const timeZone = settings.timeZone;
  const today = todayIn(timeZone, now);
  const weekStart = mondayOf(today);
  const period = periodFor(today, settings.payCycleStartDay);
  const linesFrom = weekStart < period.start ? weekStart : period.start;

  const members = (await loadTeamMembers(supabase, organisationId)).filter(
    (m) => m.status === "active",
  );
  // Fresh hours for the week and the period, so nobody waits for the 04:00 cron (4.2). The
  // database narrows a line manager's refresh to their reportees.
  if (refresh && members.length > 0) {
    await orEmpty("refresh", refreshTimesheetRange(supabase, organisationId, linesFrom, today), null);
  }

  const year = Number(today.slice(0, 4));
  const [board, shifts, openShifts, lines, leave, onLeave, balances, annual, queries, leaveOpens] =
    await Promise.all([
      orEmpty("board", loadAttendanceBoard(supabase, organisationId), null),
      orEmpty(
        "shifts",
        loadTeamShifts(supabase, organisationId, today, addDays(today, TEAM_SHIFT_DAYS - 1)),
        [],
      ),
      orEmpty(
        "open_shifts",
        loadOpenShifts(supabase, organisationId, today, addDays(today, OPEN_SHIFT_DAYS - 1)),
        [],
      ),
      orEmpty("lines", loadTimesheetLines(supabase, organisationId, linesFrom, today), []),
      orEmpty(
        "leave",
        loadLeaveRequests(supabase, organisationId, {
          statuses: ["pending_line_manager", "pending_hr"],
        }),
        [],
      ),
      orEmpty(
        "on_leave",
        loadLeaveRequests(supabase, organisationId, {
          statuses: ["approved"],
          from: today,
          to: today,
        }),
        [],
      ),
      members.length > 0
        ? orEmpty("balances", loadBalances(supabase, organisationId, year), [])
        : Promise.resolve([]),
      orEmpty(
        "annual",
        rowsOf(
          supabase
            .from("leave_types")
            .select("id")
            .eq("organisation_id", organisationId)
            .eq("code", "annual")
            .eq("status", "active")
            .limit(1),
        ).then((r) => r[0]?.id ?? null),
        null,
      ),
      orEmpty("queries", loadTeamQueries(supabase, organisationId), []),
      orEmpty("leave_opens", loadLeaveOpens(supabase, organisationId), new Map()),
    ]);

  const ids = new Set(members.map((m) => m.id));
  const boardRows = new Map<string, TodayBoardRow>();
  for (const r of board?.rows ?? []) {
    if (!ids.has(r.workerId)) continue;
    // A worker on two shifts today: the one that needs attention (or is live) wins.
    const seen = boardRows.get(r.workerId);
    if (!seen || seen.status === "clocked_out" || seen.status === "starting") {
      boardRows.set(r.workerId, {
        workerId: r.workerId,
        status: r.status,
        startsAt: r.startsAt,
        lateMinutes: r.lateMinutes,
      });
    }
  }
  const onLeaveIds = new Set(onLeave.map((r) => r.workerId));
  const weekMinutes = minutesByWorker(lines.filter((l) => l.workDate >= weekStart));
  const available = new Map<string, number>();
  for (const b of balances) available.set(balanceKey(b.workerId, b.leaveTypeId), b.available);

  const rows: TeamRow[] = members.map((member) => {
    const next = nextShift(shifts, member.id, now) ?? null;
    const laterToday =
      next && next.shiftDate === today && Date.parse(next.startsAt) > now.getTime() ? next : undefined;
    return {
      member,
      today: todayStatus({
        board: boardRows.get(member.id),
        onLeave: onLeaveIds.has(member.id),
        laterToday,
        now,
        timeZone,
      }),
      minutesThisWeek: weekMinutes.get(member.id) ?? 0,
      annualLeft: annual ? (available.get(balanceKey(member.id, annual)) ?? null) : null,
      next,
    };
  });

  const teamLeave = leave.filter((r) => ids.has(r.workerId));
  const teamQueries = queries;
  const summary = summariseMyTeam({
    today: rows.map((r) => r.today.kind),
    minutesThisWeek: [...weekMinutes.values()].reduce((a, b) => a + b, 0),
    leaveToDecide: teamLeave.filter((r) => r.status === "pending_line_manager" && r.canDecideStep1)
      .length,
    timesheetDaysOpen: lines.filter(
      (l) =>
        l.workDate >= period.start &&
        ids.has(l.workerId) &&
        (l.status === "pending" || l.status === "disputed"),
    ).length,
    openQueries: teamQueries.filter((q) => isQueryOpen(q.status)).length,
    overdueQueries: teamQueries.filter((q) => isQueryOverdue(q, today)).length,
    openShifts: openShifts.length,
  });

  return {
    timeZone,
    today,
    weekStart,
    rows,
    shifts,
    openShifts,
    leave: teamLeave,
    leaveOpens,
    balances: available,
    queries: teamQueries,
    summary,
    siteNames: [...new Set(members.flatMap((m) => m.siteNames))].sort(),
  };
}

/** Lira's read (`team.board_summary`): counts only, no names or ids. */
export async function loadMyTeamSummary(
  supabase: Client,
  organisationId: string,
): Promise<MyTeamSummary> {
  // No refresh: an agent read writes nothing (the hours are as of the last refresh or cron).
  return (await loadTeamBoard(supabase, organisationId, new Date(), { refresh: false })).summary;
}
