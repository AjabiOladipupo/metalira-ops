import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays } from "@/lib/dates";
import type { LeaveCalendar } from "@/lib/leave/days";
import type { LeaveCounting } from "@/lib/leave/presets";
import { isLeaveStatus, type LeaveStatus } from "@/lib/leave/requests";
import type { Database, Json } from "@/types/db";

import { currentVersion, loadLeaveSetup, type LeaveTypeRow } from "./leave-setup-data";

/**
 * Reads for leave requests and balances (slice 4.4), as the signed-in person. The manager list
 * comes from public.leave_request_list (names without reading workers, which line managers can't;
 * ops managers get dates and type only). Balances come from public.leave_balances, which grants
 * the year on first read. No personal numbers anywhere here.
 */

type Client = SupabaseClient<Database>;

export interface LeaveRequestRow {
  id: string;
  workerId: string;
  workerName: string;
  staffId: string;
  departmentName: string | null;
  leaveTypeId: string;
  leaveTypeName: string;
  counting: LeaveCounting;
  needsCertificate: boolean;
  startDate: string;
  endDate: string;
  leaveYear: number;
  days: number;
  /** Null for an ops manager who doesn't decide it. */
  reason: string | null;
  status: LeaveStatus;
  certificateSeen: boolean;
  /** Owner, admin and hr only. */
  payPercent: number | null;
  payBelowService: boolean | null;
  createdAt: string;
  decidedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lineManagerName: string | null;
  hasLineManager: boolean;
  lineManagerStep: StepDecision | null;
  hrStep: StepDecision | null;
  canDecideStep1: boolean;
  canDecideStep2: boolean;
  canCancel: boolean;
}

export interface StepDecision {
  decision: "approved" | "declined";
  note: string | null;
  at: string;
  by: string | null;
}

type ListRow = Database["public"]["Functions"]["leave_request_list"]["Returns"][number];

function step(
  decision: string | null,
  note: string | null,
  at: string | null,
  by: string | null,
): StepDecision | null {
  if (decision !== "approved" && decision !== "declined") return null;
  return { decision, note, at: at ?? "", by };
}

function toRow(r: ListRow): LeaveRequestRow {
  return {
    id: r.id,
    workerId: r.worker_id,
    workerName: r.worker_name,
    staffId: r.staff_id,
    departmentName: r.department_name,
    leaveTypeId: r.leave_type_id,
    leaveTypeName: r.leave_type_name,
    counting: r.counting === "calendar_days" ? "calendar_days" : "working_days",
    needsCertificate: r.needs_certificate,
    startDate: r.start_date,
    endDate: r.end_date,
    leaveYear: r.leave_year,
    days: r.days,
    reason: r.reason,
    status: isLeaveStatus(r.status) ? r.status : "cancelled",
    certificateSeen: r.certificate_seen,
    payPercent: r.pay_percent,
    payBelowService: r.pay_below_service,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    lineManagerName: r.line_manager_name,
    hasLineManager: r.has_line_manager,
    lineManagerStep: step(r.lm_decision, r.lm_note, r.lm_decided_at, r.lm_actor_name),
    hrStep: step(r.hr_decision, r.hr_note, r.hr_decided_at, r.hr_actor_name),
    canDecideStep1: r.can_decide_step1,
    canDecideStep2: r.can_decide_step2,
    canCancel: r.can_cancel,
  };
}

export interface RequestFilter {
  statuses?: LeaveStatus[] | null;
  from?: string | null;
  to?: string | null;
  requestId?: string | null;
}

export async function loadLeaveRequests(
  supabase: Client,
  organisationId: string,
  filter: RequestFilter = {},
): Promise<LeaveRequestRow[]> {
  const { data, error } = await supabase.rpc("leave_request_list", {
    p_organisation_id: organisationId,
    p_statuses: filter.statuses ?? undefined,
    p_from: filter.from ?? undefined,
    p_to: filter.to ?? undefined,
    p_request_id: filter.requestId ?? undefined,
  });
  if (error) throw new Error(`Could not load leave requests (${error.code})`);
  return (data ?? []).map(toRow);
}

