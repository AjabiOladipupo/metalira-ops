import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { workerMessages } from "@/lib/messages/worker";
import {
  CHANGE_REQUEST_MAX,
  CHANGE_REQUEST_MIN,
  MAX_OWN_BANK_CHANGES_PER_DAY,
  WORKER_CHANGE_TOPICS,
  hasPersonalNumber,
  isPlainRequestText,
  normaliseRequestText,
  type WorkerChangeTopic,
} from "@/lib/worker-requests";
import { isKnownBankCode } from "@/lib/banks";
import { createServerSupabase } from "@/lib/supabase/server";
import { nameCheckReasonSchema } from "@/server/billing/bank-check-schema";
import { runBankLookup, takeCheckedName, type BankLookupView } from "@/server/billing/bank-lookup";
import { sealPii } from "@/server/crypto/pii";
import { MutationError } from "@/server/identity/mutate";
import { lookupWorkerSession } from "@/server/identity/worker-session";
import type { Database } from "@/types/db";

import { bankAccountContext, checkedColumns } from "./bank-changes";

/**
 * "Request a change" from the worker app (slice 1.10). The worker writes with their own session
 * (publishable key + RLS); the database decides what they may do:
 *
 * - Bank details become a bank_detail_changes request (slice 1.7): a second person approves it
 *   and it applies 72 hours later. The worker is the requester, so they can never approve it.
 *   The account number is encrypted here for `workers.bank_account_enc` of the worker, as when
 *   HR raises one, and only its last four digits are stored in clear.
 * - Anything else becomes a worker_change_requests row HR sees on the worker page. Its text is
 *   refused if it holds a long number, so personal numbers never reach the table or the audit
 *   log in clear.
 *
 * The worker id and organisation come from the session, never from the form. Messages come
 * from the worker messages module (owner decision 16).
 */

type Client = SupabaseClient<Database>;

const copy = workerMessages.change;

/** The signed-in worker's own client and record. */
export interface OwnContext {
  supabase: Client;
  organisationId: string;
  workerId: string;
  /** The worker's login (for the account name lookup's limits). */
  userId: string;
  firstName: string;
  lastName: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const digitsOnly = (value: string) => value.replace(/[\s-]/g, "");
const NO_CONTROL = /^[^\p{Cc}<>]*$/u;

const accountNumber = () =>
  z
    .string(copy.accountNumberInvalid)
    .trim()
    .transform(digitsOnly)
    .pipe(z.string().regex(/^\d{10}$/, copy.accountNumberInvalid));

/** The bank's account name is not an input: it comes from the worker's own lookup (2.3b). */
export const ownBankChangeSchema = z.object({
  bankCode: z.string(copy.bankRequired).trim().refine(isKnownBankCode, copy.bankRequired),
  bankLookupId: z.uuid(copy.checkFirst),
  nameCheckReason: nameCheckReasonSchema,
  bankAccountNumber: accountNumber(),
  reason: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(500, copy.tooLong(500)).regex(NO_CONTROL, copy.plainText).optional(),
  ),
});

export const ownBankLookupSchema = z.object({
  bankCode: z.string(copy.bankRequired).trim().refine(isKnownBankCode, copy.bankRequired),
  bankAccountNumber: accountNumber(),
});

export const ownChangeRequestSchema = z.object({
  topic: z.enum(WORKER_CHANGE_TOPICS as [WorkerChangeTopic, ...WorkerChangeTopic[]], {
    error: copy.topicRequired,
  }),
  details: z
    .string(copy.detailsRequired)
    .transform(normaliseRequestText)
    .pipe(
      z
        .string()
        .min(1, copy.detailsRequired)
        .min(CHANGE_REQUEST_MIN, copy.detailsShort)
        .max(CHANGE_REQUEST_MAX, copy.detailsLong)
        .refine(isPlainRequestText, copy.plainText)
        .refine((value) => !hasPersonalNumber(value), copy.detailsNumbers),
    ),
});

function invalid(error: z.ZodError): MutationError {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return new MutationError("invalid", "", fieldErrors);
}

