"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";

import { saveAttendanceSpec } from "./attendance-settings";
import type { CompanyFormState } from "./company-form-state";
import { MutationError, mutate } from "./mutate";
import { formFields } from "./schemas";

const FORBIDDEN = "Only an owner or an admin can change company settings.";
const FAILED = "That was not saved. Try again in a minute.";

/** Settings -> Company -> Attendance: save the grace period and the no-show time. */
export async function saveAttendance(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const values = formFields(formData);
  try {
    await mutate(saveAttendanceSpec, values);
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
      if (error.code === "forbidden") {
        return { ok: false, status: 403, formError: FORBIDDEN, values };
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
    console.error(
      "company.attendance_save_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return { ok: false, status: 500, formError: FAILED, values };
  }
  revalidatePath("/app/settings/company");
  return { ok: true, status: 200, message: "Saved" };
}
