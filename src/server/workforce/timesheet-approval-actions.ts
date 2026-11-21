"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatMinutes } from "@/lib/timesheets/minutes";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { ownContext } from "@/server/people/own-requests";

import type { WorkerActionState } from "./action-state";
import {
  approveCleanSpec,
  approveLineSpec,
  rejectLineSpec,
  reopenLineSpec,
  runApproveClean,
  runDisputeLine,
  type CleanResult,
} from "./timesheet-approval";

/**
 * Server Actions for timesheet approval (slice 4.3). Manager actions go through `mutate()` (role,
 * module, then Zod, then one SQL function as the user, which checks the caller again: the
 * worker's line manager, ops_manager, admin or owner, never their own day). "This is wrong" runs
 * with the worker's own session from /m/hours (channel worker_app). Registered in
 * src/server/capabilities/registry.ts. Logs carry error names only.
 */

const TIMESHEETS_PATH = "/app/timesheets";
const FORBIDDEN = "Your role can't decide this timesheet.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): CompanyFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") {
      return { ok: false, status: 403, formError: error.message || FORBIDDEN, values };
    }
    if (error.code === "invalid") {
      return {
        ok: false,
        status: 400,
        formError: error.message,
        fieldErrors: error.fieldErrors,
        values,
      };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "timesheets.decision_failed:",
    cause instanceof Error ? cause.name : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

/** Approve: the day is decided and, on a post with minutes, its Work Unit is made. */
export async function approveTimesheetLineAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(approveLineSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(TIMESHEETS_PATH);
  const unit = result.workUnitId
    ? result.billable
      ? " · billable Work Unit made"
      : " · Work Unit made"
    : "";
  return {
    ok: true,
    status: 200,
    message: `Approved · ${formatMinutes(result.workedMinutes)} worked${unit}`,
  };
}

/** Reject, with a reason; the worker is told. */
export async function rejectTimesheetLineAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(rejectLineSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(TIMESHEETS_PATH);
  return { ok: true, status: 200, message: "Rejected · the worker is told" };
}

/** Reopen a decided day, with a reason; its Work Unit is cancelled and a late punch counts. */
export async function reopenTimesheetLineAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(reopenLineSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(TIMESHEETS_PATH);
  return {
    ok: true,
    status: 200,
    message: `Reopened · ${formatMinutes(result.workedMinutes)} worked${result.cancelledWorkUnitId ? " · Work Unit cancelled" : ""}`,
  };
}

export type CleanActionState = {
  ok: boolean;
  message?: string;
  formError?: string;
  /** The dry run's answer, shown before the person confirms. */
  preview?: CleanResult;
  /** What was approved and refused, after confirming. */
  result?: CleanResult;
} | null;

/**
 * "Approve N clean". `mode=preview` runs the dry run (what would be approved and what is refused,
 * by name); `mode=apply` approves. Both through the same checks as one approval.
 */
export async function approveCleanTimesheetLinesAction(
  _prev: CleanActionState,
  formData: FormData,
): Promise<CleanActionState> {
  const fields = formFields(formData);
  const preview = fields.mode !== "apply";
  try {
    if (preview) {
      const spec = {
        ...approveCleanSpec,
        run: ({ supabase, organisationId, data }: Parameters<typeof approveCleanSpec.run>[0]) =>
          runApproveClean(supabase, organisationId, data.lineIds, true),
      };
      const result = await mutate(spec, fields);
      return { ok: true, preview: result };
    }
    const result = await mutate(approveCleanSpec, fields);
    revalidatePath(TIMESHEETS_PATH);
    const n = result.approved.length;
    return {
      ok: true,
      result,
      message: `${n} ${n === 1 ? "day" : "days"} approved${result.refused.length > 0 ? ` · ${result.refused.length} left for you to decide` : ""}`,
    };
  } catch (error) {
    const state = refusal(error);
    return { ok: false, formError: state?.formError ?? FAILED };
  }
}

/** "This is wrong" on /m/hours: the worker disputes their own day with a reason. */
export async function disputeTimesheetLineAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  try {
    await runDisputeLine(await ownContext(), formFields(formData));
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
      if (error.code === "invalid" || error.code === "forbidden") {
        return { ok: false, message: error.message };
      }
    }
    console.error(
      "timesheets.dispute_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return { ok: false, message: "That was not sent. Try again in a minute." };
  }
  revalidatePath("/m/hours");
  return { ok: true, message: "Sent to your manager. You will see their decision here." };
}
