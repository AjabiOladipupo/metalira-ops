"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDate } from "@/lib/dates";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  addEntitlementVersionSpec,
  addHolidaySpec,
  applyPresetSpec,
  copyHolidaysSpec,
  createLeaveTypeSpec,
  removeHolidaySpec,
  saveLeaveTypeSpec,
  setWorkWeekSpec,
} from "./leave-setup";

/**
 * Server Actions for Settings > Leave and Settings > Holidays (slice 4.1). Each goes through
 * `mutate()` (role, then Zod, then one SQL function as the user, which checks the role again).
 * Registered in src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Only an owner, an admin or HR can change leave settings.";
const FAILED = "That was not saved. Try again in a minute.";

const LEAVE_PATH = "/app/settings/leave";
const HOLIDAYS_PATH = "/app/settings/holidays";

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
    "leave_setup.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function holidaysYearPath(year: string | number | undefined): string {
  const y = String(year ?? "");
  return /^\d{4}$/.test(y) ? `${HOLIDAYS_PATH}?year=${y}` : HOLIDAYS_PATH;
}

/** Adds a public holiday ("Independence Day, 1 Oct 2026"). */
export async function addHolidayAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(addHolidaySpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(HOLIDAYS_PATH);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? "") ? formatDate(fields.date!) : "";
  return { ok: true, status: 200, message: date ? `Added · ${date}` : "Added" };
}

/** Removes a public holiday. The row is kept, marked removed. */
export async function removeHolidayAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(removeHolidaySpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(HOLIDAYS_PATH);
  return { ok: true, status: 200, message: "Removed" };
}

/** Copies last year's holidays into this year, after the preview on /app/settings/holidays/copy. */
export async function copyHolidaysAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(copyHolidaysSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(HOLIDAYS_PATH);
  redirect(holidaysYearPath(fields.toYear));
}

/** Sets the company's working week. */
export async function setWorkWeekAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(setWorkWeekSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(HOLIDAYS_PATH);
  return { ok: true, status: 200, message: "Saved" };
}

/** Adds a leave type of the company's own, with its days a year from 1 January. */
export async function createLeaveTypeAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(createLeaveTypeSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(LEAVE_PATH);
  redirect(LEAVE_PATH);
}

/** Changes a leave type's details (name, counting, paid, certificate, service, status). */
export async function saveLeaveTypeAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(saveLeaveTypeSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(LEAVE_PATH);
  return { ok: true, status: 200, message: "Saved" };
}

/** Changes a type's days a year, carry-over or pay from tomorrow or the next 1 January. */
export async function addEntitlementVersionAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(addEntitlementVersionSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(LEAVE_PATH);
  if (result.unchanged) return { ok: true, status: 200, message: "Nothing changed" };
  return {
    ok: true,
    status: 200,
    message: `Saved · ${result.after.daysPerYear} days a year from ${formatDate(result.effectiveFrom)}`,
  };
}

/** Applies preset A or B after the preview on /app/settings/leave/preset/[preset]. */
export async function applyPresetAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(applyPresetSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(LEAVE_PATH);
  redirect(`${LEAVE_PATH}?applied=${result.preset}`);
}
