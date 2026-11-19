"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState as HeadcountFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { addHeadcount, removeHeadcount, updateHeadcount } from "./headcount";

/**
 * Server Actions for a draft contract's headcount (slice 2.5). Each goes through a helper that
 * runs `mutate()`: the caller's role is checked on the server, the input is validated with Zod,
 * and the write uses the caller's own client (RLS, and the database refuses any change once the
 * contract is live). Every action is registered in src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't change headcount.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): HeadcountFormState {
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
    "headcount.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

/** The form's fields, with the ticked days as a list. */
function rowInput(formData: FormData) {
  const fields = formFields(formData);
  const days = formData.getAll("days").filter((v): v is string => typeof v === "string");
  return { fields, input: { ...fields, days } };
}

/** A client id from a hidden field, only when it looks like one (it builds the redirect). */
function idOf(fields: Record<string, string>, key: string): string {
  const id = fields[key] ?? "";
  return /^[0-9a-f-]{36}$/i.test(id) ? id : "";
}

function done(fields: Record<string, string>): never {
  const clientId = idOf(fields, "clientId");
  const contractId = idOf(fields, "contractId");
  revalidatePath("/app/clients", "layout");
  if (!clientId || !contractId) redirect("/app/clients");
  revalidatePath(`/app/clients/${clientId}`, "layout");
  redirect(`/app/clients/${clientId}/contracts/${contractId}?tab=headcount`);
}

export async function addHeadcountAction(
  _prev: HeadcountFormState,
  formData: FormData,
): Promise<HeadcountFormState> {
  const { fields, input } = rowInput(formData);
  try {
    await addHeadcount(input);
  } catch (error) {
    return refusal(error, fields);
  }
  done(fields);
}

export async function updateHeadcountAction(
  _prev: HeadcountFormState,
  formData: FormData,
): Promise<HeadcountFormState> {
  const { fields, input } = rowInput(formData);
  try {
    await updateHeadcount(input);
  } catch (error) {
    return refusal(error, fields);
  }
  done(fields);
}

export async function removeHeadcountAction(
  _prev: HeadcountFormState,
  formData: FormData,
): Promise<HeadcountFormState> {
  const fields = formFields(formData);
  try {
    await removeHeadcount(fields);
  } catch (error) {
    return refusal(error);
  }
  done(fields);
}
