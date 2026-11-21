import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { todayIn } from "@/lib/dates";
import {
  cleanLineIds,
  type ContractType,
  type DecisionKind,
  type LineStatus,
} from "@/lib/timesheets/approval";
import { periodFor, periodStart } from "@/lib/timesheets/minutes";
import type { Database } from "@/types/db";

import { loadTimesheetSettings, refreshTimesheetRange } from "./timesheets-data";

/**
 * Reads for the timesheet screen and the worker's hours (slice 4.3). Both go through definer
 * reads that check the caller (public.timesheet_review_days: owner, admin, hr and ops_manager
 * every day, a line manager their reportees'; public.my_timesheet_days: the worker's own). They
 * carry names, sites, minutes and punch times; never a location, a phone number or money.
 *
 * Opening the screen refreshes the period it shows first (must-do 5), so nobody waits for the
 * 04:00 cron; a refresh that fails is logged by code and the screen still shows what is stored.
 */

type Client = SupabaseClient<Database>;

export const periodInput = z.object({
  /** Any day in the pay period wanted; today when left out. */
  period: z.iso.date("Choose a period").optional(),
});

export interface ReviewPunch {
  id: string;
  recordedAt: string;
  deviceTime: string;
  receivedAt: string;
  timeSource: string;
  driftSeconds: number | null;
  distanceM: number | null;
  accuracyM: number | null;
  geofence: string | null;
  source: "self" | "supervisor";
  hasSelfie: boolean;
}

export interface ReviewDay {
  id: string;
  workerId: string;
  workerName: string;
  staffId: string | null;
  workDate: string;
  status: LineStatus;
  hasShift: boolean;
  siteName: string | null;
  postName: string | null;
  postUnit: string | null;
  contractType: ContractType | null;
  billable: boolean | null;
  startsAt: string | null;
  endsAt: string | null;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  otMinutes: number;
  exceptions: string[];
  needsReview: boolean;
  clean: boolean;
  running: boolean;
  canDecide: boolean;
  canReopen: boolean;
  workUnitId: string | null;
  inPunch: ReviewPunch | null;
  outPunch: ReviewPunch | null;
  lastDecision: DecisionKind | null;
  lastDecisionReason: string | null;
  lastDecisionAt: string | null;
  lastCorrectionReason: string | null;
  corrections: number;
}

type ReviewRow = Database["public"]["Functions"]["timesheet_review_days"]["Returns"][number];

const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function punchOf(row: ReviewRow, side: "in" | "out"): ReviewPunch | null {
  const r = row as unknown as Record<string, unknown>;
  const id = s(r[`${side}_punch_id`]);
  if (!id) return null;
  return {
    id,
    recordedAt: String(r[`${side}_recorded_at`] ?? ""),
    deviceTime: String(r[`${side}_device_time`] ?? ""),
    receivedAt: String(r[`${side}_received_at`] ?? ""),
    timeSource: String(r[`${side}_time_source`] ?? ""),
    driftSeconds: n(r[`${side}_drift_seconds`]),
    distanceM: n(r[`${side}_distance_m`]),
    accuracyM: n(r[`${side}_accuracy_m`]),
    geofence: s(r[`${side}_geofence`]),
    source: r[`${side}_source`] === "supervisor" ? "supervisor" : "self",
    hasSelfie: r[`${side}_has_selfie`] === true,
  };
}

export function toReviewDay(row: ReviewRow): ReviewDay {
  const r = row as unknown as Record<string, unknown>;
  return {
    id: row.line_id,
    workerId: row.worker_id,
    workerName: s(r.worker_name) ?? "Unnamed",
    staffId: s(r.staff_id),
    workDate: row.work_date,
    status: row.status as LineStatus,
    hasShift: s(r.shift_assignment_id) !== null,
    siteName: s(r.site_name),
    postName: s(r.post_name),
    postUnit: s(r.post_unit),
    contractType: s(r.contract_type) as ContractType | null,
    billable: typeof r.billable === "boolean" ? r.billable : null,
    startsAt: s(r.starts_at),
    endsAt: s(r.ends_at),
    scheduledMinutes: row.scheduled_minutes,
    workedMinutes: row.worked_minutes,
    lateMinutes: row.late_minutes,
    earlyMinutes: row.early_minutes,
    otMinutes: row.ot_minutes,
    exceptions: (row.exceptions ?? []).map(String),
    needsReview: row.needs_review === true,
    clean: row.clean === true,
    running: row.running === true,
    canDecide: row.can_decide === true,
    canReopen: row.can_reopen === true,
    workUnitId: s(r.work_unit_id),
    inPunch: punchOf(row, "in"),
    outPunch: punchOf(row, "out"),
    lastDecision: s(r.last_decision) as DecisionKind | null,
    lastDecisionReason: s(r.last_decision_reason),
    lastDecisionAt: s(r.last_decision_at),
    lastCorrectionReason: s(r.last_correction_reason),
    corrections: Number(r.corrections ?? 0),
  };
}