/** The database's refusals, in the worker's words; anything else is a failure. */
function fromDbError(error: PostgrestError, field: string): never {
  const text = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", copy.failed);
    case "MLBL3":
    case "MLBL4":
    case "MLBL5":
    case "MLBL6":
      throw new MutationError("invalid", "", { bankAccountNumber: copy.checkAgain });
    case "MLBK5":
    case "MLCR1":
      throw new MutationError("invalid", copy.left);
    case "MLCR2":
      throw new MutationError("invalid", copy.tooMany);
    case "MLBK7":
      throw new MutationError("invalid", copy.bankTooOften(MAX_OWN_BANK_CHANGES_PER_DAY));
    case "23514":
      // A check constraint: the text rules above should have caught it first.
      throw new MutationError("invalid", "", { [field]: copy.detailsNumbers });
    case "23505":
      if (text.includes("bank_detail_changes_one_open_key")) {
        throw new MutationError("invalid", copy.bankWaiting);
      }
      break;
  }
  throw new Error(`Database refused the request (${error.code})`);
}

// ---------------------------------------------------------------------------
// Raise
// ---------------------------------------------------------------------------

/** Raises a bank-detail change for the worker themselves. Nothing changes until HR approves. */
export async function runOwnBankChange(ctx: OwnContext, input: unknown): Promise<{ id: string }> {
  const parsed = ownBankChangeSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const data = parsed.data;
  const checked = await takeCheckedName(ctx.supabase, {
    organisationId: ctx.organisationId,
    lookupId: data.bankLookupId,
    purpose: "worker_bank",
    workerId: ctx.workerId,
    bankCode: data.bankCode,
    accountNumber: data.bankAccountNumber,
    expected: { kind: "person", firstName: ctx.firstName, lastName: ctx.lastName },
    reason: data.nameCheckReason,
  });
  const sealed = sealPii(
    data.bankAccountNumber,
    bankAccountContext(ctx.organisationId, ctx.workerId),
  );
  if (!sealed.last4)
    throw new MutationError("invalid", "", {
      bankAccountNumber: copy.accountNumberInvalid,
    });
  const { data: row, error } = await ctx.supabase
    .from("bank_detail_changes")
    .insert({
      organisation_id: ctx.organisationId,
      worker_id: ctx.workerId,
      ...checkedColumns(checked, data.bankLookupId),
      bank_account_enc: sealed.enc,
      bank_account_last4: sealed.last4,
      reason: data.reason ?? null,
    })
    .select("id")
    .single();
  if (error) fromDbError(error, "bankAccountNumber");
  return { id: row.id };
}

/** Sends HR a request to change something on the worker's own record. */
export async function runOwnChangeRequest(
  ctx: OwnContext,
  input: unknown,
): Promise<{ id: string }> {
  const parsed = ownChangeRequestSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  const { data: row, error } = await ctx.supabase
    .from("worker_change_requests")
    .insert({
      organisation_id: ctx.organisationId,
      worker_id: ctx.workerId,
      topic: parsed.data.topic,
      details: parsed.data.details,
    })
    .select("id")
    .single();
  if (error) fromDbError(error, "details");
  return { id: row.id };
}

/**
 * The signed-in worker's context, or a MutationError: "unauthenticated" when signed out (or
 * signed in as a manager), "forbidden" when the login has no worker record linked.
 */
export async function ownContext(): Promise<OwnContext> {
  const lookup = await lookupWorkerSession();
  if (lookup.type === "signed_out" || lookup.type === "not_worker") {
    throw new MutationError("unauthenticated", copy.failed);
  }
  if (lookup.type === "unlinked") throw new MutationError("forbidden", copy.failed);
  return {
    supabase: await createServerSupabase({ channel: "worker_app" }),
    organisationId: lookup.session.organisationId,
    workerId: lookup.session.workerId,
    userId: lookup.session.userId,
    firstName: lookup.session.firstName,
    lastName: lookup.session.lastName,
  };
}

/** "Check" on the worker's own bank form: the bank's name for the account, against theirs. */
export async function runOwnBankLookup(ctx: OwnContext, input: unknown): Promise<BankLookupView> {
  const parsed = ownBankLookupSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    return {
      ok: false,
      message: issue?.message ?? copy.accountNumberInvalid,
      ...(key === "bankCode" || key === "bankAccountNumber" ? { field: key } : {}),
    };
  }
  return runBankLookup({
    organisationId: ctx.organisationId,
    userId: ctx.userId,
    purpose: "worker_bank",
    workerId: ctx.workerId,
    bankCode: parsed.data.bankCode,
    accountNumber: parsed.data.bankAccountNumber,
    expected: { kind: "person", firstName: ctx.firstName, lastName: ctx.lastName },
  });
}
