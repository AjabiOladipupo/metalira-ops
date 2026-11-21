import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { LAGOS_TIME_ZONE, todayIn } from "@/lib/dates";
import { periodFor, type TimesheetException } from "@/lib/timesheets/minutes";
import type { Database } from "@/types/db";

/**
 * Timesheet reads (slice 4.2). Every query runs with the signed-in user's own client and is
 * scoped to the active organisation, so RLS decides who sees what: owner, admin, hr and
 * ops_manager every line; a line manager their reportees'; a worker their own. Lines carry ids,
 * dates and minutes only: no names, no locations, no money.
 *
 * `refreshTimesheetRange` is the hook slice 4.3's timesheet screen calls before it reads, so
 * nobody waits for the 04:00 cron ("opening the timesheet screen refreshes the range it shows").
 */

type Client = SupabaseClient<Database>;

const PAGE = 1000;

export const timesheetRangeInput = z
  .object({
    from: z.iso.date("Choose the first day"),
    to: z.iso.date("Choose the last day"),
  })
  .refine((v) => v.from <= v.to, "The last day comes after the first");

export const timesheetSummaryInput = z.object({
  /** A day in the period wanted; today when left out. */
  date: z.iso.date("Choose a day").optional(),
});

export interface RefreshResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/**
 * Rebuilds the pending and disputed lines from `from` to `to` (62 days at most) for the workers
 * the caller may see (the database narrows a line manager to their reportees and a worker to
 * themselves). Decided lines are never touched.
 */
export async function refreshTimesheetRange(
  supabase: Client,
  organisationId: string,
  from: string,
  to: string,
  workerIds?: string[],
): Promise<RefreshResult> {
  const { data, error } = await supabase.rpc("refresh_timesheet_lines", {
    p_organisation_id: organisationId,
    p_from: from,
    p_to: to,
    ...(workerIds ? { p_worker_ids: workerIds } : {}),
  });
  if (error) throw new Error(`Could not refresh timesheets (${error.code})`);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    inserted: Number(r.inserted ?? 0),
    updated: Number(r.updated ?? 0),
    deleted: Number(r.deleted ?? 0),
  };
}

export interface TimesheetSettings {
  timeZone: string;
  payCycleStartDay: number;
}

export async function loadTimesheetSettings(
  supabase: Client,
  organisationId: string,
): Promise<TimesheetSettings> {
  const { data, error } = await supabase
    .from("organisations")
    .select("timezone, pay_cycle_start_day")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the company: ${error.message}`);
  return {
    timeZone: data?.timezone ?? LAGOS_TIME_ZONE,
    payCycleStartDay: data?.pay_cycle_start_day ?? 20,
  };
}

export interface TimesheetLine {
  id: string;
  timesheetId: string;
  workerId: string;
  workDate: string;
  shiftAssignmentId: string | null;
  shiftId: string | null;
  postId: string | null;
  siteId: string | null;
  inPunchId: string | null;
  outPunchId: string | null;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  otMinutes: number;
  exceptions: TimesheetException[];
  needsReview: boolean;
  status: "pending" | "approved" | "rejected" | "disputed";
}

const LINE_COLUMNS =
  "id, timesheet_id, worker_id, work_date, shift_assignment_id, shift_id, post_id, site_id, in_punch_id, out_punch_id, scheduled_minutes, worked_minutes, late_minutes, early_minutes, ot_minutes, exceptions, needs_review, status";

/** The lines from `from` to `to` the caller may read, by day then worker. */
export async function loadTimesheetLines(
  supabase: Client,
  organisationId: string,
  from: string,
  to: string,
  cap = 20_000,
): Promise<TimesheetLine[]> {
  const out: TimesheetLine[] = [];
  for (let start = 0; start < cap; start += PAGE) {
    const { data, error } = await supabase
      .from("timesheet_lines")
      .select(LINE_COLUMNS)
      .eq("organisation_id", organisationId)
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date")
      .order("worker_id")
      .order("id")
      .range(start, start + PAGE - 1);
    if (error) throw new Error(`Could not read timesheet days: ${error.message}`);
    for (const row of data ?? []) {
      out.push({
        id: row.id,
        timesheetId: row.timesheet_id,
        workerId: row.worker_id,
        workDate: row.work_date,
        shiftAssignmentId: row.shift_assignment_id,
        shiftId: row.shift_id,
        postId: row.post_id,
        siteId: row.site_id,
        inPunchId: row.in_punch_id,
        outPunchId: row.out_punch_id,
        scheduledMinutes: row.scheduled_minutes,
        workedMinutes: row.worked_minutes,
        lateMinutes: row.late_minutes,
        earlyMinutes: row.early_minutes,
        otMinutes: row.ot_minutes,
        exceptions: row.exceptions as TimesheetException[],
        needsReview: row.needs_review,
        status: row.status as TimesheetLine["status"],
      });
    }
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

export interface TimesheetSummary {
  periodStart: string;
  periodEnd: string;
  days: number;
  workers: number;
  pending: number;
  approved: number;
  rejected: number;
  disputed: number;
  /** Pending or disputed days with at least one exception. */
  flagged: number;
  /** Pending or disputed days whose punch time rests on the phone (decision 12). */
  needsReview: number;
  /** Pending days with no exception and nothing to review. */
  clean: number;
  noClockOut: number;
  noShow: number;
  late: number;
  workedMinutes: number;
  otMinutes: number;
}

/** Counts only (Lira's compact read): no names, ids or personal data. */
export function summariseLines(
  lines: readonly TimesheetLine[],
  period: { start: string; end: string },
): TimesheetSummary {
  const open = (l: TimesheetLine) => l.status === "pending" || l.status === "disputed";
  const has = (l: TimesheetLine, e: TimesheetException) => l.exceptions.includes(e);
  return {
    periodStart: period.start,
    periodEnd: period.end,
    days: lines.length,
    workers: new Set(lines.map((l) => l.workerId)).size,
    pending: lines.filter((l) => l.status === "pending").length,
    approved: lines.filter((l) => l.status === "approved").length,
    rejected: lines.filter((l) => l.status === "rejected").length,
    disputed: lines.filter((l) => l.status === "disputed").length,
    flagged: lines.filter((l) => open(l) && l.exceptions.length > 0).length,
    needsReview: lines.filter((l) => open(l) && l.needsReview).length,
    clean: lines.filter((l) => l.status === "pending" && l.exceptions.length === 0 && !l.needsReview)
      .length,
    noClockOut: lines.filter((l) => open(l) && has(l, "no_clock_out")).length,
    noShow: lines.filter((l) => open(l) && has(l, "no_show")).length,
    late: lines.filter((l) => has(l, "late")).length,
    workedMinutes: lines.reduce((sum, l) => sum + l.workedMinutes, 0),
    otMinutes: lines.reduce((sum, l) => sum + l.otMinutes, 0),
  };
}

/** The pay period holding `date` (today when left out) and its counts. Reads, never refreshes. */
export async function loadTimesheetSummary(
  supabase: Client,
  organisationId: string,
  date?: string,
): Promise<TimesheetSummary> {
  const settings = await loadTimesheetSettings(supabase, organisationId);
  const period = periodFor(date ?? todayIn(settings.timeZone), settings.payCycleStartDay);
  const lines = await loadTimesheetLines(supabase, organisationId, period.start, period.end);
  return summariseLines(lines, period);
}