export interface TimesheetReview {
  timeZone: string;
  today: string;
  period: { start: string; end: string };
  days: ReviewDay[];
  /** False when the refresh on open failed; the days are what was stored. */
  refreshed: boolean;
}

/**
 * The pay period holding `date` (today when left out): refreshed up to today, then read. The
 * days are sorted for the list: undecided first (disputed, then flagged, then needs review,
 * then clean), then decided, each by date and name.
 */
export async function loadTimesheetReview(
  supabase: Client,
  organisationId: string,
  date?: string,
): Promise<TimesheetReview> {
  const settings = await loadTimesheetSettings(supabase, organisationId);
  const today = todayIn(settings.timeZone);
  const period = periodFor(date ?? today, settings.payCycleStartDay);
  let refreshed = true;
  if (period.start <= today) {
    const to = period.end < today ? period.end : today;
    try {
      await refreshTimesheetRange(supabase, organisationId, period.start, to);
    } catch (error) {
      refreshed = false;
      console.error(
        "timesheets.refresh_on_open_failed:",
        error instanceof Error ? error.message.replace(/[^A-Za-z0-9 ()._-]/g, "") : "unknown",
      );
    }
  }
  const { data, error } = await supabase.rpc("timesheet_review_days", {
    p_organisation_id: organisationId,
    p_from: period.start,
    p_to: period.end,
  });
  if (error) throw new Error(`Could not read timesheet days (${error.code})`);
  const days = (data ?? []).map(toReviewDay).sort(reviewOrder);
  return { timeZone: settings.timeZone, today, period, days, refreshed };
}

/** Undecided first (disputed, flagged, needs review, clean), then decided; by date and name. */
export function reviewRank(
  day: Pick<ReviewDay, "status" | "clean" | "needsReview" | "exceptions">,
) {
  if (day.status === "disputed") return 0;
  if (day.status === "pending") {
    if (day.needsReview) return 1;
    if (!day.clean) return 2;
    return 3;
  }
  if (day.exceptions.includes("late_punch_after_decision")) return 4;
  return 5;
}

function reviewOrder(a: ReviewDay, b: ReviewDay): number {
  return (
    reviewRank(a) - reviewRank(b) ||
    a.workDate.localeCompare(b.workDate) ||
    a.workerName.localeCompare(b.workerName) ||
    a.id.localeCompare(b.id)
  );
}

export interface ReviewSummary {
  periodStart: string;
  periodEnd: string;
  days: number;
  /** Pending or disputed days the caller may decide. */
  toDecide: number;
  /** Of those, the ones "Approve N clean" takes. */
  clean: number;
  flagged: number;
  needsReview: number;
  disputed: number;
  approved: number;
  rejected: number;
  /** Decided days a punch arrived after (Reopen to count it). */
  latePunches: number;
  workedMinutes: number;
  otMinutes: number;
  /** Approved days that made a Work Unit, and how many of those are billable. */
  workUnits: number;
  billableWorkUnits: number;
}