export async function loadLeaveRequest(
  supabase: Client,
  organisationId: string,
  requestId: string,
): Promise<LeaveRequestRow | null> {
  const rows = await loadLeaveRequests(supabase, organisationId, { requestId });
  return rows[0] ?? null;
}

export interface BalanceRow {
  workerId: string;
  leaveTypeId: string;
  granted: number;
  carried: number;
  adjusted: number;
  /** Net of returned days. */
  taken: number;
  /** Waiting for a decision. */
  pending: number;
  /** The ledger sum. */
  balance: number;
  /** Balance less pending. */
  available: number;
}

export async function loadBalances(
  supabase: Client,
  organisationId: string,
  year: number,
  workerIds?: string[],
): Promise<BalanceRow[]> {
  const { data, error } = await supabase.rpc("leave_balances", {
    p_organisation_id: organisationId,
    p_year: year,
    p_worker_ids: workerIds,
  });
  if (error) throw new Error(`Could not load leave balances (${error.code})`);
  return (data ?? []).map((b) => ({
    workerId: b.worker_id,
    leaveTypeId: b.leave_type_id,
    granted: b.granted,
    carried: b.carried,
    adjusted: b.adjusted,
    taken: b.taken,
    pending: b.pending,
    balance: b.balance,
    available: b.available,
  }));
}

/** The days a range covers for one worker, counted now in the database. */
export async function loadDayCount(
  supabase: Client,
  organisationId: string,
  workerId: string,
  leaveTypeId: string,
  from: string,
  to: string,
): Promise<{ days: number; shifts: number; sites: string[] } | null> {
  const { data, error } = await supabase.rpc("leave_day_count", {
    p_organisation_id: organisationId,
    p_worker_id: workerId,
    p_leave_type_id: leaveTypeId,
    p_from: from,
    p_to: to,
  });
  if (error) return null;
  const row = data?.[0];
  return row ? { days: row.days, shifts: row.shifts, sites: row.site_names ?? [] } : null;
}

// ---------------------------------------------------------------------------
// The Leave board (manager app)
// ---------------------------------------------------------------------------

const WAITING: LeaveStatus[] = ["pending_line_manager", "pending_hr"];

export interface LeaveBoard {
  today: string;
  onLeaveToday: number;
  waitingForLineManager: number;
  waitingForHr: number;
  startingIn14Days: number;
  /** Waiting first, then this year's decided ones, newest start first. */
  requests: LeaveRequestRow[];
  /** Approved and waiting requests overlapping the calendar's 14 days. */
  calendar: LeaveRequestRow[];
  yours: number;
}

/** Everything /app/leave shows, in two reads. */
export async function loadLeaveBoard(
  supabase: Client,
  organisationId: string,
  today: string,
): Promise<LeaveBoard> {
  const year = Number(today.slice(0, 4));
  const [waiting, year_rows] = await Promise.all([
    loadLeaveRequests(supabase, organisationId, { statuses: WAITING }),
    loadLeaveRequests(supabase, organisationId, {
      statuses: ["approved", "declined", "cancelled"],
      from: `${year}-01-01`,
      to: `${year + 1}-12-31`,
    }),
  ]);
  const horizon = addDays(today, 13);
  const approved = year_rows.filter((r) => r.status === "approved");
  const decided = [...year_rows].sort((a, b) => b.startDate.localeCompare(a.startDate));
  return {
    today,
    onLeaveToday: approved.filter((r) => r.startDate <= today && r.endDate >= today).length,
    waitingForLineManager: waiting.filter((r) => r.status === "pending_line_manager").length,
    waitingForHr: waiting.filter((r) => r.status === "pending_hr").length,
    startingIn14Days: [...approved, ...waiting].filter(
      (r) => r.startDate > today && r.startDate <= horizon,
    ).length,
    requests: [...waiting, ...decided],
    calendar: [...approved, ...waiting].filter((r) => r.endDate >= today && r.startDate <= horizon),
    yours: waiting.filter((r) => r.canDecideStep1 || r.canDecideStep2).length,
  };
}

