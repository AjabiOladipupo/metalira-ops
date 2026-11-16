"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import type { CompanyFormState as RequestFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { notifyApproversOfBankChange } from "./bank-change-notices";
import { ownContext, runOwnBankChange, runOwnChangeRequest } from "./own-requests";

/**
 * Server Actions behind "Request a change" in the worker app (slice 1.10). The worker's own
 * session does the writing (own-requests.ts); RLS and the triggers decide what is allowed.
 * Approvers hear about a bank change by email after the response (`after()`), as when HR
 * raises one. Logs carry error names only, never what was typed: it may hold an account number.
 */

const copy = workerMessages.change;

function refusal(error: unknown, values?: Record<string, string>): RequestFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
    if (error.code === "forbidden") {
      return { ok: false, status: 403, formError: copy.failed, values };
    }
    if (error.code === "invalid") {
      return {
        ok: false,
        status: 400,
        formError: error.message || undefined,
        fieldErrors: error.fieldErrors,
        values,
      };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "people.own_request_failed:",
    cause instanceof Error ? cause.name : "unknown error",
  );
  return { ok: false, status: 500, formError: copy.failed, values };
}

function refresh(): void {
  revalidatePath("/m/me");
  revalidatePath("/app/people", "layout");
}

/** Bank details: raises a bank-detail change for HR to approve. */
export async function requestOwnBankChangeAction(
  _prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const fields = formFields(formData);
  // Never echo the account number back to the browser.
  const values = {
    bankName: fields.bankName ?? "",
    accountName: fields.accountName ?? "",
    reason: fields.reason ?? "",
  };
  let raised: { id: string };
  let organisationId: string;
  try {
    const ctx = await ownContext();
    organisationId = ctx.organisationId;
    raised = await runOwnBankChange(ctx, fields);
  } catch (error) {
    return refusal(error, values);
  }
  after(() => notifyApproversOfBankChange(organisationId, raised.id));
  refresh();
  return { ok: true, status: 200, message: copy.bankSent };
}

/** Anything else: a request HR sees on the worker page. */
export async function requestOwnChangeAction(
  _prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const fields = formFields(formData);
  const values = { topic: fields.topic ?? "", details: fields.details ?? "" };
  try {
    await runOwnChangeRequest(await ownContext(), fields);
  } catch (error) {
    return refusal(error, values);
  }
  refresh();
  return { ok: true, status: 200, message: copy.sent };
}
