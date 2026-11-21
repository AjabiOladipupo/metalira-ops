"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatMinutes } from "@/lib/timesheets/minutes";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { addCorrectionSpec, previewCorrectionSpec } from "./timesheets";

/**
 * Server Actions for timesheets (slice 4.2). A correction goes through `mutate()` (role, then
 * Zod, then one SQL function as the user, which checks the caller again and refuses their own
 * line). Registered in src/server/capabilities/registry.ts. On /app/timesheets ("Adjust hours",
 * slice 4.3) it runs in two steps: the first submit returns the preview (minutes now against
 * after, nothing saved); the second, with `confirm=1`, saves the correction and tells the worker.
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

function minutesText(worked: number, ot: number): string {
  return ot > 0
    ? `${formatMinutes(worked)} worked, ${formatMinutes(ot)} overtime`
    : `${formatMinutes(worked)} worked`;
}

/**
 * Corrects one day with a reason ("Adjust hours"): a new correction row; the punches never
 * change. Without `confirm=1` it only previews (values.confirm is "ready" when the preview
 * passed every check, so the screen offers Save).
 */
export async function addTimesheetCorrectionAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  if (fields.confirm !== "1") {
    try {
      const preview = await mutate(previewCorrectionSpec, fields);
      return {
        ok: true,
        status: 200,
        message: `Now ${minutesText(preview.current.workedMinutes, preview.current.otMinutes)}. After: ${minutesText(preview.next.workedMinutes, preview.next.otMinutes)}.`,
        values: { ...fields, confirm: "ready" },
      };
    } catch (error) {
      return refusal(error, fields);
    }
  }
  let result;
  try {
    result = await mutate(addCorrectionSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath("/app/timesheets");
  return {
    ok: true,
    status: 200,
    message: `Corrected · ${minutesText(result.workedMinutes, result.otMinutes)}`,
  };
}