/** Counts only, for the capability registry (no names, no reasons). */
export async function loadLeaveSummary(
  supabase: Client,
  organisationId: string,
  today: string,
): Promise<{
  onLeaveToday: number;
  waitingForLineManager: number;
  waitingForHr: number;
  startingIn14Days: number;
  waitingForYou: number;
}> {
  const board = await loadLeaveBoard(supabase, organisationId, today);
  return {
    onLeaveToday: board.onLeaveToday,
    waitingForLineManager: board.waitingForLineManager,
    waitingForHr: board.waitingForHr,
    startingIn14Days: board.startingIn14Days,
    waitingForYou: board.yours,
  };
}

// ---------------------------------------------------------------------------
// The worker's own leave (worker app)
// ---------------------------------------------------------------------------

export interface MyLeaveType {
  id: string;
  name: string;
  counting: LeaveCounting;
  needsCertificate: boolean;
  minServiceMonths: number;
  /** Days a year today (0: no allowance, so no balance check). */
  daysPerYear: number;
}

export interface MyBalance {
  leaveTypeId: string;
  name: string;
  counting: LeaveCounting;
  /** Granted + carried + adjusted this year. */
  entitled: number;
  available: number;
  balance: number;
  pending: number;
  limited: boolean;
}

export interface MyRequest {
  id: string;
  leaveTypeName: string;
  counting: LeaveCounting;
  startDate: string;
  endDate: string;
  days: number;
  status: LeaveStatus;
  createdAt: string;
  /** The latest decision's note, if any (a decline says why). */
  note: string | null;
  cancelReason: string | null;
}

export interface MyLeave {
  today: string;
  year: number;
  startDate: string;
  lineManagerName: string | null;
  types: MyLeaveType[];
  balances: MyBalance[];
  requests: MyRequest[];
  calendar: LeaveCalendar & { holidayNames: Record<string, string> };
}

function asObject(value: Json | unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Unexpected result shape from the database");
}

