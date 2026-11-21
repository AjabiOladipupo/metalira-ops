import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatDate } from "@/lib/dates";
import type { ManagerRole } from "@/lib/roles";
import type { CleanRefusal } from "@/lib/timesheets/approval";
import { correctionReasonOk, formatMinutes } from "@/lib/timesheets/minutes";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";
import type { OwnContext } from "@/server/people/own-requests";
import type { Database } from "@/types/db";

import { notifyWorker } from "./notify";

/**
 * Timesheet decisions (slice 4.3), as `mutate()` specs. Each is one SQL function run with the
 * signed-in user's own client; the database checks the caller again (the worker's line manager,
 * ops_manager, admin or owner; never their own day; trusted sessions only), refreshes the day,
 * writes the insert-only decision and, for an approval, the Work Unit. Lines, decisions and Work
 * Units have no write grants. Minutes only: no money.
 *
 * The worker is told by inbox (and email inside the caps) when a day is rejected or adjusted:
 * `notifyWorker` runs after the database has committed, with the organisation from the session
 * and the worker from the database's own answer, never from the form. A failed notice never
 * undoes the decision; the screen still shows it.
 */

type Client = SupabaseClient<Database>;

/** Who decides a day (owner decision 6); a line manager only for their reportees. */
export const TIMESHEET_DECIDERS: readonly ManagerRole[] = [
  "owner",
  "admin",
  "ops_manager",
  "line_manager",
];

/** Who reopens a decided day. */
export const TIMESHEET_REOPENERS: readonly ManagerRole[] = ["owner", "admin", "ops_manager"];

/** At most this many days in one "Approve N clean". */
export const CLEAN_BATCH_MAX = 500;

const reasonField = (required: boolean) => {
  const text = z
    .string("Give a reason")
    .max(2000, "500 characters or fewer")
    .transform((v) => v.replace(/\s+/g, " ").trim());
  const checked = text
    .refine((v) => !required || v.length > 0, "Give a reason")
    .refine((v) => v.length <= 500, "500 characters or fewer")
    .refine(
      (v) => v.length === 0 || correctionReasonOk(v),
      "Plain text only, without web addresses or long numbers",
    );
  return required ? checked : z.preprocess((v) => v ?? "", checked);
};

export const approveLineSchema = z.object({
  lineId: z.uuid("Choose a day"),
  reason: reasonField(false),
});

export const rejectLineSchema = z.object({
  lineId: z.uuid("Choose a day"),
  reason: reasonField(true),
});

export const reopenLineSchema = rejectLineSchema;

export const disputeLineSchema = z.object({
  lineId: z.uuid("Choose a day"),
  reason: reasonField(true),
});

export const approveCleanSchema = z.object({
  lineIds: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").filter(Boolean) : v),
    z
      .array(z.uuid("Choose the days"))
      .min(1, "Choose at least one day")
      .max(CLEAN_BATCH_MAX, `At most ${CLEAN_BATCH_MAX} days at a time`),
  ),
});

/** The 42501 refusals the timesheet functions raise themselves (migrations 4.2 and 4.3). */
const OWN_FORBIDDEN = new Set([
  "Sign in to decide timesheets.",
  "Your role can't decide timesheets.",
  "You can decide only the timesheets of people who report to you.",
  "Sign in to reopen a timesheet.",
  "Your role can't reopen timesheets.",
  "Sign in to send this.",
  "Sign in to correct a timesheet.",
  "Your role can't correct timesheets.",
  "You can correct only the timesheets of people who report to you.",
]);

/** Database refusals in plain English (fixed codes; never the database's own text otherwise). */
export function fromApprovalDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    // Our own refusal texts only; anything else (a grant error) gets the fixed message.
    throw new MutationError(
      "forbidden",
      OWN_FORBIDDEN.has(error.message) ? error.message : "Your role can't decide timesheets.",
    );
  }
  if (error.code === "P0002") {
    const message = error.message || "That day wasn't found.";
    throw new MutationError(
      "invalid",
      message.endsWith("Reload the page.") ? message : `${message} Reload the page.`,
    );
  }
  if (/^MLT[AS][1-7]$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  if (error.code === "23514") {
    throw new MutationError("invalid", "Those values aren't allowed. Check the day and try again.");
  }
  throw new Error(`Database refused the decision (${error.code})`);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export interface ApproveResult {
  lineId: string;
  workUnitId: string | null;
  billable: boolean | null;
  workedMinutes: number;
  otMinutes: number;
}

export const approveLineSpec: MutationSpec<typeof approveLineSchema, ApproveResult> = {
  module: "shifts",
  schema: approveLineSchema,
  roles: TIMESHEET_DECIDERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("approve_timesheet_line", {
      p_organisation_id: organisationId,
      p_line_id: data.lineId,
      ...(data.reason ? { p_reason: data.reason } : {}),
    });
    if (error) fromApprovalDbError(error);
    const r = record(result);
    return {
      lineId: String(r.line_id ?? data.lineId),
      workUnitId: str(r.work_unit_id),
      billable: typeof r.billable === "boolean" ? r.billable : null,
      workedMinutes: Number(r.worked_minutes ?? 0),
      otMinutes: Number(r.ot_minutes ?? 0),
    };
  },
};

