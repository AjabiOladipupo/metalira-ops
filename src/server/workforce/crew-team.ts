import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import { addDays, todayIn } from "@/lib/dates";
import { createServerSupabase } from "@/lib/supabase/server";
import { assertModuleOn, runMutation, type MutationSpec } from "@/server/identity/mutate";
import { decideLineManagerSpec, type StepResult } from "@/server/people/leave-requests";
import type { Database } from "@/types/db";

import type { CrewSession } from "./crew-session";
import {
  approveLineSpec,
  rejectLineSpec,
  type ApproveResult,
  type RejectResult,
} from "./timesheet-approval";
import { loadTimesheetSettings, refreshTimesheetRange } from "./timesheets-data";

/**
 * My team in the worker app (/m/team, slice 4.7b; the SupHome Approvals tile). Who opens it: a
 * worker-supervisor (a worker login whose worker record is the line manager of a crew, owner
 * decision 21 Nov 2026) or a line_manager login on the worker app, through the crew session
 * (crew-session.ts). The database decides whom each may see and decide (migration
 * 20261121210000_supervisor_team.sql):
 *
 * - Timesheet days: crew_timesheet_days, then 4.3's approve_timesheet_line and
 *   reject_timesheet_line, which accept a worker-supervisor for their crew
 *   (private.my_supervised_crew_ids, Shifts on) as well as a line manager for their reportees.
 *   Never their own day. The same specs and notices as /app/timesheets.
 * - Leave at step 1: crew_leave_requests, then 4.4's decide_leave_line_manager, whose step-1
 *   rule now counts a worker-supervisor as their crew's line manager.
 * - Queries are out of scope (owner, 21 Nov 2026): a supervisor reads no staff queries.
 *
 * Every read carries names, sites, dates and minutes only: no bank, tax, pay, phone or location.
 */

type Client = SupabaseClient<Database>;

/** Who may try (the database narrows each to their crew or reportees). */
export const CREW_DECIDERS = ["worker", "line_manager"] as const;

/** The worker refresh's limit (migration 20261121120000): the last 35 days. */
export const CREW_WINDOW_DAYS = 35;

export const crewApproveSpec: MutationSpec<typeof approveLineSpec.schema, ApproveResult> = {
  ...approveLineSpec,
  roles: CREW_DECIDERS,
  channel: "worker_app",
};

export const crewRejectSpec: MutationSpec<typeof rejectLineSpec.schema, RejectResult> = {
  ...rejectLineSpec,
  roles: CREW_DECIDERS,
  channel: "worker_app",
};

export const crewLeaveStep1Spec: MutationSpec<typeof decideLineManagerSpec.schema, StepResult> = {
  ...decideLineManagerSpec,
  roles: CREW_DECIDERS,
  channel: "worker_app",
};

/**
 * Runs a crew decision as the supervisor (their own session; audit channel worker_app), after
 * the spec's module switch. The role only says who may try: the SQL function checks the crew.
 */
export async function runCrewDecision<S extends z.ZodType, R>(
  session: CrewSession,
  spec: MutationSpec<S, R>,
  input: unknown,
): Promise<R> {
  const supabase = await createServerSupabase({ channel: "worker_app" });
  if (spec.module) await assertModuleOn(supabase, session.organisationId, spec.module);
  return runMutation(
    {
      supabase,
      userId: session.userId,
      organisationId: session.organisationId,
      role: session.kind,
    },
    spec,
    input,
  );
}

export interface CrewDay {
  id: string;
  workerId: string;
  workerName: string;
  staffId: string | null;
  workDate: string;
  status: "pending" | "disputed";
  siteName: string | null;
  postName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  otMinutes: number;
  exceptions: string[];
  needsReview: boolean;
  running: boolean;
  disputeReason: string | null;
}

export interface CrewOpenShift {
  date: string;
  startsAt: string;
  endsAt: string;
  siteName: string;
  postName: string;
}

export interface CrewLeave {
  id: string;
  workerId: string;
  workerName: string;
  leaveTypeName: string;
  counting: "working_days" | "calendar_days";
  needsCertificate: boolean;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  /** The ledger sum for the type and year, before this request. */
  balance: number;
  /** Days the worker's other pending requests of this type hold. */
  otherPending: number;
  openShifts: CrewOpenShift[];
}

export interface CrewQueue {
  kind: CrewSession["kind"];
  timeZone: string;
  shiftsEnabled: boolean;
  days: CrewDay[];
  leave: CrewLeave[];
  /** False when the refresh on open failed; the days are what was stored. */
  refreshed: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function openShifts(value: unknown): CrewOpenShift[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const r = (v ?? {}) as Record<string, unknown>;
    return {
      date: String(r.date ?? ""),
      startsAt: String(r.starts_at ?? ""),
      endsAt: String(r.ends_at ?? ""),
      siteName: String(r.site_name ?? ""),
      postName: String(r.post_name ?? ""),
    };
  });
}

