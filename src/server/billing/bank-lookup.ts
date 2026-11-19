import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  NEAR_REASON_MIN,
  matchCompanyName,
  matchPersonName,
  type NameMatch,
} from "@/lib/bank-name-match";
import { bankByCode } from "@/lib/banks";
import {
  createTestBankAccountResolver,
  getBankAccountResolver,
  type BankAccountResolver,
  type ResolveBankAccountError,
} from "@/lib/payments";
import { derivePiiSubkey } from "@/server/crypto/pii";
import { MutationError } from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * Account name lookup (slice 2.3b): the user picks a bank and types the account number; the
 * server asks the bank network for the account name with Metalira's own provider account
 * (src/lib/payments) and records the lookup (public.bank_account_lookups, migration
 * 20261119115000). Requests then name the lookup, and the database takes the account name from
 * it, so a user can't send a name of their own.
 *
 * - Provider settings are server env read only here: MONNIFY_API_KEY, MONNIFY_SECRET_KEY,
 *   MONNIFY_CONTRACT_CODE (kept with the others; the lookup doesn't need it) and
 *   MONNIFY_BASE_URL (sandbox or live host; defaults to live in production, sandbox elsewhere).
 * - Without keys: the deterministic test resolver outside production (labelled "Test lookup"),
 *   and a clear refusal in production.
 * - Limits: 30 lookups an hour per user and 100 per company (the database counts, under a lock).
 * - Never logged: the account number, the returned name, a provider response. Errors are logged
 *   by kind only.
 * - The account number is stored only as an HMAC digest keyed from the personal data key and
 *   bound to the company and bank code (`bankAccountDigest`), plus its last four digits.
 */

type Client = SupabaseClient<Database>;

export type BankLookupPurpose = Database["public"]["Enums"]["bank_lookup_purpose"];

export type ExpectedNames =
  | { kind: "company"; names: readonly (string | null | undefined)[] }
  | { kind: "person"; firstName: string; lastName: string };

/** How long a lookup can back a request. The database checks the same. */
export const LOOKUP_VALID_MINUTES = 30;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SANDBOX = "https://sandbox.monnify.com";
const LIVE = "https://api.monnify.com";

/** Vercel production, or a production Node build outside Vercel unless tests ask otherwise. */
export function isProductionLookupEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "production";
  // A local production build (Playwright runs one) may opt into the test resolver explicitly.
  if (env.METALIRA_TEST_BANK_LOOKUP === "1") return false;
  return env.NODE_ENV === "production";
}

export type LookupMode =
  | { mode: "provider"; apiKey: string; secretKey: string; baseUrl: string }
  | { mode: "test" }
  | { mode: "off" };

export function lookupMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LookupMode {
  const apiKey = env.MONNIFY_API_KEY?.trim() ?? "";
  const secretKey = env.MONNIFY_SECRET_KEY?.trim() ?? "";
  const production = isProductionLookupEnv(env);
  if (apiKey && secretKey) {
    const configured = env.MONNIFY_BASE_URL?.trim().replace(/\/+$/, "");
    const baseUrl = configured || (production ? LIVE : SANDBOX);
    // Production never takes sandbox answers for real bank details.
    if (production && baseUrl !== LIVE) return { mode: "off" };
    return { mode: "provider", apiKey, secretKey, baseUrl };
  }
  return production ? { mode: "off" } : { mode: "test" };
}

let cached: { key: string; resolver: BankAccountResolver } | null = null;

