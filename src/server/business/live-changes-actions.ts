"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { addPost, cancelRequirementChange, changeRequirement, closePost } from "./live-changes";

/**
 * Server Actions for changes to a live contract (slice 2.8): "Change headcount from", "Add post"
 * and "Close post". Each goes through `mutate()` (role, then Zod, then one SQL function as the
 * user, which checks the role again and writes everything in one transaction). Registered in
 * src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't change live contracts.";
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
    "live_change.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function idOf(fields: Record<string, string>, key: string): string {
  const id = fields[key] ?? "";
  return /^[0-9a-f-]{36}$/i.test(id) ? id : "";
}

function contractBase(fields: Record<string, string>): string | null {
  const clientId = idOf(fields, "clientId");
  const contractId = idOf(fields, "contractId");
  if (!clientId || !contractId) return null;
  return `/app/clients/${clientId}/contracts/${contractId}`;
}

function refresh(fields: Record<string, string>): void {
  const clientId = idOf(fields, "clientId");
  if (clientId) revalidatePath(`/app/clients/${clientId}`, "layout");
  else revalidatePath("/app/clients", "layout");
}

function withDays(formData: FormData) {
  const fields = formFields(formData);
  const days = formData.getAll("days").filter((v): v is string => typeof v === "string");
  return { fields, input: { ...fields, days } };
}

/** "Change headcount from": a new requirement version for one post from a date. */
export async function changeRequirementAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const { fields, input } = withDays(formData);
  let result;
  try {
    result = await changeRequirement(input);
  } catch (error) {
    return refusal(error, fields);
  }
  refresh(fields);
  const base = contractBase(fields);
  if (base) redirect(`${base}/posts/${result.postId}`);
  return { ok: true, status: 200, message: "Saved" };
}

/** "Add post": a new post with its first requirement from a date. */
export async function addPostAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const { fields, input } = withDays(formData);
  let result;
  try {
    result = await addPost(input);
  } catch (error) {
    return refusal(error, fields);
  }
  refresh(fields);
  const base = contractBase(fields);
  if (base) redirect(`${base}/posts/${result.postId}`);
  return { ok: true, status: 200, message: `Added ${result.name}` };
}

/** "Close post": the last day staffed and why. */
export async function closePostAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await closePost(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refresh(fields);
  const base = contractBase(fields);
  if (base) redirect(`${base}/posts/${result.postId}`);
  return { ok: true, status: 200, message: "Saved" };
}

/** "Cancel this change": takes back a requirement change that hasn't started. */
export async function cancelRequirementChangeAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await cancelRequirementChange(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refresh(fields);
  const base = contractBase(fields);
  if (base) redirect(`${base}/posts/${result.postId}`);
  return { ok: true, status: 200, message: "Cancelled" };
}