async function readDays(supabase: Client, organisationId: string): Promise<CrewDay[]> {
  const { data, error } = await supabase.rpc("crew_timesheet_days", {
    p_organisation_id: organisationId,
  });
  if (error) throw new Error(`Could not read the team's days (${error.code})`);
  return (data ?? []).map((r) => ({
    id: r.line_id,
    workerId: r.worker_id,
    workerName: str(r.worker_name) ?? "Unnamed",
    staffId: str(r.staff_id),
    workDate: r.work_date,
    status: r.status === "disputed" ? "disputed" : "pending",
    siteName: str(r.site_name),
    postName: str(r.post_name),
    startsAt: str(r.starts_at),
    endsAt: str(r.ends_at),
    workedMinutes: r.worked_minutes,
    lateMinutes: r.late_minutes,
    earlyMinutes: r.early_minutes,
    otMinutes: r.ot_minutes,
    exceptions: (r.exceptions ?? []).map(String),
    needsReview: r.needs_review === true,
    running: r.running === true,
    disputeReason: str(r.dispute_reason),
  }));
}

async function readLeave(supabase: Client, organisationId: string): Promise<CrewLeave[]> {
  const { data, error } = await supabase.rpc("crew_leave_requests", {
    p_organisation_id: organisationId,
  });
  if (error) throw new Error(`Could not read the team's leave (${error.code})`);
  return (data ?? []).map((r) => ({
    id: r.id,
    workerId: r.worker_id,
    workerName: str(r.worker_name) ?? "Unnamed",
    leaveTypeName: r.leave_type_name,
    counting: r.counting === "calendar_days" ? "calendar_days" : "working_days",
    needsCertificate: r.needs_certificate === true,
    startDate: r.start_date,
    endDate: r.end_date,
    days: r.days,
    reason: str(r.reason),
    balance: r.balance ?? 0,
    otherPending: r.other_pending ?? 0,
    openShifts: openShifts(r.open_shifts),
  }));
}

async function shiftsOn(supabase: Client, organisationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("organisations")
    .select("shifts_enabled")
    .eq("id", organisationId)
    .maybeSingle();
  return data?.shifts_enabled !== false;
}

/**
 * What /m/team lists for the signed-in supervisor: the crew's days refreshed over the last 35
 * days first (so nobody waits for the 04:00 cron), then the two reads.
 */
export async function loadCrewQueue(session: CrewSession): Promise<CrewQueue> {
  const supabase = await createServerSupabase({ channel: "worker_app" });
  const organisationId = session.organisationId;
  const [settings, shiftsEnabled] = await Promise.all([
    loadTimesheetSettings(supabase, organisationId),
    shiftsOn(supabase, organisationId),
  ]);
  let refreshed = true;
  if (shiftsEnabled) {
    const today = todayIn(settings.timeZone);
    try {
      await refreshTimesheetRange(
        supabase,
        organisationId,
        addDays(today, -(CREW_WINDOW_DAYS - 1)),
        today,
      );
    } catch (error) {
      refreshed = false;
      const code =
        error instanceof Error ? (/\(([0-9A-Z]{5})\)/.exec(error.message)?.[1] ?? error.name) : "unknown";
      console.error("crew_team.refresh_failed:", code);
    }
  }
  const [days, leave] = await Promise.all([
    shiftsEnabled ? readDays(supabase, organisationId) : Promise.resolve([]),
    readLeave(supabase, organisationId),
  ]);
  return {
    kind: session.kind,
    timeZone: settings.timeZone,
    shiftsEnabled,
    days,
    leave,
    refreshed,
  };
}

/** The count on the worker home's Approvals row: finished days to decide, plus leave at step 1. */
export function crewApprovalCount(queue: Pick<CrewQueue, "days" | "leave">): number {
  return queue.days.filter((d) => !d.running).length + queue.leave.length;
}

/**
 * For the worker home: whether the caller supervises anyone (the Approvals tile shows only
 * then) and the count on it, read without a refresh. Null when they supervise nobody.
 */
export async function loadCrewTile(
  supabase: Client,
  organisationId: string,
): Promise<{ count: number } | null> {
  const { data: size, error } = await supabase.rpc("crew_team_size", {
    p_organisation_id: organisationId,
  });
  if (error || !size) return null;
  const [days, leave] = await Promise.all([
    shiftsOn(supabase, organisationId).then((on) =>
      on ? readDays(supabase, organisationId).catch(() => []) : [],
    ),
    readLeave(supabase, organisationId).catch(() => []),
  ]);
  return { count: crewApprovalCount({ days, leave }) };
}

export interface CrewQueueSummary {
  daysToDecide: number;
  daysRunning: number;
  disputed: number;
  leaveToDecide: number;
  leaveShiftsOpened: number;
}

/** Counts only (Lira's compact read): no names, ids or personal data. */
export function summariseCrewQueue(
  queue: Pick<CrewQueue, "days" | "leave">,
): CrewQueueSummary {
  return {
    daysToDecide: queue.days.filter((d) => !d.running).length,
    daysRunning: queue.days.filter((d) => d.running).length,
    disputed: queue.days.filter((d) => d.status === "disputed").length,
    leaveToDecide: queue.leave.length,
    leaveShiftsOpened: queue.leave.reduce((sum, l) => sum + l.openShifts.length, 0),
  };
}

/** The team's counts without a refresh, with the caller's own client (the registry's read). */
export async function loadCrewSummary(
  supabase: Client,
  organisationId: string,
): Promise<CrewQueueSummary> {
  const on = await shiftsOn(supabase, organisationId);
  const [days, leave] = await Promise.all([
    on ? readDays(supabase, organisationId) : Promise.resolve([]),
    readLeave(supabase, organisationId),
  ]);
  return summariseCrewQueue({ days, leave });
}
