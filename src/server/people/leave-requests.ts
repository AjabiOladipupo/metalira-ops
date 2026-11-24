import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import type { z } from "zod";

import type { ManagerRole } from "@/lib/roles";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";
import type { Json } from "@/types/db";

import { toHrDecisionResult, type HrDecisionResult } from "./leave-data";
import {
  adjustLeaveSchema,
  cancelLeaveSchema,
  cancelOwnLeaveSchema,
  decideLeaveSchema,
  requestLeaveSchema,
} from "./leave-request-schemas";
import type { OwnContext } from "./own-requests";

/**
 * Leave requests and balances (slice 4.4). Every write is one SQL function called as the person
 * (public.request_leave, decide_leave_line_manager, decide_leave_hr, cancel_leave_request,
 * adjust_leave_balance), which checks who they are again: the worker asks and cancels from the
 * worker app as themselves (the organisation and worker come from the session); the line manager
 * decides step 1 for their reportees (an owner, admin or ops_manager for a worker with no line
 * manager); HR (owner, admin or hr) decides step 2, cancels and adjusts. Nobody decides their own
 * leave. Registered in src/server/capabilities/registry.ts. Module: people.
 */

/** Who may open step 1 at all; the database narrows it to the right person per request. */
export const STEP1_ROLES = [
  "owner",
  "admin",
  "ops_manager",
  "line_manager",
] as const satisfies readonly ManagerRole[];
export const HR_ROLES = ["owner", "admin", "hr"] as const satisfies readonly ManagerRole[];
/** Who reads the Leave board (ops_manager: dates and type only). */
export const LEAVE_READERS = [
  "owner",
  "admin",
  "hr",
  "ops_manager",
  "line_manager",
] as const satisfies readonly ManagerRole[];
/** Who reads balances. */
export const BALANCE_READERS = [
  "owner",
  "admin",
  "hr",
  "line_manager",
] as const satisfies readonly ManagerRole[];

/** Database refusals in plain English. */
export function fromLeaveRequestError(error: PostgrestError): never {
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", error.message || "Your role can't do this.");
    case "MLLQ6":
      throw new MutationError("forbidden", error.message);
    case "P0002":
      throw new MutationError("invalid", `${error.message} Reload the page.`);
    case "MLLQ1":
    case "MLLQ8":
      throw new MutationError("invalid", error.message, { startDate: error.message });
    case "MLLQ2":
    case "MLLQ3":
    case "MLLQ4":
    case "MLLQ7":
    case "MLTA5":
    case "22023":
    case "23514":
      throw new MutationError("invalid", error.message);
    case "23P01":
      throw new MutationError("invalid", "You already asked for leave on some of these days.");
    case "40P01":
    case "40001":
      throw new MutationError("invalid", "Someone else changed this at the same time. Try again.");
    case "MLCN1":
      throw new MutationError(
        "forbidden",
        "Only the worker can do this, signed in to the worker app.",
      );
    case "MLCN2":
      throw new MutationError("forbidden", "You have left this company.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

type JsonObject = Record<string, unknown>;

function asObject(value: Json | null): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  throw new Error("Unexpected result shape from the database");
}

// ---------------------------------------------------------------------------
// The worker (worker app)
// ---------------------------------------------------------------------------

export interface RequestLeaveResult {
  id: string;
  days: number;
  shifts: number;
  sites: string[];
}

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data as z.output<S>;
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  const first = parsed.error.issues[0]?.message ?? "Check the highlighted fields.";
  throw new MutationError("invalid", first, fieldErrors);
}

/** The worker asks for leave, as themselves. */
export async function runRequestLeave(
  ctx: OwnContext,
  input: unknown,
): Promise<RequestLeaveResult> {
  const data = parseOrThrow(requestLeaveSchema, input);
  const { data: result, error } = await ctx.supabase.rpc("request_leave", {
    p_organisation_id: ctx.organisationId,
    p_leave_type_id: data.leaveTypeId,
    p_start_date: data.startDate,
    p_end_date: data.endDate,
    p_reason: data.reason ?? undefined,
  });
  if (error) fromLeaveRequestError(error);
  const o = asObject(result);
  return {
    id: String(o.id),
    days: Number(o.days ?? 0),
    shifts: Number(o.shifts ?? 0),
    sites: Array.isArray(o.site_names) ? (o.site_names as string[]) : [],
  };
}

/** The worker cancels their own request before the final decision. */
export async function runCancelOwnLeave(ctx: OwnContext, input: unknown): Promise<void> {
  const data = parseOrThrow(cancelOwnLeaveSchema, input);
  const { error } = await ctx.supabase.rpc("cancel_leave_request", {
    p_organisation_id: ctx.organisationId,
    p_request_id: data.requestId,
  });
  if (error) fromLeaveRequestError(error);
}

// ---------------------------------------------------------------------------
// Managers
// ---------------------------------------------------------------------------

export interface StepResult {
  id: string;
  status: string;
  days: number;
  workerId: string;
}

export const decideLineManagerSpec: MutationSpec<typeof decideLeaveSchema, StepResult> = {
  module: "people",
  schema: decideLeaveSchema,
  roles: STEP1_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("decide_leave_line_manager", {
      p_organisation_id: organisationId,
      p_request_id: data.requestId,
      p_decision: data.decision,
      p_note: data.note ?? undefined,
      p_certificate_seen: data.certificateSeen,
    });
    if (error) fromLeaveRequestError(error);
    const o = asObject(result);
    return {
      id: String(o.id),
      status: String(o.status),
      days: Number(o.days ?? 0),
      workerId: String(o.worker_id),
    };
  },
};

export const decideHrSpec: MutationSpec<typeof decideLeaveSchema, HrDecisionResult> = {
  module: "people",
  schema: decideLeaveSchema,
  roles: HR_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("decide_leave_hr", {
      p_organisation_id: organisationId,
      p_request_id: data.requestId,
      p_decision: data.decision,
      p_note: data.note ?? undefined,
      p_certificate_seen: data.certificateSeen,
      p_dry_run: false,
    });
    if (error) fromLeaveRequestError(error);
    return toHrDecisionResult(result);
  },
};

export interface CancelResult {
  id: string;
  returned: number;
  was: string;
}

export const cancelLeaveSpec: MutationSpec<typeof cancelLeaveSchema, CancelResult> = {
  module: "people",
  schema: cancelLeaveSchema,
  roles: HR_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("cancel_leave_request", {
      p_organisation_id: organisationId,
      p_request_id: data.requestId,
      p_reason: data.reason,
    });
    if (error) fromLeaveRequestError(error);
    const o = asObject(result);
    return { id: String(o.id), returned: Number(o.returned ?? 0), was: String(o.was) };
  },
};

export const adjustLeaveSpec: MutationSpec<typeof adjustLeaveSchema, { balance: number }> = {
  module: "people",
  schema: adjustLeaveSchema,
  roles: HR_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("adjust_leave_balance", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_leave_type_id: data.leaveTypeId,
      p_year: data.year,
      p_days: data.days,
      p_reason: data.reason,
    });
    if (error) fromLeaveRequestError(error);
    return { balance: Number(asObject(result).balance ?? 0) };
  },
};
