"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { canRequestCompanyBank, canRevealCompanyBank } from "@/lib/company-bank";
import { formatDateTime } from "@/lib/dates";
import { createServerSupabase } from "@/lib/supabase/server";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";
import { PiiAccessError, PiiRecordNotFoundError, revealPii } from "@/server/people/pii-access";

import {
  LOOKUP_MESSAGES,
  loadCompanyNames,
  runBankLookup,
  type BankLookupView,
} from "./bank-lookup";
import { decideCompanyBank, requestCompanyBank, withdrawCompanyBank } from "./company-bank";
import { sendCompanyBankNotices } from "./company-bank-notices";
import { lookupBankAccountSchema } from "./schemas";

/**
 * Server Actions for the company bank account (slice 2.3). Each runs through `mutate()`, which
 * checks the caller's role in the active organisation with the verified session; the database
 * then checks again (RLS, column grants, and the trigger that refuses a requester deciding their
 * own request). Emails go after the response (`after()`), so a slow or failed send never blocks
 * or undoes the change. Nothing here logs input: it holds an account number.
 */

const FAILED = "That was not saved. Try again in a minute.";

function refusal(
  error: unknown,
  forbidden: string,
  values?: Record<string, string>,
): CompanyFormState {
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
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "billing.company_bank_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function refresh(): void {
  revalidatePath("/app/settings/bank-account");
  revalidatePath("/app/settings/company");
  revalidatePath("/app/setup/invoices");
}

/** Refills the form after a refusal, never with the account number. */
function echo(fields: Record<string, string>): Record<string, string> {
  const { bankCode = "", reason = "", nameCheckReason = "" } = fields;
  return { bankCode, reason, nameCheckReason };
}

/**
 * "Check" on the company account form: asks the bank network for the account name and compares
 * it with the company's legal and trading names (slice 2.3b). Owner, admin and finance. Returns
 * the name and a lookup id the form sends with the request; the account number is never echoed.
 */
export async function lookupCompanyBankAccountAction(input: unknown): Promise<BankLookupView> {
  const parsed = lookupBankAccountSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] === "bankCode" ? "bankCode" : "bankAccountNumber";
    return { ok: false, message: issue?.message ?? "Check the bank and account number.", field };
  }
  const session = await getSession();
  if (!session) redirect(SIGN_IN_PATH);
  if (!session.active || !canRequestCompanyBank(session.active.role)) {
    return {
      ok: false,
      message: "Only an owner, an admin or finance can change the company bank account.",
    };
  }
  const organisationId = session.active.organisationId;
  try {
    const supabase = await createServerSupabase();
    return await runBankLookup({
      organisationId,
      userId: session.user.id,
      purpose: "company_bank",
      workerId: null,
      bankCode: parsed.data.bankCode,
      accountNumber: parsed.data.bankAccountNumber,
      expected: await loadCompanyNames(supabase, organisationId),
    });
  } catch (error) {
    console.error("billing.bank_lookup_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, message: LOOKUP_MESSAGES.failed };
  }
}

/** "Add account" / "Change account": raises a request (or adds the first account during setup). */
export async function requestCompanyBankAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let raised;
  try {
    raised = await requestCompanyBank(fields);
  } catch (error) {
    return refusal(
      error,
      "Only an owner, an admin or finance can ask to change the company bank account.",
      echo(fields),
    );
  }
  // Emails are a sweep over the rows (requests made outside the app are announced too).
  after(() => sendCompanyBankNotices(raised.organisationId));
  refresh();
  return {
    ok: true,
    status: 200,
    message:
      raised.status === "active"
        ? `Added. Clients pay into the account ending ${raised.last4}.`
        : "Sent for approval. An owner or finance user other than you must approve it, then it takes effect 72 hours later.",
  };
}

const DECIDED: Record<string, string> = {
  rejected: "Rejected. Clients keep paying into the current account.",
  cancelled: "Stopped. Clients keep paying into the current account.",
};

/** Approve, reject, or stop during the 72-hour hold. Owner and finance only. */
export async function decideCompanyBankAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let decided;
  try {
    decided = await decideCompanyBank(fields);
  } catch (error) {
    return refusal(error, "Only an owner or finance can approve the company bank account.");
  }
  after(() => sendCompanyBankNotices(decided.organisationId));
  refresh();
  const message =
    decided.status === "approved" && decided.appliesAfter
      ? `Approved. Invoices show the account ending ${decided.last4} from ${formatDateTime(decided.appliesAfter)}.`
      : (DECIDED[decided.status] ?? "Saved");
  return { ok: true, status: 200, message };
}

/** The requester takes back a request nobody has decided yet. */
export async function withdrawCompanyBankAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await withdrawCompanyBank(fields);
  } catch (error) {
    return refusal(error, "Only the person who raised this request can withdraw it.");
  }
  refresh();
  return { ok: true, status: 200, message: "Withdrawn. Nothing changed." };
}

export type CompanyBankRevealResult =
  { ok: true; value: string | null } | { ok: false; message: string };

const revealInput = z.object({ accountId: z.uuid() });

/**
 * Shows a company bank account number in full, to owner and finance only, so they can check it
 * against the bank's own letter. Audited as `pii.reveal` by `revealPii`, before the value is
 * returned.
 */
export async function revealCompanyBankAccount(input: unknown): Promise<CompanyBankRevealResult> {
  const parsed = revealInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That can't be shown." };
  const session = await getSession();
  if (!session) redirect(SIGN_IN_PATH);
  if (!session.active || !canRevealCompanyBank(session.active.role)) {
    return { ok: false, message: "Your role can't see this in full." };
  }
  try {
    const value = await revealPii({
      organisationId: session.active.organisationId,
      field: "bank_account",
      entity: "organisation_bank_accounts",
      entityId: parsed.data.accountId,
    });
    return { ok: true, value };
  } catch (error) {
    if (error instanceof PiiAccessError || error instanceof PiiRecordNotFoundError) {
      return { ok: false, message: error.message };
    }
    console.error("billing.reveal_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, message: "This can't be shown right now. Try again in a minute." };
  }
}
