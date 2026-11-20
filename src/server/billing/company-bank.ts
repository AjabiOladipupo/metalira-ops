import "server-only";

import { randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import {
  COMPANY_BANK_APPROVERS,
  COMPANY_BANK_REQUESTERS,
  canApproveCompanyBank,
  canRequestCompanyBank,
  canRevealCompanyBank,
  formatCompanyAccount,
  last4Matches,
  type CompanyBankState,
} from "@/lib/company-bank";
import type { ManagerRole } from "@/lib/roles";
import { PiiDecryptError, decryptPii, sealPii, type PiiContext } from "@/server/crypto/pii";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { getSession } from "@/server/identity/session";
import type { Database } from "@/types/db";

import {
  loadCompanyNames,
  nameCheckView,
  refuseCheckedRequest,
  takeCheckedName,
  type NameCheckView,
} from "./bank-lookup";
import {
  decideCompanyBankSchema,
  requestCompanyBankSchema,
  withdrawCompanyBankSchema,
  type CompanyBankDecision,
} from "./schemas";

/**
 * The company's own collection bank account (slice 2.3, CLAUDE.md rules 6, 9 and 10): the
 * account clients pay invoices into. Adding or changing it is a request in
 * `public.organisation_bank_accounts` (migration 20261119110000); a second person (owner or
 * finance, never the requester) approves it, and it takes effect 72 hours later. The first
 * account an owner adds while company setup is unfinished takes effect at once, once per
 * company. The database enforces all of that for every client.
 *
 * What the database can't check without the key is done here: on approval the request is
 * decrypted and refused unless its last four digits belong to its number, so what the approver
 * saw is what clients will pay into. The number is sealed for its own row
 * (`organisation_bank_accounts.bank_account_enc`), with the row id generated before the insert.
 */

export type CompanyBankStatus = Database["public"]["Enums"]["org_bank_account_status"];

type Client = SupabaseClient<Database>;

/** The encryption context of a company bank account number: its own row. */
export function companyBankContext(organisationId: string, accountId: string): PiiContext {
  return {
    organisationId,
    table: "organisation_bank_accounts",
    column: "bank_account_enc",
    rowId: accountId,
  };
}

const NOT_FOUND_OR_DECIDED = "That request wasn't found, or someone has already decided it.";
const OPEN_REQUEST =
  "A bank account request is already waiting. Approve, reject or withdraw it before raising another.";

/** Field errors for the database's own refusals; anything else is rethrown as a failure. */
function fromDbError(error: PostgrestError, field = "bankAccountNumber"): never {
  const text = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", error.message || "Your role can't make this change.");
    case "P0002":
    case "22023":
    case "MLOB1":
    case "MLOB3":
    case "MLOB4":
    case "MLOB5":
    case "MLBLC":
      throw new MutationError("invalid", error.message);
    case "MLBL3":
    case "MLBL4":
    case "MLBL5":
    case "MLBL6":
    case "MLBL7":
    case "MLBLT":
      throw new MutationError("invalid", error.message, { bankAccountNumber: error.message });
    case "23505":
      if (text.includes("organisation_bank_accounts_one_open_key")) {
        throw new MutationError("invalid", OPEN_REQUEST, { [field]: OPEN_REQUEST });
      }
      break;
    case "23514":
      if (text.includes("_text")) {
        throw new MutationError("invalid", "Use plain text, without < or > or a web address.");
      }
      break;
  }
  throw new Error(`Database refused the change (${error.code})`);
}

// ---------------------------------------------------------------------------
// Raise a request (or add the first account during setup)
// ---------------------------------------------------------------------------

export interface RaisedCompanyBank {
  id: string;
  /** The organisation the change was made in (the mutation's own, never re-read). */
  organisationId: string;
  status: CompanyBankStatus;
  /** True when it was the first account, in use at once without a second approver. */
  singleApprover: boolean;
  last4: string;
}