/** "Your day on 12 Nov 2026 wasn't approved", with the approver's reason. */
export function rejectedNotice(workDate: string, reason: string) {
  return {
    kind: "timesheet_rejected",
    title: `Your day on ${formatDate(workDate)} wasn't approved`,
    body: `Reason: ${reason}\nOpen My hours to see the day. If it is wrong, tap "This is wrong" and say why.`,
    link: "/m/hours",
  };
}

/** "Your hours on 12 Nov 2026 were corrected": the new minutes and the reason. */
export function adjustedNotice(
  workDate: string,
  workedMinutes: number,
  otMinutes: number,
  reason: string,
) {
  const minutes =
    otMinutes > 0
      ? `${formatMinutes(workedMinutes)} worked and ${formatMinutes(otMinutes)} overtime`
      : `${formatMinutes(workedMinutes)} worked`;
  return {
    kind: "timesheet_adjusted",
    title: `Your hours on ${formatDate(workDate)} were corrected`,
    body: `Now ${minutes}. Reason: ${reason}\nOpen My hours to see the day. If it is wrong, tap "This is wrong" and say why.`,
    link: "/m/hours",
  };
}

/** Tells the worker; logs the error name only and never fails the decision. */
export async function tellWorker(
  organisationId: string,
  workerId: string | null,
  message: Parameters<typeof notifyWorker>[2],
): Promise<void> {
  if (!workerId) return;
  try {
    await notifyWorker(organisationId, workerId, message);
  } catch (error) {
    console.error(
      "timesheets.notify_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
  }
}

export interface RejectResult {
  lineId: string;
  workDate: string | null;
}

export const rejectLineSpec: MutationSpec<typeof rejectLineSchema, RejectResult> = {
  module: "shifts",
  schema: rejectLineSchema,
  roles: TIMESHEET_DECIDERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("reject_timesheet_line", {
      p_organisation_id: organisationId,
      p_line_id: data.lineId,
      p_reason: data.reason,
    });
    if (error) fromApprovalDbError(error);
    const r = record(result);
    const workDate = str(r.work_date);
    if (workDate) {
      await tellWorker(organisationId, str(r.worker_id), rejectedNotice(workDate, data.reason));
    }
    return { lineId: String(r.line_id ?? data.lineId), workDate };
  },
};

export interface ReopenResult {
  lineId: string;
  cancelledWorkUnitId: string | null;
  workedMinutes: number;
  otMinutes: number;
}

export const reopenLineSpec: MutationSpec<typeof reopenLineSchema, ReopenResult> = {
  module: "shifts",
  schema: reopenLineSchema,
  roles: TIMESHEET_REOPENERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("reopen_timesheet_line", {
      p_organisation_id: organisationId,
      p_line_id: data.lineId,
      p_reason: data.reason,
    });
    if (error) fromApprovalDbError(error);
    const r = record(result);
    return {
      lineId: String(r.line_id ?? data.lineId),
      cancelledWorkUnitId: str(r.cancelled_work_unit_id),
      workedMinutes: Number(r.worked_minutes ?? 0),
      otMinutes: Number(r.ot_minutes ?? 0),
    };
  },
};

export interface CleanApproved {
  lineId: string;
  workerName: string | null;
  workDate: string;
  workedMinutes: number;
  otMinutes: number;
  workUnitId: string | null;
  billable: boolean | null;
}

export interface CleanRefused {
  lineId: string;
  code: CleanRefusal;
  workerName: string | null;
  workDate: string | null;
  exceptions: string[];
}

export interface CleanResult {
  dryRun: boolean;
  approved: CleanApproved[];
  refused: CleanRefused[];
}