/** The worker's leave screen: types, balances, requests and the calendar the count needs. */
export async function loadMyLeave(
  supabase: Client,
  organisationId: string,
  workerId: string,
  today: string,
): Promise<MyLeave> {
  const year = Number(today.slice(0, 4));
  const [setup, calendarResult, requests, decisions] = await Promise.all([
    loadLeaveSetup(supabase, organisationId),
    supabase.rpc("my_leave_calendar", {
      p_organisation_id: organisationId,
      p_from: today,
      p_to: `${year}-12-31`,
    }),
    supabase
      .from("leave_requests")
      .select(
        "id, leave_type_id, start_date, end_date, days, status, created_at, cancel_reason, leave_types ( name, counting )",
      )
      .eq("organisation_id", organisationId)
      .eq("worker_id", workerId)
      .order("start_date", { ascending: false })
      .limit(30),
    supabase
      .from("leave_decisions")
      .select("request_id, note, created_at")
      .eq("organisation_id", organisationId)
      .eq("worker_id", workerId)
      .order("created_at", { ascending: false })
      .limit(60),
  ]);
  if (calendarResult.error) {
    throw new Error(`Could not load the leave calendar (${calendarResult.error.code})`);
  }
  if (requests.error) throw new Error(`Could not load leave requests (${requests.error.code})`);
  if (decisions.error) throw new Error(`Could not load decisions (${decisions.error.code})`);
  const balances = await loadBalances(supabase, organisationId, year);

  const active = setup.types.filter((t) => t.status === "active");
  const days = (t: LeaveTypeRow) => currentVersion(t, today)?.daysPerYear ?? 0;
  const types: MyLeaveType[] = active.map((t) => ({
    id: t.id,
    name: t.name,
    counting: t.counting,
    needsCertificate: t.needsCertificate,
    minServiceMonths: t.minServiceMonths,
    daysPerYear: days(t),
  }));

  const cal = asObject(calendarResult.data);
  const holidays = Array.isArray(cal.holidays) ? (cal.holidays as { date: string; name: string }[]) : [];
  const shifts = Array.isArray(cal.shifts) ? (cal.shifts as { date: string; site: string }[]) : [];
  const workDays = Array.isArray(cal.work_days) ? (cal.work_days as number[]) : [1, 2, 3, 4, 5];

  const latestNote = new Map<string, string | null>();
  for (const d of decisions.data) {
    if (!latestNote.has(d.request_id)) latestNote.set(d.request_id, d.note);
  }

  return {
    today,
    year,
    startDate: typeof cal.start_date === "string" ? cal.start_date : today,
    lineManagerName: typeof cal.line_manager_name === "string" ? cal.line_manager_name : null,
    types,
    balances: active.flatMap((t) => {
      const b = balances.find((row) => row.leaveTypeId === t.id);
      if (!b) return [];
      return [
        {
          leaveTypeId: t.id,
          name: t.name,
          counting: t.counting,
          entitled: b.granted + b.carried + b.adjusted,
          available: b.available,
          balance: b.balance,
          pending: b.pending,
          limited: days(t) > 0,
        },
      ];
    }),
    requests: requests.data.map((r) => ({
      id: r.id,
      leaveTypeName: r.leave_types?.name ?? "Leave",
      counting: r.leave_types?.counting === "calendar_days" ? "calendar_days" : "working_days",
      startDate: r.start_date,
      endDate: r.end_date,
      days: r.days,
      status: isLeaveStatus(r.status) ? r.status : "cancelled",
      createdAt: r.created_at,
      note: latestNote.get(r.id) ?? null,
      cancelReason: r.cancel_reason,
    })),
    calendar: {
      workDays,
      lastRostered: typeof cal.last_rostered === "string" ? cal.last_rostered : null,
      holidays: new Set(holidays.map((h) => h.date)),
      holidayNames: Object.fromEntries(holidays.map((h) => [h.date, h.name])),
      shifts,
    },
  };
}

// ---------------------------------------------------------------------------
// HR's final decision, as a dry run (the confirm step's preview)
// ---------------------------------------------------------------------------

export interface HrDecisionResult {
  id: string;
  status: LeaveStatus;
  days: number;
  workerId: string;
  dryRun: boolean;
  balanceBefore: number;
  balanceAfter: number;
  shifts: number;
  sites: string[];
  payBelowService: boolean;
}

export function toHrDecisionResult(value: Json | null): HrDecisionResult {
  const o = asObject(value);
  return {
    id: String(o.id),
    status: isLeaveStatus(String(o.status)) ? (o.status as LeaveStatus) : "pending_hr",
    days: Number(o.days ?? 0),
    workerId: String(o.worker_id),
    dryRun: o.dry_run === true,
    balanceBefore: Number(o.balance_before ?? 0),
    balanceAfter: Number(o.balance_after ?? 0),
    shifts: Number(o.shifts ?? 0),
    sites: Array.isArray(o.site_names) ? (o.site_names as string[]) : [],
    payBelowService: o.pay_below_service === true,
  };
}

export async function previewHrDecision(
  supabase: Client,
  organisationId: string,
  input: { requestId: string; decision: "approved" | "declined"; note: string | null; certificateSeen: boolean },
): Promise<HrDecisionResult> {
  const { data, error } = await supabase.rpc("decide_leave_hr", {
    p_organisation_id: organisationId,
    p_request_id: input.requestId,
    p_decision: input.decision,
    p_note: input.note ?? undefined,
    p_certificate_seen: input.certificateSeen,
    p_dry_run: true,
  });
  if (error) throw new Error(error.message);
  return toHrDecisionResult(data);
}