export const requestCompanyBankSpec: MutationSpec<
  typeof requestCompanyBankSchema,
  RaisedCompanyBank
> = {
  schema: requestCompanyBankSchema,
  roles: COMPANY_BANK_REQUESTERS,
  run: async ({ supabase, organisationId, data }) => {
    // The account name is the bank's, from the caller's own lookup; never from the form.
    const checked = await takeCheckedName(supabase, {
      organisationId,
      lookupId: data.bankLookupId,
      purpose: "company_bank",
      workerId: null,
      bankCode: data.bankCode,
      accountNumber: data.bankAccountNumber,
      expected: await loadCompanyNames(supabase, organisationId),
      reason: data.nameCheckReason,
    });
    const id = randomUUID();
    const sealed = sealPii(data.bankAccountNumber, companyBankContext(organisationId, id));
    // A NUBAN is 10 digits, so it always has four to show.
    if (!sealed.last4) throw new MutationError("invalid", "Bank account numbers are 10 digits");
    const { data: rows, error } = await supabase.rpc("request_org_bank_account", {
      p_organisation_id: organisationId,
      p_id: id,
      p_bank_name: checked.bankName,
      p_account_name: checked.accountName,
      p_bank_account_enc: sealed.enc,
      p_bank_account_last4: sealed.last4,
      p_reason: data.reason ?? undefined,
      p_bank_code: checked.bankCode,
      p_bank_lookup_id: data.bankLookupId,
      p_bank_account_digest: checked.digest,
      p_name_check: checked.nameCheck,
      p_name_check_reason: checked.reason ?? undefined,
    });
    if (error) fromDbError(error);
    const row = rows?.[0];
    if (!row) throw new Error("The request was not saved");
    return {
      id: row.id,
      organisationId,
      status: row.status,
      singleApprover: row.single_approver,
      last4: sealed.last4,
    };
  },
};

/** Raises a request to add or change the company bank account. */
export function requestCompanyBank(input: unknown): Promise<RaisedCompanyBank> {
  return mutate(requestCompanyBankSpec, input);
}

// ---------------------------------------------------------------------------
// Decide: approve, reject, or stop during the hold
// ---------------------------------------------------------------------------

export interface DecidedCompanyBank {
  id: string;
  organisationId: string;
  status: CompanyBankStatus;
  appliesAfter: string | null;
  last4: string;
}