/** Counts only (Lira's compact read): no names, ids or personal data. */
export function summariseReview(review: Pick<TimesheetReview, "period" | "days">): ReviewSummary {
  const days = review.days;
  const open = days.filter((d) => d.status === "pending" || d.status === "disputed");
  const mine = open.filter((d) => d.canDecide);
  const approvedWithUnit = days.filter((d) => d.status === "approved" && d.workUnitId);
  return {
    periodStart: review.period.start,
    periodEnd: review.period.end,
    days: days.length,
    toDecide: mine.length,
    clean: cleanLineIds(days).length,
    flagged: open.filter((d) => d.status === "pending" && !d.clean && !d.needsReview).length,
    needsReview: open.filter((d) => d.needsReview).length,
    disputed: open.filter((d) => d.status === "disputed").length,
    approved: days.filter((d) => d.status === "approved").length,
    rejected: days.filter((d) => d.status === "rejected").length,
    latePunches: days.filter((d) => d.exceptions.includes("late_punch_after_decision")).length,
    workedMinutes: days.reduce((sum, d) => sum + d.workedMinutes, 0),
    otMinutes: days.reduce((sum, d) => sum + d.otMinutes, 0),
    workUnits: approvedWithUnit.length,
    billableWorkUnits: approvedWithUnit.filter((d) => d.billable === true).length,
  };
}

/** Lira's read: the period's counts, refreshed like the screen. */
export async function loadReviewSummary(
  supabase: Client,
  organisationId: string,
  date?: string,
): Promise<ReviewSummary> {
  return summariseReview(await loadTimesheetReview(supabase, organisationId, date));
}

export interface MyDay {
  id: string;
  workDate: string;
  status: LineStatus;
  siteName: string | null;
  postName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  inAt: string | null;
  outAt: string | null;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  otMinutes: number;
  exceptions: string[];
  lastDecision: DecisionKind | null;
  lastDecisionReason: string | null;
  lastCorrectionReason: string | null;
  canDispute: boolean;
}

export interface MyHours {
  timeZone: string;
  period: { start: string; end: string };
  days: MyDay[];
}

/**
 * The worker's days in the pay period holding `date` (today when left out), refreshed first
 * with their own session (the database narrows it to them and caps it at 35 days).
 */
export async function loadMyHours(
  supabase: Client,
  organisationId: string,
  date?: string,
): Promise<MyHours> {
  const settings = await loadTimesheetSettings(supabase, organisationId);
  const today = todayIn(settings.timeZone);
  const period = periodFor(date ?? today, settings.payCycleStartDay);
  if (period.start <= today) {
    const to = period.end < today ? period.end : today;
    await refreshTimesheetRange(supabase, organisationId, period.start, to).catch((error) => {
      console.error(
        "timesheets.my_refresh_failed:",
        error instanceof Error ? error.message.replace(/[^A-Za-z0-9 ()._-]/g, "") : "unknown",
      );
    });
  }
  const { data, error } = await supabase.rpc("my_timesheet_days", {
    p_organisation_id: organisationId,
    p_from: period.start,
    p_to: period.end,
  });
  if (error) throw new Error(`Could not read your hours (${error.code})`);
  const days = (data ?? []).map((row): MyDay => {
    const r = row as unknown as Record<string, unknown>;
    return {
      id: row.line_id,
      workDate: row.work_date,
      status: row.status as LineStatus,
      siteName: s(r.site_name),
      postName: s(r.post_name),
      startsAt: s(r.starts_at),
      endsAt: s(r.ends_at),
      inAt: s(r.in_recorded_at),
      outAt: s(r.out_recorded_at),
      scheduledMinutes: row.scheduled_minutes,
      workedMinutes: row.worked_minutes,
      lateMinutes: row.late_minutes,
      earlyMinutes: row.early_minutes,
      otMinutes: row.ot_minutes,
      exceptions: (row.exceptions ?? []).map(String),
      lastDecision: s(r.last_decision) as DecisionKind | null,
      lastDecisionReason: s(r.last_decision_reason),
      lastCorrectionReason: s(r.last_correction_reason),
      canDispute: row.can_dispute === true,
    };
  });
  return { timeZone: settings.timeZone, period, days };
}

/** The pay periods a picker offers: this one and the 5 before it, newest first. */
export function recentPeriods(today: string, startDay: number, count = 6): string[] {
  const out: string[] = [];
  let start = periodStart(today, startDay);
  for (let i = 0; i < count; i += 1) {
    out.push(start);
    const [y, m] = start.split("-").map(Number) as [number, number];
    const prev = new Date(Date.UTC(y, m - 2, 1));
    start = periodStart(
      `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-28`,
      startDay,
    );
  }
  return out;
}
