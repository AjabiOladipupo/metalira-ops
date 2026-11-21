"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatShortDay } from "@/lib/roster";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { teamAssignShiftSpec, teamRemoveAssignmentSpec } from "./team-roster";

/**
 * Server Actions for My team (slice 4.7): a line manager assigns a reportee to an open shift at
 * their team's site, or takes them off one. Each goes through `mutate()` (role, module, Zod), then
 * one SQL function as the user that checks the reportee and the site again. Leave decisions and
 * queries on the page reuse the 4.4 and 4.6 actions. Registered in
 * src/server/capabilities/registry.ts. Logs carry error names only.
 */

const FAILED = "That was not saved. Try again in a minute.";
const TEAM_PATH = "/app/team";

function refusal(error: unknown, values?: Record<string, string>): CompanyFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, status: 403, formError: error.message, values };
    if (error.code === "invalid") {
      const fieldErrors = error.fieldErrors;
      const first = Object.values(fieldErrors)[0];
      return {
        ok: false,
        status: 400,
        formError: first ?? error.message,
        fieldErrors,
        values,
      };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error("team.save_failed:", cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, status: 500, formError: FAILED, values };
}

/**
 * "Assign" on the Assign a shift panel. The open shift comes as `slot` = `<postId>|<date>`; the
 * schema checks both.
 */
export async function assignTeamShiftAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  const [postId = "", date = ""] = (fields.slot ?? "").split("|");
  let result;
  try {
    result = await mutate(teamAssignShiftSpec, { postId, date, workerId: fields.workerId ?? "" });
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(TEAM_PATH);
  revalidatePath("/app/roster");
  const name = (fields.workerName ?? "").slice(0, 100);
  const parts = [name ? `${name} assigned` : "Assigned"];
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) parts.push(formatShortDay(date));
  if (!result.mapped) parts.push("not mapped to this site");
  return { ok: true, status: 200, message: parts.join(" · ") };
}

/** "Take off this shift", with an optional reason. The row stays, marked removed. */
export async function removeTeamShiftAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(teamRemoveAssignmentSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(TEAM_PATH);
  revalidatePath("/app/roster");
  return { ok: true, status: 200, message: "Taken off the shift. It shows as open on the roster." };
}
