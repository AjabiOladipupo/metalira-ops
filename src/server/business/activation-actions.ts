"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { getSession } from "@/server/identity/session";
import { formFields } from "@/server/identity/schemas";

import {
  activateContract,
  endContract,
  loadWelcomePayload,
  sendContractWelcome,
} from "./activation";

/**
 * Server Actions for activating and ending a contract (slice 2.7). Each goes through `mutate()`:
 * the caller's role is checked on the server, the input is validated with Zod, and the SQL
 * function checks the role again and writes everything in one transaction. The welcome email
 * goes after the response (`after()`), only on the call that activated. Both are registered in
 * src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't activate or end contracts.";
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
    "activation.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function idOf(fields: Record<string, string>, key: string): string {
  const id = fields[key] ?? "";
  return /^[0-9a-f-]{36}$/i.test(id) ? id : "";
}

function contractPath(fields: Record<string, string>, tab?: string): string | null {
  const clientId = idOf(fields, "clientId");
  const contractId = idOf(fields, "contractId");
  if (!clientId || !contractId) return null;
  return `/app/clients/${clientId}/contracts/${contractId}${tab ? `?tab=${tab}` : ""}`;
}

function refresh(fields: Record<string, string>): void {
  revalidatePath("/app/clients", "layout");
  const clientId = idOf(fields, "clientId");
  if (clientId) revalidatePath(`/app/clients/${clientId}`, "layout");
}

/** "Activate contract": checklist in the database, then posts and requirements. */
export async function activateContractAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await activateContract(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  if (result.sendWelcome) {
    // Read with the user's own client now; send after the response.
    const session = await getSession();
    const organisationId = session?.active?.organisationId;
    if (organisationId) {
      const supabase = await createServerSupabase();
      const payload = await loadWelcomePayload(supabase, organisationId, result.contractId);
      if (payload) after(() => sendContractWelcome(supabase, payload));
    }
  }
  refresh(fields);
  const path = contractPath(fields, "posts");
  if (path) redirect(path);
  return {
    ok: true,
    status: 200,
    message: `Live. ${result.posts} posts from ${result.goLiveDate ?? "the go-live date"}.`,
  };
}

/** "End contract": closes posts, requirements and rates on the last day of service. */
export async function endContractAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await endContract(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refresh(fields);
  const path = contractPath(fields, "posts");
  if (path) redirect(path);
  return { ok: true, status: 200, message: "Saved" };
}