const REFUSAL_CODES: readonly CleanRefusal[] = [
  "not_found",
  "own",
  "not_yours",
  "decided",
  "disputed",
  "running",
  "needs_review",
  "flagged",
];

export function parseCleanResult(value: unknown): CleanResult {
  const r = record(value);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(record) : []);
  return {
    dryRun: r.dry_run === true,
    approved: list(r.approved).map((a) => ({
      lineId: String(a.line_id ?? ""),
      workerName: str(a.worker_name),
      workDate: String(a.work_date ?? ""),
      workedMinutes: Number(a.worked_minutes ?? 0),
      otMinutes: Number(a.ot_minutes ?? 0),
      workUnitId: str(a.work_unit_id),
      billable: typeof a.billable === "boolean" ? a.billable : null,
    })),
    refused: list(r.refused).map((x) => {
      const code = REFUSAL_CODES.find((c) => c === x.code) ?? "not_found";
      return {
        lineId: String(x.line_id ?? ""),
        code,
        workerName: str(x.worker_name),
        workDate: str(x.work_date),
        exceptions: Array.isArray(x.exceptions) ? x.exceptions.map(String) : [],
      };
    }),
  };
}

/** Runs approve_clean_timesheet_lines, for real or as the preview's dry run. */
export async function runApproveClean(
  supabase: Client,
  organisationId: string,
  lineIds: string[],
  dryRun: boolean,
): Promise<CleanResult> {
  const { data, error } = await supabase.rpc("approve_clean_timesheet_lines", {
    p_organisation_id: organisationId,
    p_line_ids: lineIds,
    p_dry_run: dryRun,
  });
  if (error) fromApprovalDbError(error);
  return parseCleanResult(data);
}

export const approveCleanSpec: MutationSpec<typeof approveCleanSchema, CleanResult> = {
  module: "shifts",
  schema: approveCleanSchema,
  roles: TIMESHEET_DECIDERS,
  run: ({ supabase, organisationId, data }) =>
    runApproveClean(supabase, organisationId, data.lineIds, false),
};

export interface CorrectionPreview {
  lineId: string;
  current: { workedMinutes: number; otMinutes: number; exceptions: string[] };
  next: { workedMinutes: number; otMinutes: number; exceptions: string[] };
}

function minutesPart(value: unknown) {
  const r = record(value);
  return {
    workedMinutes: Number(r.worked_minutes ?? 0),
    otMinutes: Number(r.ot_minutes ?? 0),
    exceptions: Array.isArray(r.exceptions) ? r.exceptions.map(String) : [],
  };
}

/** "Adjust hours" preview: the minutes now and after the correction, nothing saved. */
export async function runCorrectionPreview(
  supabase: Client,
  organisationId: string,
  data: {
    lineId: string;
    kind: string;
    correctedAt: string | null;
    minutes: number | null;
    otMinutes: number | null;
    punchId: string | null;
    reason: string;
  },
): Promise<CorrectionPreview> {
  const { data: result, error } = await supabase.rpc("preview_timesheet_correction", {
    p_organisation_id: organisationId,
    p_line_id: data.lineId,
    p_kind: data.kind,
    p_reason: data.reason,
    ...(data.correctedAt ? { p_corrected_at: data.correctedAt } : {}),
    ...(data.minutes !== null ? { p_minutes: data.minutes } : {}),
    ...(data.otMinutes !== null ? { p_ot_minutes: data.otMinutes } : {}),
    ...(data.punchId ? { p_punch_id: data.punchId } : {}),
  });
  if (error) fromApprovalDbError(error);
  const r = record(result);
  return {
    lineId: String(r.line_id ?? data.lineId),
    current: minutesPart(r.current),
    next: minutesPart(r.next),
  };
}

/**
 * "This is wrong" from the worker app: the worker's own session (channel worker_app); the line
 * must be their own, which the database checks (the company comes from the line).
 */
export async function runDisputeLine(
  ctx: Pick<OwnContext, "supabase">,
  input: unknown,
): Promise<{ lineId: string }> {
  const parsed = disputeLineSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    throw new MutationError("invalid", fieldErrors.reason ?? "Say what is wrong.", fieldErrors);
  }
  const { data, error } = await ctx.supabase.rpc("dispute_timesheet_line", {
    p_line_id: parsed.data.lineId,
    p_reason: parsed.data.reason,
  });
  if (error) fromApprovalDbError(error);
  return { lineId: String(record(data).line_id ?? parsed.data.lineId) };
}
