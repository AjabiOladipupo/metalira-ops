"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatMinutes } from "@/lib/timesheets/minutes";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { addCorrectionSpec } from "./timesheets";

/**
 * Server Actions for timesheets (slice 4.2). A correction goes through `mutate()` (role, then
 * Zod, then one SQL function as the user, which checks the caller again and refuses their own
 * line). Registered in src/server/capabilities/registry.ts. Slice 4.3 puts it on /app/timesheets
 * ("Adjust hours").
 */

const FORBIDDEN = "Your role can't correct this timesheet.";
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
  console.error("timesheets.save_failed:", cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, status: 500, formError: FAILED, values };
}

/** Corrects one day with a reason ("Adjust hours"): a new correction row; the punches never change. */
export async function addTimesheetCorrectionAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(addCorrectionSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath("/app/timesheets");
  const parts = [`Corrected · ${formatMinutes(result.workedMinutes)} worked`];
  if (result.otMinutes > 0) parts.push(`${formatMinutes(result.otMinutes)} overtime`);
  return { ok: true, status: 200, message: parts.join(" · ") };
}
