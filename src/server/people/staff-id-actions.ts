"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDateTime } from "@/lib/dates";
import type { CompanyFormState as FormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";

import { unlockSignIn } from "./sign-in-status";
import {
  decideStaffIdCorrection,
  requestStaffIdCorrection,
  withdrawStaffIdCorrection,
} from "./staff-id-corrections";
import {
  notifyApproversOfStaffIdCorrection,
  notifyWorkerOfStaffIdChange,
} from "./staff-id-notices";

/**
 * Server Actions for slice 1.11: staff ID corrections and "Unlock sign-in" on a worker's page.
 * Each goes through `mutate()` (role in the active organisation, Zod), and the database checks
 * again and writes the audit rows in the same transaction. The approvers' email goes after the
 * response (`after()`), so a slow or failed send never blocks or undoes the correction.
 */

const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, forbidden: string, values?: Record<string, string>): FormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, status: 403, formError: forbidden, values };
    if (error.code === "invalid") {
      const fieldErrors = error.fieldErrors;
      // A message shown on a field isn't repeated above the button.
      const onField = Object.values(fieldErrors).includes(error.message);
      return {
        ok: false,
        status: 400,
        formError: onField ? undefined : error.message,
        fieldErrors,
        values,
      };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "people.slice_1_11_action_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function refresh(workerId: string): void {
  revalidatePath("/app/people", "layout");
  revalidatePath(`/app/people/${workerId}`);
}

/** "Correct staff ID" on an employee: raises a correction for a second person to approve. */
export async function requestStaffIdCorrectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const fields = formFields(formData);
  const values = { newStaffId: fields.newStaffId ?? "", reason: fields.reason ?? "" };
  let raised;
  try {
    raised = await requestStaffIdCorrection(fields);
  } catch (error) {
    return refusal(error, "Only the owner, an admin or HR can correct a staff ID.", values);
  }
  const session = await getSession();
  const organisationId = session?.active?.organisationId;
  if (organisationId) {
    after(() => notifyApproversOfStaffIdCorrection(organisationId, raised.id));
  }
  refresh(raised.workerId);
  return {
    ok: true,
    status: 200,
    message: `Sent for approval. ${raised.oldStaffId} becomes ${raised.newStaffId} once someone other than you approves it.`,
  };
}

/** Approve or reject a correction someone else raised. */
export async function decideStaffIdCorrectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let decided;
  try {
    decided = await decideStaffIdCorrection(formFields(formData));
  } catch (error) {
    return refusal(error, "Only the owner, an admin or HR can decide staff ID corrections.");
  }
  if (decided.status === "approved") {
    const session = await getSession();
    const organisationId = session?.active?.organisationId;
    if (organisationId) after(() => notifyWorkerOfStaffIdChange(organisationId, decided.id));
  }
  refresh(decided.workerId);
  return {
    ok: true,
    status: 200,
    message:
      decided.status === "approved"
        ? `Approved. The staff ID is now ${decided.newStaffId}; ${decided.oldStaffId} can't be used again.`
        : `Rejected. The staff ID stays ${decided.oldStaffId}.`,
  };
}

/** The requester takes back a correction nobody has decided. */
export async function withdrawStaffIdCorrectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let withdrawn;
  try {
    withdrawn = await withdrawStaffIdCorrection(formFields(formData));
  } catch (error) {
    return refusal(error, "Only the person who raised this correction can withdraw it.");
  }
  refresh(withdrawn.workerId);
  return { ok: true, status: 200, message: "Withdrawn. Nothing changed." };
}

/** "Unlock sign-in": lifts a 15-minute PIN lock early. Audited by the database. */
export async function unlockSignInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let unlocked;
  try {
    unlocked = await unlockSignIn(formFields(formData));
  } catch (error) {
    return refusal(
      error,
      "Only the owner, an admin, HR or the employee's line manager can unlock sign-in.",
    );
  }
  refresh(unlocked.workerId);
  return {
    ok: true,
    status: 200,
    message: `Unlocked at ${formatDateTime(new Date().toISOString())}. They can sign in with their PIN now.`,
  };
}
