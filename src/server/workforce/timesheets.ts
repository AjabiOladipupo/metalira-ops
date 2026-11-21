import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import type { ManagerRole } from "@/lib/roles";
import { correctionReasonOk, type TimesheetException } from "@/lib/timesheets/minutes";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";

import {
  adjustedNotice,
  runCorrectionPreview,
  tellWorker,
  type CorrectionPreview,
} from "./timesheet-approval";

/**
 * Timesheet writes (slice 4.2), as `mutate()` specs. A correction is one SQL function run with the
 * signed-in user's own client: `add_timesheet_correction` checks the caller in the database (the
 * worker's line manager, ops_manager, admin or owner; never their own line; trusted sessions
 * only), inserts the insert-only correction and refreshes the line. Lines and corrections have no
 * write grants; the audit triggers record every row change. No money.
 */

/** Who reads timesheets (PHASE_4 Roles); a line manager reads only their reportees'. */
export const TIMESHEET_READERS: readonly ManagerRole[] = [
  "owner",
  "admin",
  "hr",
  "ops_manager",
  "line_manager",
];

/** Who corrects a day (a line manager only for their reportees, never their own). */
export const TIMESHEET_CORRECTORS: readonly ManagerRole[] = [
  "owner",
  "admin",
  "ops_manager",
  "line_manager",
];

export const CORRECTION_KINDS = [
  "set_clock_in",
  "set_clock_out",
  "set_minutes",
  "void_punch",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const minutesField = z.preprocess(
  blank,
  z.coerce
    .number("Give the minutes as a number")
    .int("Whole minutes only")
    .min(0, "0 or more")
    .max(1440, "1,440 minutes at most")
    .optional(),
);

export const addCorrectionSchema = z
  .object({
    lineId: z.uuid("Choose a day"),
    kind: z.enum(CORRECTION_KINDS, "Choose what to correct"),
    correctedAt: z.preprocess(
      blank,
      z.iso.datetime({ offset: true, message: "Give a date and time" }).optional(),
    ),
    minutes: minutesField,
    otMinutes: minutesField,
    punchId: z.preprocess(blank, z.uuid("Choose a punch").optional()),
    reason: z
      .string("Give a reason")
      .max(2000, "500 characters or fewer")
      .transform((v) => v.replace(/\s+/g, " ").trim())
      .refine((v) => v.length > 0, "Give a reason")
      .refine((v) => v.length <= 500, "500 characters or fewer")
      .refine(
        (v) => correctionReasonOk(v),
        "Plain text only, without web addresses or long numbers",
      ),
  })
  .superRefine((value, ctx) => {
    const need = (field: "correctedAt" | "minutes" | "punchId", message: string) => {
      if (value[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message });
    };
    if (value.kind === "set_clock_in" || value.kind === "set_clock_out") {
      need("correctedAt", "Give the time");
    } else if (value.kind === "set_minutes") {
      need("minutes", "Give the minutes worked");
    } else {
      need("punchId", "Choose the punch to set aside");
    }
  })
  .transform((value) => ({
    lineId: value.lineId,
    kind: value.kind,
    correctedAt:
      value.kind === "set_clock_in" || value.kind === "set_clock_out"
        ? (value.correctedAt ?? null)
        : null,
    minutes: value.kind === "set_minutes" ? (value.minutes ?? null) : null,
    otMinutes: value.kind === "set_minutes" ? (value.otMinutes ?? 0) : null,
    punchId: value.kind === "void_punch" ? (value.punchId ?? null) : null,
    reason: value.reason,
  }));

/** Database refusals in plain English. */
export function fromTimesheetDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", error.message || "Your role can't correct timesheets.");
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  }
  if (error.code === "23514") {
    // A value outside its range check (security review M1): never the database's own message.
    throw new MutationError(
      "invalid",
      "Those times would make a day longer than 24 hours. Check the clock-in and clock-out.",
    );
  }
  if (/^MLTS[1-4]$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

export interface CorrectionResult {
  correctionId: string;
  lineId: string;
  workedMinutes: number;
  otMinutes: number;
  exceptions: TimesheetException[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export const addCorrectionSpec: MutationSpec<typeof addCorrectionSchema, CorrectionResult> = {
  module: "shifts",
  schema: addCorrectionSchema,
  roles: TIMESHEET_CORRECTORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("add_timesheet_correction", {
      p_organisation_id: organisationId,
      p_line_id: data.lineId,
      p_kind: data.kind,
      p_reason: data.reason,
      ...(data.correctedAt ? { p_corrected_at: data.correctedAt } : {}),
      ...(data.minutes !== null ? { p_minutes: data.minutes } : {}),
      ...(data.otMinutes !== null ? { p_ot_minutes: data.otMinutes } : {}),
      ...(data.punchId ? { p_punch_id: data.punchId } : {}),
    });
    if (error) fromTimesheetDbError(error);
    const r = record(result);
    const out = {
      correctionId: String(r.correction_id ?? ""),
      lineId: String(r.line_id ?? data.lineId),
      workedMinutes: Number(r.worked_minutes ?? 0),
      otMinutes: Number(r.ot_minutes ?? 0),
      exceptions: Array.isArray(r.exceptions) ? (r.exceptions as TimesheetException[]) : [],
    };
    // Slice 4.3: the worker is told their hours were adjusted (inbox, email inside the caps). The
    // worker and day come from the database (read as the corrector, under RLS), never the form.
    const { data: line } = await supabase
      .from("timesheet_lines")
      .select("worker_id, work_date")
      .eq("organisation_id", organisationId)
      .eq("id", out.lineId)
      .maybeSingle();
    if (line) {
      await tellWorker(
        organisationId,
        line.worker_id,
        adjustedNotice(line.work_date, out.workedMinutes, out.otMinutes, data.reason),
      );
    }
    return out;
  },
};

/**
 * "Adjust hours" preview (slice 4.3, must-do 4): the same checks as the correction, through
 * `mutate()`, and the minutes now and after it. Nothing is saved.
 */
export const previewCorrectionSpec: MutationSpec<typeof addCorrectionSchema, CorrectionPreview> = {
  module: "shifts",
  schema: addCorrectionSchema,
  roles: TIMESHEET_CORRECTORS,
  run: ({ supabase, organisationId, data }) => runCorrectionPreview(supabase, organisationId, data),
};
