"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatShortDay } from "@/lib/roster";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { assignShiftSpec, copyLastWeekSpec, removeAssignmentSpec } from "./roster";

/**
 * Server Actions for the roster (slice 3.2): assign a worker to a post-day, take them off, and
 * copy last week's roster after its preview. Each goes through `mutate()` (role, then Zod, then
 * one SQL function as the user, which checks the role again). Registered in
 * src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't change rosters.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): CompanyFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, status: 403, formError: FORBIDDEN, values };
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
    "roster.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function rosterPath(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  const site = fields.siteId ?? "";
  const week = fields.weekStart ?? "";
  if (/^[0-9a-f-]{36}$/i.test(site)) params.set("site", site);
  if (/^\d{4}-\d{2}-\d{2}$/.test(week)) params.set("week", week);
  const query = params.toString();
  return query ? `/app/roster?${query}` : "/app/roster";
}

/** Assigns one worker to a post on a day ("Assign Musa"). */
export async function assignShiftAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await mutate(assignShiftSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath("/app/roster");
  const name = (fields.workerName ?? "").slice(0, 100);
  const parts = [name ? `${name} assigned` : "Assigned"];
  if (/^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? "")) parts.push(formatShortDay(fields.date!));
  if (!result.mapped) parts.push("not mapped to this site");
  return { ok: true, status: 200, message: parts.join(" · ") };
}

/** Takes a worker off a shift, with an optional reason. The row stays, marked removed. */
export async function removeAssignmentAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(removeAssignmentSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath("/app/roster");
  return { ok: true, status: 200, message: "Removed from the shift" };
}

/** Copies last week's assignments into this week, after the preview on /app/roster/copy. */
export async function copyLastWeekAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(copyLastWeekSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath("/app/roster");
  redirect(rosterPath(fields));
}
