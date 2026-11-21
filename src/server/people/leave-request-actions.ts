"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";

import { notifyOpsOfOpenedShifts } from "./leave-cover-notice";
import { notifyLeaveDeciders, notifyWorkerOfLeave } from "./leave-notices";
import { adjustLeaveSpec, cancelLeaveSpec, decideHrSpec, decideLineManagerSpec } from "./leave-requests";

/**
 * Server Actions for leave on the manager app (slice 4.4): step 1 and step 2 decisions, HR's
 * cancellation and balance adjustments. Each goes through `mutate()` (role, Zod, then one SQL
 * function as the user, which checks the person again). Notices go after the response, so a slow
 * or failed email never blocks or undoes a decision. Registered in
 * src/server/capabilities/registry.ts.
 */

const FAILED = "That was not saved. Try again in a minute.";
const LEAVE_PATH = "/app/leave";

function refusal(error: unknown, values?: Record<string, string>): CompanyFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") {
      return { ok: false, status: 403, formError: error.message, values };
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
    "leave.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

async function activeOrganisationId(): Promise<string | null> {
  const session = await getSession();
  return session?.active?.organisationId ?? null;
}

function refresh(requestId?: string): void {
  revalidatePath(LEAVE_PATH);
  if (requestId) revalidatePath(`${LEAVE_PATH}/${requestId}`);
}

/** Step 1: the line manager approves (on to HR) or declines. */
export async function decideLeaveLineManagerAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(decideLineManagerSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  const organisationId = await activeOrganisationId();
  if (organisationId) {
    const id = result.id;
    if (result.status === "pending_hr") {
      after(async () => {
        await notifyWorkerOfLeave(organisationId, id, "line_manager_approved");
        await notifyLeaveDeciders(organisationId, id, "hr");
      });
    } else {
      after(() => notifyWorkerOfLeave(organisationId, id, "line_manager_declined"));
    }
  }
  refresh(result.id);
  return {
    ok: true,
    status: 200,
    message: result.status === "pending_hr" ? "Approved · sent to HR" : "Declined · the worker is told",
  };
}

/** Step 2: HR approves (the balance drops) or declines. */
export async function decideLeaveHrAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(decideHrSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  const organisationId = await activeOrganisationId();
  if (organisationId) {
    const id = result.id;
    const approved = result.status === "approved";
    const balanceAfter = result.balanceAfter;
    const opened = result.openShifts.length;
    after(async () => {
      await notifyWorkerOfLeave(organisationId, id, approved ? "hr_approved" : "hr_declined", {
        balanceAfter,
      });
      // Slice 4.5 (decision 8): ops is told about the shifts the approval opened.
      if (approved && opened > 0) await notifyOpsOfOpenedShifts(organisationId, id);
    });
  }
  refresh(result.id);
  if (result.openShifts.length > 0) revalidatePath("/app/roster");
  return {
    ok: true,
    status: 200,
    message:
      result.status === "approved"
        ? `Approved · ${result.days} ${result.days === 1 ? "day" : "days"} off the balance, ${result.balanceAfter} left${result.openShifts.length > 0 ? ` · ${result.openShifts.length} ${result.openShifts.length === 1 ? "shift" : "shifts"} back to uncovered` : ""}`
        : "Declined · the worker is told",
  };
}

/** HR cancels a live request; approved leave gives its days back. */
export async function cancelLeaveAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(cancelLeaveSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  const organisationId = await activeOrganisationId();
  if (organisationId) {
    const id = result.id;
    const returned = result.returned;
    after(() => notifyWorkerOfLeave(organisationId, id, "cancelled_by_hr", { returned }));
  }
  refresh(result.id);
  return {
    ok: true,
    status: 200,
    message:
      result.returned > 0
        ? `Cancelled · ${result.returned} ${result.returned === 1 ? "day" : "days"} back in the balance`
        : "Cancelled",
  };
}

/** HR adds or takes away days for one worker, type and year, with a reason. */
export async function adjustLeaveBalanceAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(adjustLeaveSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(`${LEAVE_PATH}/balances`);
  return { ok: true, status: 200, message: `Saved · balance now ${result.balance}` };
}
