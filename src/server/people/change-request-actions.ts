"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState as ResolveFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { resolveChangeRequest } from "./change-requests";

/** Marks a worker's change request done or declined (slice 1.10). Owner, admin and hr only. */
export async function resolveChangeRequestAction(
  _prev: ResolveFormState,
  formData: FormData,
): Promise<ResolveFormState> {
  const fields = formFields(formData);
  let resolved;
  try {
    resolved = await resolveChangeRequest(fields);
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
      if (error.code === "forbidden") {
        return {
          ok: false,
          status: 403,
          formError: "Only the owner, an admin or HR can deal with change requests.",
        };
      }
      if (error.code === "invalid") {
        return {
          ok: false,
          status: 400,
          formError: error.fieldErrors.note ?? error.message,
          fieldErrors: error.fieldErrors,
        };
      }
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error(
      "people.change_request_failed:",
      cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
    );
    return { ok: false, status: 500, formError: "That was not saved. Try again in a minute." };
  }
  revalidatePath(`/app/people/${resolved.workerId}`);
  revalidatePath("/m/me");
  return {
    ok: true,
    status: 200,
    message:
      resolved.status === "done"
        ? "Marked done. The employee sees it on their profile."
        : "Declined. The employee sees your note on their profile.",
  };
}