/** Decrypts a stored number, or null when it can't be read. */
function readNumber(enc: string | null | undefined, ctx: PiiContext): string | null {
  if (!enc) return null;
  try {
    return decryptPii(enc, ctx);
  } catch (error) {
    if (error instanceof PiiDecryptError) return null;
    throw error;
  }
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Before an approval: proves that the last four digits the approver sees (on the card, in the
 * emails, on invoices) belong to the number clients will pay into. A requester writing rows
 * directly could otherwise pair any ciphertext with the last four digits of a trusted account.
 * Also refuses a request for the account already in use, which changes nothing.
 */
export async function checkRequestedAccount(
  supabase: Client,
  organisationId: string,
  accountId: string,
): Promise<void> {
  const { data: rows, error } = await supabase
    .from("organisation_bank_accounts")
    .select(
      "id, status, bank_name, account_name, bank_account_enc, bank_account_last4, bank_code, bank_lookup_id, bank_account_digest, name_check, name_check_reason, name_check_source",
    )
    .eq("organisation_id", organisationId)
    .in("status", ["pending", "active"]);
  if (error) fromDbError(error, "decision");
  const request = rows?.find((r) => r.id === accountId);
  if (request?.status !== "pending") throw new MutationError("invalid", NOT_FOUND_OR_DECIDED);

  const number = readNumber(
    request.bank_account_enc,
    companyBankContext(organisationId, accountId),
  );
  if (number === null) {
    throw new MutationError(
      "invalid",
      "This request's account number can't be checked, so it can't be approved. Reject it and raise a new one.",
    );
  }
  if (!last4Matches(number, request.bank_account_last4)) {
    throw new MutationError(
      "invalid",
      "The last four digits on this request don't match its account number, so it can't be approved. Reject it and raise a new one.",
    );
  }

  // The bank's name check (slice 2.3b): the number is the one checked, and the name still
  // compares by today's rules and company names.
  const refusal = refuseCheckedRequest(
    organisationId,
    request,
    number,
    await loadCompanyNames(supabase, organisationId),
  );
  if (refusal) throw new MutationError("invalid", refusal);

  const current = rows?.find((r) => r.status === "active");
  if (
    current &&
    sameText(current.bank_name, request.bank_name) &&
    sameText(current.account_name, request.account_name) &&
    readNumber(current.bank_account_enc, companyBankContext(organisationId, current.id)) === number
  ) {
    throw new MutationError(
      "invalid",
      "This is the account already in use, so there is nothing to approve. Reject it instead.",
    );
  }
}

export const decideCompanyBankSpec: MutationSpec<
  typeof decideCompanyBankSchema,
  DecidedCompanyBank
> = {
  schema: decideCompanyBankSchema,
  roles: COMPANY_BANK_APPROVERS,
  run: async ({ supabase, organisationId, data }) => {
    if (data.decision === "approve") {
      await checkRequestedAccount(supabase, organisationId, data.accountId);
    }
    // The database refuses the requester, fills in who decided and when, and sets the hold.
    const { data: rows, error } = await supabase.rpc("decide_org_bank_account", {
      p_organisation_id: organisationId,
      p_id: data.accountId,
      p_decision: data.decision satisfies CompanyBankDecision,
      p_note: data.note ?? undefined,
    });
    if (error) fromDbError(error, "decision");
    const row = rows?.[0];
    if (!row) throw new MutationError("invalid", NOT_FOUND_OR_DECIDED);
    return {
      id: row.id,
      organisationId,
      status: row.status,
      appliesAfter: row.applies_after,
      last4: row.bank_account_last4,
    };
  },
};

/** Approves, rejects or stops a request. Never the caller's own. */
export function decideCompanyBank(input: unknown): Promise<DecidedCompanyBank> {
  return mutate(decideCompanyBankSpec, input);
}

// ---------------------------------------------------------------------------
// Withdraw (the requester, before anyone decides)
// ---------------------------------------------------------------------------

export const withdrawCompanyBankSpec: MutationSpec<typeof withdrawCompanyBankSchema, string> = {
  schema: withdrawCompanyBankSchema,
  roles: COMPANY_BANK_REQUESTERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("withdraw_org_bank_account", {
      p_organisation_id: organisationId,
      p_id: data.accountId,
    });
    if (error) fromDbError(error, "accountId");
    return id;
  },
};

/** Withdraws a pending request the caller raised. */
export function withdrawCompanyBank(input: unknown): Promise<string> {
  return mutate(withdrawCompanyBankSpec, input);
}

// ---------------------------------------------------------------------------
// Apply on read
// ---------------------------------------------------------------------------

/**
 * Makes every approved account whose hold has ended the one in use (pg_cron does the same every
 * 5 minutes). It writes, so it re-checks the user with the verified getSession even on a page
 * rendered from the claims-only page session. A failure is logged by code only, never thrown:
 * the page still shows the account as approved and due, and invoices read the account in force
 * from the rows themselves (`org_bank_account_as_of`).
 */
