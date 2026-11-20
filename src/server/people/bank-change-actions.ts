"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDateTime } from "@/lib/dates";
import type { CompanyFormState as BankFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import type { BankLookupView } from "@/server/billing/bank-lookup";
import { getSession } from "@/server/identity/session";

import {
  notifyApproversOfBankChange,
  notifyWorkerOfBankChangeApproval,
} from "./bank-change-notices";
import { decideBankChange, requestBankChange, withdrawBankChange } from "./bank-changes";
import type { RevealResult } from "./actions";
import { checkWorkerBankDetails, lookupWorkerBankAccount } from "./bank-lookups";
import { echoableValues } from "./form-input";
import { PiiAccessError, PiiRecordNotFoundError, revealPii } from "./pii-access";

/**
 * Server Actions for bank-detail changes (slice 1.7). Each runs through `mutate()`, which checks
 * the caller's role in the active organisation on the server; the database then checks again
 * (RLS, column grants and the trigger that refuses a requester approving their own request).
 * Emails go after the response (`after()`), so a slow or failed send never blocks or undoes the
 * change.
 */

const FAILED = "That was not saved. Try again in a minute.";

function refusal(
  error: unknown,
  forbidden: string,
  values?: Record<string, string>,
): BankFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, status: 403, formError: forbidden, values };
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
  // Names and messages only: never the input, which holds a bank account number.
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "people.bank_change_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

async function activeOrganisationId(): Promise<string | null> {
  const session = await getSession();
  return session?.active?.organisationId ?? null;
}

function refresh(workerId?: string): void {
  revalidatePath("/app/people", "layout");
  if (workerId) revalidatePath(`/app/people/${workerId}`);
}

/** "Change bank details" on an employee: raises a request for a second person to approve. */
export async function requestBankChangeAction(
  _prev: BankFormState,
  formData: FormData,
): Promise<BankFormState> {
  const fields = formFields(formData);
  let raised;
  try {
    raised = await requestBankChange(fields);
  } catch (error) {
    return refusal(
      error,
      "Only an owner, an admin or HR can ask to change bank details.",
      echoableValues(fields),
    );
  }
  const organisationId = await activeOrganisationId();
  if (organisationId) after(() => notifyApproversOfBankChange(organisationId, raised.id));
  refresh(raised.workerId);
  return {
    ok: true,
    status: 200,
    message:
      "Sent for approval. Someone other than you must approve it, then it takes effect 72 hours later.",
  };
}

const DECIDED: Record<string, string> = {
  rejected: "Rejected. The employee's bank details stay as they are.",
  cancelled: "Stopped. The employee's bank details stay as they are.",
};

/** Approve, reject, or stop during the 72-hour hold. Owner, HR and finance only. */
export async function decideBankChangeAction(
  _prev: BankFormState,
  formData: FormData,
): Promise<BankFormState> {
  const fields = formFields(formData);
  let decided;
  try {
    decided = await decideBankChange(fields);
  } catch (error) {
    return refusal(error, "Only an owner, HR or finance can approve bank changes.");
  }
  const organisationId = await activeOrganisationId();
  if (organisationId && decided.status === "approved") {
    after(() => notifyWorkerOfBankChangeApproval(organisationId, decided.id));
  }
  refresh(decided.workerId);
  const message =
    decided.status === "approved" && decided.appliesAfter
      ? `Approved. Payouts use the account ending ${decided.last4} from ${formatDateTime(decided.appliesAfter)}.`
      : (DECIDED[decided.status] ?? "Saved");
  return { ok: true, status: 200, message };
}

/** The requester takes back a request nobody has decided yet. */
export async function withdrawBankChangeAction(
  _prev: BankFormState,
  formData: FormData,
): Promise<BankFormState> {
  const fields = formFields(formData);
  let withdrawn;
  try {
    withdrawn = await withdrawBankChange(fields);
  } catch (error) {
    return refusal(error, "Only the person who raised this request can withdraw it.");
  }
  refresh(withdrawn.workerId);
  return { ok: true, status: 200, message: "Withdrawn. Nothing changed." };
}

const revealInput = z.object({ changeId: z.uuid() });

/**
 * Shows the new account number of a request in full, for roles allowed to see bank account
 * numbers (owner, hr, finance), so an approver can check it against the worker's own letter or
 * statement. Audited by `revealPii` like any other reveal.
 */
export async function revealBankChangeAccount(input: unknown): Promise<RevealResult> {
  const parsed = revealInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That can't be shown." };
  const session = await getSession();
  if (!session) redirect(SIGN_IN_PATH);
  if (!session.active) return { ok: false, message: "Your role can't see this in full." };
  try {
    const value = await revealPii({
      organisationId: session.active.organisationId,
      field: "bank_account",
      entity: "bank_detail_changes",
      entityId: parsed.data.changeId,
    });
    return { ok: true, value };
  } catch (error) {
    if (error instanceof PiiAccessError || error instanceof PiiRecordNotFoundError) {
      return { ok: false, message: error.message };
    }
    console.error("people.reveal_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, message: "This can't be shown right now. Try again in a minute." };
  }
}

/**
 * "Check" in Add employee and Change bank details: the bank's account name for the number, and
 * how it compares with the employee's name (slice 2.3b). Returns a lookup id the form sends.
 */
export async function lookupWorkerBankAccountAction(input: unknown): Promise<BankLookupView> {
  return lookupWorkerBankAccount(input);
}

/**
 * "Check bank details" on the person page: looks the bank details on file up with the bank and
 * keeps the result on the employee (slice 2.3b). The number never leaves the server.
 */
export async function checkWorkerBankDetailsAction(input: unknown): Promise<BankLookupView> {
  const result = await checkWorkerBankDetails(input);
  const workerId =
    typeof input === "object" && input !== null && "workerId" in input
      ? String((input as { workerId: unknown }).workerId)
      : undefined;
  if (result.ok && workerId && z.uuid().safeParse(workerId).success) refresh(workerId);
  return result;
}