/** The resolver for this environment, or null when lookups are off (production without keys). */
function resolver(): BankAccountResolver | null {
  const mode = lookupMode();
  if (mode.mode === "off") return null;
  if (mode.mode === "test") return createTestBankAccountResolver();
  // Keep one provider client so its bearer token (Metalira's own) is reused until it expires.
  const key = `${mode.baseUrl}|${mode.apiKey}`;
  if (cached?.key !== key) {
    cached = {
      key,
      resolver: getBankAccountResolver(
        { apiKey: mode.apiKey, secretKey: mode.secretKey },
        { baseUrl: mode.baseUrl },
      ),
    };
  }
  return cached.resolver;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * Keyed digest of an account number for one company and bank: lets the database tie a request
 * to its lookup, and the server prove on approval that the encrypted number is the one checked,
 * without storing the number again.
 */
export function bankAccountDigest(
  organisationId: string,
  bankCode: string,
  accountNumber: string,
): string {
  return createHmac("sha256", derivePiiSubkey("bank-account-digest"))
    .update(`${organisationId}:${bankCode}:${accountNumber}`, "utf8")
    .digest("hex");
}

export function digestMatches(
  organisationId: string,
  bankCode: string,
  accountNumber: string,
  digest: string,
): boolean {
  const expected = Buffer.from(bankAccountDigest(organisationId, bankCode, accountNumber), "hex");
  const given = Buffer.from(digest, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function matchExpected(accountName: string, expected: ExpectedNames): NameMatch {
  return expected.kind === "company"
    ? matchCompanyName(accountName, expected.names)
    : matchPersonName(accountName, expected);
}

/** The company's legal, trading and display names, for the company account. */
export async function loadCompanyNames(
  supabase: Client,
  organisationId: string,
): Promise<ExpectedNames> {
  const { data, error } = await supabase
    .from("organisations")
    .select("name, legal_name, trading_name")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the company name: ${error.code}`);
  return { kind: "company", names: [data?.legal_name, data?.trading_name, data?.name] };
}

/** A worker's first and last name, read under the caller's RLS. */
export async function loadWorkerNames(
  supabase: Client,
  organisationId: string,
  workerId: string,
): Promise<ExpectedNames | null> {
  const { data, error } = await supabase
    .from("workers")
    .select("first_name, last_name")
    .eq("organisation_id", organisationId)
    .eq("id", workerId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the employee: ${error.code}`);
  return data ? { kind: "person", firstName: data.first_name, lastName: data.last_name } : null;
}

// ---------------------------------------------------------------------------
// Looking up
// ---------------------------------------------------------------------------

export const LOOKUP_MESSAGES = {
  not_found: "The bank has no account with this number. Check the number and the bank.",
  invalid_bank: "This bank can't be checked right now. Choose it again, or try another bank.",
  timeout: "The bank didn't answer in time. Try again in a minute.",
  unavailable: "The bank check isn't working right now. Try again in a minute.",
  not_configured:
    "Account name checks aren't switched on yet, so bank details can't be added. Contact Metalira support.",
  failed: "The account couldn't be checked. Try again in a minute.",
} as const satisfies Record<ResolveBankAccountError | "failed", string>;

export type BankLookupView =
  | {
      ok: true;
      /** Names the lookup when the form is sent. Bound to this user, bank and number. */
      lookupId: string;
      bankCode: string;
      bankName: string;
      accountName: string;
      /** Not a real bank's answer (test resolver or provider sandbox): show "Test lookup". */
      test: boolean;
      result: NameMatch["result"];
      expected: string;
    }
  | { ok: false; message: string; field?: "bankCode" | "bankAccountNumber" };

export interface RunBankLookupInput {
  organisationId: string;
  /** The verified session's user. */
  userId: string;
  purpose: BankLookupPurpose;
  workerId: string | null;
  bankCode: string;
  accountNumber: string;
  expected: ExpectedNames;
}

/**
 * Looks the account up and records it. The caller has verified the session and validated the
 * input; the database checks the role for the purpose again and applies the hourly limits.
 */
export async function runBankLookup(input: RunBankLookupInput): Promise<BankLookupView> {
  const bank = bankByCode(input.bankCode);
  if (!bank) return { ok: false, message: "Choose a bank from the list.", field: "bankCode" };
  if (!/^\d{10}$/.test(input.accountNumber)) {
    return {
      ok: false,
      message: "Bank account numbers are 10 digits.",
      field: "bankAccountNumber",
    };
  }
  const resolve = resolver();
  if (!resolve) return { ok: false, message: LOOKUP_MESSAGES.not_configured };

  const admin = createAdminSupabase();
  const { data: lookupId, error: beginError } = await admin.rpc("begin_bank_account_lookup", {
    p_organisation_id: input.organisationId,
    p_user_id: input.userId,
    p_purpose: input.purpose,
    // null for the company account and a worker being added (the generated type says string).
    p_worker_id: input.workerId as string,
    p_bank_code: bank.code,
    p_bank_account_digest: bankAccountDigest(input.organisationId, bank.code, input.accountNumber),
    p_bank_account_last4: input.accountNumber.slice(-4),
  });
  if (beginError || !lookupId) {
    if (beginError?.code === "MLBL1" || beginError?.code === "MLBL2") {
      return { ok: false, message: beginError.message };
    }
    if (beginError?.code === "42501") {
      return { ok: false, message: "Your role can't check this bank account." };
    }
    console.error("billing.bank_lookup_begin_failed:", beginError?.code ?? "no id");
    return { ok: false, message: LOOKUP_MESSAGES.failed };
  }

  const answer = await resolve.resolveBankAccount({
    bankCode: bank.code,
    accountNumber: input.accountNumber,
    expectedNames:
      input.expected.kind === "company"
        ? {
            kind: "company",
            names: input.expected.names.filter(
              (n): n is string => typeof n === "string" && n.trim() !== "",
            ),
          }
        : input.expected,
  });

  const { error: finishError } = await admin.rpc("finish_bank_account_lookup", {
    p_id: lookupId,
    p_status: answer.ok ? "resolved" : answer.error === "not_found" ? "not_found" : "failed",
    p_account_name: answer.ok ? answer.accountName : undefined,
    p_source: answer.ok ? answer.source : undefined,
  });
  if (finishError) {
    console.error("billing.bank_lookup_finish_failed:", finishError.code);
    return { ok: false, message: LOOKUP_MESSAGES.failed };
  }
  if (!answer.ok) {
    if (answer.error !== "not_found") console.error("billing.bank_lookup_failed:", answer.error);
    return {
      ok: false,
      message: LOOKUP_MESSAGES[answer.error],
      ...(answer.error === "not_found" ? { field: "bankAccountNumber" as const } : {}),
      ...(answer.error === "invalid_bank" ? { field: "bankCode" as const } : {}),
    };
  }

  const check = matchExpected(answer.accountName, input.expected);
  return {
    ok: true,
    lookupId,
    bankCode: bank.code,
    bankName: bank.name,
    accountName: answer.accountName,
    test: answer.source !== "bank",
    result: check.result,
    expected: check.expected,
  };
}

// ---------------------------------------------------------------------------
// Taking a lookup into a request
// ---------------------------------------------------------------------------

export interface CheckedName {
  bankCode: string;
  bankName: string;
  accountName: string;
  digest: string;
  nameCheck: "match" | "near";
  reason: string | null;
}

const CHECK_AGAIN = "Check the account again: the bank check has expired or the details changed.";

export function noMatchMessage(accountName: string, expected: string): string {
  return `The bank says this account belongs to ${accountName}, which doesn't match ${expected}. Use an account in ${expected}'s name.`;
}

export const NEAR_REASON_MESSAGE = `The names are close but not the same. Say why this is the right account (at least ${NEAR_REASON_MIN} characters).`;

/**
 * At submit: reads the caller's own lookup (RLS), checks it is for this bank and number and still
 * fresh, and compares its name with the expected names again. Refuses a no-match, and a near
 * match without a reason. The database repeats the binding checks when the request is inserted.
 * Errors are field errors on the form's names (`bankAccountNumber`, `nameCheckReason`).
 */
export async function takeCheckedName(
  supabase: Client,
  args: {
    organisationId: string;
    lookupId: string;
    purpose: BankLookupPurpose;
    workerId: string | null;
    bankCode: string;
    accountNumber: string;
    expected: ExpectedNames;
    reason: string | null;
  },
): Promise<CheckedName> {
  const bank = bankByCode(args.bankCode);
  if (!bank) {
    throw new MutationError("invalid", "Choose a bank from the list.", {
      bankCode: "Choose a bank from the list.",
    });
  }
  const { data: lookup, error } = await supabase
    .from("bank_account_lookups")
    .select(
      "id, status, purpose, worker_id, bank_code, bank_account_digest, account_name, created_at, used_at",
    )
    .eq("id", args.lookupId)
    .eq("organisation_id", args.organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the bank check: ${error.code}`);
  const fresh =
    lookup !== null &&
    Date.parse(lookup.created_at) > Date.now() - LOOKUP_VALID_MINUTES * 60_000 &&
    lookup.used_at === null;
  if (
    !lookup ||
    !fresh ||
    lookup.status !== "resolved" ||
    !lookup.account_name ||
    lookup.purpose !== args.purpose ||
    (lookup.worker_id !== null && lookup.worker_id !== args.workerId) ||
    lookup.bank_code !== bank.code ||
    !digestMatches(args.organisationId, bank.code, args.accountNumber, lookup.bank_account_digest)
  ) {
    throw new MutationError("invalid", CHECK_AGAIN, { bankAccountNumber: CHECK_AGAIN });
  }

  const check = matchExpected(lookup.account_name, args.expected);
  if (check.result === "no_match") {
    const message = noMatchMessage(lookup.account_name, check.expected);
    throw new MutationError("invalid", message, { bankAccountNumber: message });
  }
  const reason = args.reason?.trim() || null;
  if (check.result === "near" && (!reason || reason.length < NEAR_REASON_MIN)) {
    throw new MutationError("invalid", NEAR_REASON_MESSAGE, {
      nameCheckReason: NEAR_REASON_MESSAGE,
    });
  }
  return {
    bankCode: bank.code,
    bankName: bank.name,
    accountName: lookup.account_name,
    digest: lookup.bank_account_digest,
    nameCheck: check.result,
    reason: check.result === "near" ? reason : null,
  };
}

// ---------------------------------------------------------------------------
// On approval
// ---------------------------------------------------------------------------

export interface StoredCheck {
  name_check_source?: string | null;
  /** Bank changes only: the worker raised it from their own login. */
  raised_by_worker?: boolean;
  bank_code: string | null;
  bank_lookup_id: string | null;
  bank_account_digest: string | null;
  name_check: Database["public"]["Enums"]["bank_name_check"] | null;
  name_check_reason: string | null;
  account_name: string;
}

/**
 * Before an approval: a checked request must still hold the number that was checked (its
 * digest), and its bank name must still compare as it did, by today's rules and names. Returns a
 * refusal sentence, or null when it may be approved. Requests without a check (`not_checked`, or
 * raised before slice 2.3b) pass here; the approver sees "Not checked".
 */
export function refuseCheckedRequest(
  organisationId: string,
  stored: StoredCheck,
  accountNumber: string,
  expected: ExpectedNames,
  { production = isProductionLookupEnv() }: { production?: boolean } = {},
): string | null {
  if (stored.name_check === "not_checked" && stored.raised_by_worker) {
    // The worker app always checks: an unchecked request from a worker came round the app.
    return "This request wasn't checked with the bank, so it can't be approved. Reject it and ask the employee to send it again from the app.";
  }
  if (stored.name_check !== "match" && stored.name_check !== "near") return null;
  if (production && stored.name_check_source !== "bank") {
    return "This request was checked with a test lookup, not the bank, so it can't be approved here. Reject it and raise a new one.";
  }
  if (
    !stored.bank_code ||
    !stored.bank_account_digest ||
    !digestMatches(organisationId, stored.bank_code, accountNumber, stored.bank_account_digest)
  ) {
    return "This request's account number isn't the one the bank checked, so it can't be approved. Reject it and raise a new one.";
  }
  const check = matchExpected(stored.account_name, expected);
  if (check.result === "no_match") {
    return `The bank's name for this account, ${stored.account_name}, doesn't match ${check.expected}, so it can't be approved. Reject it.`;
  }
  if (check.result === "near" && (stored.name_check_reason ?? "").length < NEAR_REASON_MIN) {
    return "The bank's name is only a close match and the request gives no reason, so it can't be approved. Reject it and raise a new one with a reason.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Showing a stored check
// ---------------------------------------------------------------------------

/** How a request's name check shows on a card (approvers see it before deciding). */
export interface NameCheckView {
  /** Recomputed from the stored bank name and today's expected names; `not_checked` without one. */
  status: NameMatch["result"] | "not_checked";
  /** The name it was compared with, when checked. */
  expected: string | null;
  /** The requester's reason for a close match. */
  reason: string | null;
  /** The name came from the test resolver. */
  test: boolean;
}

export function nameCheckView(
  row: {
    account_name: string;
    name_check: Database["public"]["Enums"]["bank_name_check"] | null;
    name_check_reason: string | null;
    name_check_source: string | null;
  },
  expected: ExpectedNames | null,
): NameCheckView {
  if ((row.name_check !== "match" && row.name_check !== "near") || !expected) {
    return { status: "not_checked", expected: null, reason: null, test: false };
  }
  const check = matchExpected(row.account_name, expected);
  return {
    status: check.result,
    expected: check.expected,
    reason: row.name_check_reason,
    test: row.name_check_source !== "bank",
  };
}