export async function applyDueCompanyBank(
  supabase: Client,
  organisationId: string,
): Promise<number> {
  const session = await getSession();
  if (session?.active?.organisationId !== organisationId) return 0;
  const { data, error } = await supabase.rpc("apply_due_org_bank_accounts", {
    p_organisation_id: organisationId,
  });
  if (error) {
    console.error("billing.company_bank_apply_failed:", error.code);
    return 0;
  }
  return data ?? 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CompanyBankView {
  id: string;
  status: CompanyBankStatus;
  bankName: string;
  accountName: string;
  last4: string;
  /** "GTBank ••••4410 · ADEBAYO FACILITY SERVICES LTD". */
  label: string;
  reason: string | null;
  /** The bank's account name check, recomputed from the stored name (slice 2.3b). */
  nameCheck: NameCheckView;
  singleApprover: boolean;
  requestedBy: string;
  requestedByName: string;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliesAfter: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  cancelledAt: string | null;
}

export interface CompanyBankDetail {
  /** Every request and account, newest first. */
  history: CompanyBankView[];
  /** The account in use now (the hold has ended), if any. */
  current: CompanyBankView | null;
  /** The request waiting for approval or on hold, if any. */
  open: CompanyBankView | null;
  /** An account was approved or added as the first account: the setup exception is gone. */
  firstAccountUsed: boolean;
}

const COLUMNS =
  "id, status, bank_name, account_name, bank_account_last4, reason, name_check, name_check_reason, name_check_source, name_check_expected, single_approver, requested_by, approved_by, rejected_by, cancelled_by, decision_note, created_at, decided_at, applies_after, activated_at, retired_at, cancelled_at";

const FORMER_USER = "A former user";

async function userNames(supabase: Client, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", unique);
  if (error) throw new Error(`Could not read names: ${error.code}`);
  return new Map(
    (data ?? []).flatMap((p) => (p.full_name?.trim() ? [[p.user_id, p.full_name.trim()]] : [])),
  );
}

/**
 * Every request and account of the company, for owner, admin and finance (RLS hides the table
 * from other roles: they get an empty history and use `loadCompanyBankSummary`). Never the
 * account number: last four digits only.
 */
export async function loadCompanyBank(
  supabase: Client,
  organisationId: string,
  now: Date = new Date(),
): Promise<CompanyBankDetail> {
  const { data, error } = await supabase
    .from("organisation_bank_accounts")
    .select(COLUMNS)
    .eq("organisation_id", organisationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not read the company bank account: ${error.code}`);
  const rows = data ?? [];

  const names = await userNames(
    supabase,
    rows.flatMap((r) =>
      [r.requested_by, r.approved_by, r.rejected_by, r.cancelled_by].filter(
        (id): id is string => id !== null,
      ),
    ),
  );
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? FORMER_USER) : null);
  const companyNames = rows.length > 0 ? await loadCompanyNames(supabase, organisationId) : null;

  const history: CompanyBankView[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    bankName: r.bank_name,
    accountName: r.account_name,
    last4: r.bank_account_last4,
    label: formatCompanyAccount({
      bankName: r.bank_name,
      accountName: r.account_name,
      last4: r.bank_account_last4,
    }),
    reason: r.reason,
    nameCheck: nameCheckView(r, companyNames),
    singleApprover: r.single_approver,
    requestedBy: r.requested_by,
    requestedByName: nameOf(r.requested_by) ?? FORMER_USER,
    decidedByName: nameOf(r.approved_by ?? r.rejected_by ?? r.cancelled_by),
    decisionNote: r.decision_note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    appliesAfter: r.applies_after,
    activatedAt: r.activated_at,
    retiredAt: r.retired_at,
    cancelledAt: r.cancelled_at,
  }));

  // In force: the latest account whose hold has ended, whether or not the apply has run.
  const at = now.getTime();
  const inForce = history
    .filter(
      (r) =>
        (r.status === "approved" || r.status === "active" || r.status === "retired") &&
        r.appliesAfter !== null &&
        Date.parse(r.appliesAfter) <= at,
    )
    .sort((a, b) => Date.parse(b.appliesAfter ?? "") - Date.parse(a.appliesAfter ?? ""))[0];
  const open =
    history.find(
      (r) =>
        r.status === "pending" ||
        (r.status === "approved" && r.appliesAfter !== null && Date.parse(r.appliesAfter) > at),
    ) ?? null;

  return {
    history,
    current: inForce ?? null,
    open,
    firstAccountUsed: history.some(
      (r) =>
        r.singleApprover ||
        r.status === "approved" ||
        r.status === "active" ||
        r.status === "retired",
    ),
  };
}

/** What the preview needs, from the detail and the company's setup state. */
export function companyBankState(
  detail: CompanyBankDetail,
  setupCompleted: boolean,
): CompanyBankState {
  return {
    current: detail.current
      ? {
          bankName: detail.current.bankName,
          accountName: detail.current.accountName,
          last4: detail.current.last4,
        }
      : null,
    hasOpenRequest: detail.open !== null,
    setupCompleted,
    firstAccountUsed: detail.firstAccountUsed,
  };
}

/**
 * The compact, masked summary every manager may read (dashboards, Setup, Settings, and Lira
 * later): the account in force, masked to its last four digits, and, for the roles that can see
 * requests, what is waiting. Never a full number, never ciphertext.
 */
export interface CompanyBankSummary {
  /** The account in force now, masked, or null when the company has none yet. */
  current: {
    bankName: string;
    accountName: string;
    last4: string;
    label: string;
    since: string;
  } | null;
  /** A request waiting for a second person or on hold; null when none, or not visible. */
  open: {
    status: "pending" | "approved";
    label: string;
    appliesAfter: string | null;
  } | null;
}

export async function loadCompanyBankSummary(
  supabase: Client,
  organisationId: string,
  role: ManagerRole,
  now: Date = new Date(),
): Promise<CompanyBankSummary> {
  const { data, error } = await supabase.rpc("org_bank_account_masked", {
    p_organisation_id: organisationId,
  });
  if (error) throw new Error(`Could not read the company bank account: ${error.code}`);
  const row = data?.[0];
  const current = row
    ? {
        bankName: row.bank_name,
        accountName: row.account_name,
        last4: row.bank_account_last4,
        label: formatCompanyAccount({
          bankName: row.bank_name,
          accountName: row.account_name,
          last4: row.bank_account_last4,
        }),
        since: row.in_force_from,
      }
    : null;

  let open: CompanyBankSummary["open"] = null;
  if (canRequestCompanyBank(role)) {
    const { data: waiting, error: openError } = await supabase
      .from("organisation_bank_accounts")
      .select("status, bank_name, account_name, bank_account_last4, applies_after")
      .eq("organisation_id", organisationId)
      .in("status", ["pending", "approved"])
      .maybeSingle();
    if (openError) throw new Error(`Could not read the company bank account: ${openError.code}`);
    // An approved account whose hold has ended is already the one in force (above).
    const due =
      waiting?.status === "approved" &&
      waiting.applies_after !== null &&
      Date.parse(waiting.applies_after) <= now.getTime();
    if (waiting && (waiting.status === "pending" || waiting.status === "approved") && !due) {
      open = {
        status: waiting.status,
        label: formatCompanyAccount({
          bankName: waiting.bank_name,
          accountName: waiting.account_name,
          last4: waiting.bank_account_last4,
        }),
        appliesAfter: waiting.applies_after,
      };
    }
  }
  return { current, open };
}

/** What a page needs to know about the viewer to show the request's actions. */
export interface CompanyBankViewer {
  userId: string;
  canRequest: boolean;
  /** Owner or finance: may approve, reject and stop (never their own request). */
  isApprover: boolean;
  /** Owner or finance: may see the number in full, audited. */
  canReveal: boolean;
  /** Now, as an ISO string, so the whole page agrees on whether a hold has ended. */
  now: string;
}

export function companyBankViewer(userId: string, role: ManagerRole, now: Date): CompanyBankViewer {
  return {
    userId,
    canRequest: canRequestCompanyBank(role),
    isApprover: canApproveCompanyBank(role),
    canReveal: canRevealCompanyBank(role),
    now: now.toISOString(),
  };
}
