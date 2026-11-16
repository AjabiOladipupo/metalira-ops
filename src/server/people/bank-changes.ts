import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type { ManagerRole } from "@/lib/roles";
import { sealPii, type PiiContext } from "@/server/crypto/pii";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

import {
  decideBankChangeSchema,
  requestBankChangeSchema,
  withdrawBankChangeSchema,
  type BankChangeDecision,
} from "./schemas";
import { PEOPLE_EDITORS } from "./workers";

/**
 * Bank-detail changes (slice 1.7, CLAUDE.md rule 10, owner decision 9). A request changes
 * nothing on its own: a second person approves it, and 72 hours after approval the database
 * copies it onto the worker (public.bank_detail_changes, migration 20261116214500). Every rule
 * that matters is enforced there, for every client; the checks here only give a clearer message
 * sooner.
 *
 * The new account number is encrypted for its destination, `workers.bank_account_enc` of the
 * worker, so the database can apply it when the hold ends without any key (see pii.ts).
 */

/** Who may raise a request for any worker: the people who edit employees. */
export const BANK_CHANGE_REQUESTERS = PEOPLE_EDITORS;
/** Who may approve, reject or stop a request (never their own, never for themselves). */
export const BANK_CHANGE_APPROVERS = [
  "owner",
  "hr",
  "finance",
] as const satisfies readonly ManagerRole[];
/** Who may open the approvals list. Admins see it without deciding. */
export const BANK_CHANGE_VIEWERS = [
  "owner",
  "admin",
  "hr",
  "finance",
] as const satisfies readonly ManagerRole[];

/** Hours between approval and the new account taking effect (owner decision 9). */
export const BANK_CHANGE_HOLD_HOURS = 72;

export type BankChangeStatus = Database["public"]["Enums"]["bank_detail_change_status"];

type Client = SupabaseClient<Database>;

/** The encryption context of a worker's bank account number, wherever it waits. */
export function bankAccountContext(organisationId: string, workerId: string): PiiContext {
  return { organisationId, table: "workers", column: "bank_account_enc", rowId: workerId };
}

export function isBankChangeApprover(role: ManagerRole): boolean {
  return (BANK_CHANGE_APPROVERS as readonly ManagerRole[]).includes(role);
}

export function canViewBankChanges(role: ManagerRole): boolean {
  return (BANK_CHANGE_VIEWERS as readonly ManagerRole[]).includes(role);
}

/** Field errors for the database's own refusals; anything else is rethrown as a failure. */
function fromDbError(error: PostgrestError, field = "bankAccountNumber"): never {
  const text = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", error.message || "Your role can't make this change.");
    case "P0002":
    case "MLBK1":
    case "MLBK2":
    case "MLBK3":
    case "MLBK4":
    case "MLBK5":
      throw new MutationError("invalid", error.message);
    case "23505":
      if (text.includes("bank_detail_changes_one_open_key")) {
        const message =
          "A bank change for this employee is already waiting. Approve, reject or withdraw it first.";
        throw new MutationError("invalid", message, { [field]: message });
      }
      break;
    case "23503":
      throw new MutationError("invalid", "That employee wasn't found.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

// ---------------------------------------------------------------------------
// Raise a request
// ---------------------------------------------------------------------------

export interface RaisedBankChange {
  id: string;
  workerId: string;
}

export const requestBankChangeSpec: MutationSpec<typeof requestBankChangeSchema, RaisedBankChange> =
  {
    schema: requestBankChangeSchema,
    roles: BANK_CHANGE_REQUESTERS,
    run: async ({ supabase, organisationId, data }) => {
      const sealed = sealPii(
        data.bankAccountNumber,
        bankAccountContext(organisationId, data.workerId),
      );
      // A NUBAN is 10 digits, so it always has four to show.
      if (!sealed.last4) throw new MutationError("invalid", "Bank account numbers are 10 digits");
      const { data: row, error } = await supabase
        .from("bank_detail_changes")
        .insert({
          organisation_id: organisationId,
          worker_id: data.workerId,
          bank_name: data.bankName,
          account_name: data.accountName,
          bank_account_enc: sealed.enc,
          bank_account_last4: sealed.last4,
          reason: data.reason,
        })
        .select("id")
        .single();
      if (error) fromDbError(error);
      return { id: row.id, workerId: data.workerId };
    },
  };

/** Raises a bank-detail change for a worker. Nothing changes until a second person approves. */
export function requestBankChange(input: unknown): Promise<RaisedBankChange> {
  return mutate(requestBankChangeSpec, input);
}

// ---------------------------------------------------------------------------
// Decide: approve, reject, or stop during the hold
// ---------------------------------------------------------------------------

export interface DecidedBankChange {
  id: string;
  workerId: string;
  status: BankChangeStatus;
  appliesAfter: string | null;
  last4: string;
}

const DECISION: Record<BankChangeDecision, { from: BankChangeStatus; to: BankChangeStatus }> = {
  approve: { from: "pending", to: "approved" },
  reject: { from: "pending", to: "rejected" },
  stop: { from: "approved", to: "cancelled" },
};

export const decideBankChangeSpec: MutationSpec<typeof decideBankChangeSchema, DecidedBankChange> =
  {
    schema: decideBankChangeSchema,
    roles: BANK_CHANGE_APPROVERS,
    run: async ({ supabase, organisationId, data }) => {
      const { from, to } = DECISION[data.decision];
      // The database fills in who decided and when, sets the hold, and refuses the requester.
      const { data: row, error } = await supabase
        .from("bank_detail_changes")
        .update({ status: to, decision_note: data.note })
        .eq("id", data.changeId)
        .eq("organisation_id", organisationId)
        .eq("status", from)
        .select("id, worker_id, status, applies_after, bank_account_last4")
        .maybeSingle();
      if (error) fromDbError(error, "decision");
      if (!row) {
        throw new MutationError(
          "invalid",
          "That request wasn't found, or someone has already decided it.",
        );
      }
      return {
        id: row.id,
        workerId: row.worker_id,
        status: row.status,
        appliesAfter: row.applies_after,
        last4: row.bank_account_last4,
      };
    },
  };

/** Approves, rejects or stops a request. Never the caller's own, never their own bank details. */
export function decideBankChange(input: unknown): Promise<DecidedBankChange> {
  return mutate(decideBankChangeSpec, input);
}

// ---------------------------------------------------------------------------
// Withdraw (the requester, before anyone decides)
// ---------------------------------------------------------------------------

export const withdrawBankChangeSpec: MutationSpec<
  typeof withdrawBankChangeSchema,
  { id: string; workerId: string }
> = {
  schema: withdrawBankChangeSchema,
  roles: BANK_CHANGE_REQUESTERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("bank_detail_changes")
      .update({ status: "cancelled" })
      .eq("id", data.changeId)
      .eq("organisation_id", organisationId)
      .eq("status", "pending")
      .select("id, worker_id")
      .maybeSingle();
    if (error) fromDbError(error, "changeId");
    if (!row) {
      throw new MutationError(
        "invalid",
        "That request wasn't found, or someone has already decided it.",
      );
    }
    return { id: row.id, workerId: row.worker_id };
  },
};

/** Withdraws a pending request the caller raised. */
export function withdrawBankChange(input: unknown): Promise<{ id: string; workerId: string }> {
  return mutate(withdrawBankChangeSpec, input);
}

// ---------------------------------------------------------------------------
// Apply on read
// ---------------------------------------------------------------------------

/**
 * Applies every approved change in the organisation whose 72-hour hold has ended (pg_cron does
 * the same every 5 minutes). Called before a page shows bank details, so what it shows is never
 * behind the hold. Safe to call any number of times; a failure is logged, not thrown, because
 * the page can still show the request as approved and due.
 */
export async function applyDueBankChanges(
  supabase: Client,
  organisationId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("apply_due_bank_detail_changes", {
    p_organisation_id: organisationId,
  });
  if (error) {
    console.error("people.bank_apply_failed:", error.code);
    return 0;
  }
  return data ?? 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface BankChangeView {
  id: string;
  workerId: string;
  workerName: string;
  staffId: string;
  status: BankChangeStatus;
  bankName: string;
  accountName: string;
  last4: string;
  reason: string | null;
  /** What the change replaces: the snapshot once approved, the worker's details before. */
  previousBankName: string | null;
  previousLast4: string | null;
  requestedBy: string;
  requestedByName: string;
  raisedByWorker: boolean;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliesAfter: string | null;
  appliedAt: string | null;
  cancelledAt: string | null;
}

const COLUMNS =
  "id, worker_id, status, bank_name, account_name, bank_account_last4, reason, requested_by, raised_by_worker, approved_by, rejected_by, cancelled_by, decision_note, previous_bank_name, previous_bank_account_last4, created_at, decided_at, applies_after, applied_at, cancelled_at, workers!bank_detail_changes_worker_fkey ( first_name, last_name, staff_id, bank_name, bank_account_last4 )";

const FORMER_USER = "A former user";

/** Display names for user ids, from profiles the caller may read. */
async function userNames(supabase: Client, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", unique);
  if (error) throw new Error(`Could not read names: ${error.message}`);
  return new Map(
    (data ?? []).flatMap((p) => (p.full_name?.trim() ? [[p.user_id, p.full_name.trim()]] : [])),
  );
}

export interface BankChangeFilter {
  workerId?: string;
  statuses?: readonly BankChangeStatus[];
  limit?: number;
}

/** Requests in the organisation, newest first. Never the account number: last four digits only. */
export async function loadBankChanges(
  supabase: Client,
  organisationId: string,
  filter: BankChangeFilter = {},
): Promise<BankChangeView[]> {
  let query = supabase
    .from("bank_detail_changes")
    .select(COLUMNS)
    .eq("organisation_id", organisationId)
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 200);
  if (filter.workerId) query = query.eq("worker_id", filter.workerId);
  if (filter.statuses) query = query.in("status", [...filter.statuses]);
  const { data, error } = await query;
  if (error) throw new Error(`Could not read bank changes: ${error.message}`);
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

  return rows.map((r) => {
    const worker = r.workers;
    const snapshot = r.status === "pending" ? null : r.previous_bank_account_last4;
    return {
      id: r.id,
      workerId: r.worker_id,
      workerName: worker ? `${worker.first_name} ${worker.last_name}` : "Employee",
      staffId: worker?.staff_id ?? "",
      status: r.status,
      bankName: r.bank_name,
      accountName: r.account_name,
      last4: r.bank_account_last4,
      reason: r.reason,
      previousBankName: r.status === "pending" ? (worker?.bank_name ?? null) : r.previous_bank_name,
      previousLast4: r.status === "pending" ? (worker?.bank_account_last4 ?? null) : snapshot,
      requestedBy: r.requested_by,
      requestedByName: nameOf(r.requested_by) ?? FORMER_USER,
      raisedByWorker: r.raised_by_worker,
      decidedByName: nameOf(r.approved_by ?? r.rejected_by ?? r.cancelled_by),
      decisionNote: r.decision_note,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      appliesAfter: r.applies_after,
      appliedAt: r.applied_at,
      cancelledAt: r.cancelled_at,
    };
  });
}

/** How many requests wait for a decision: the badge in the People header. */
export async function countPendingBankChanges(
  supabase: Client,
  organisationId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("bank_detail_changes")
    .select("id", { count: "exact", head: true })
    .eq("organisation_id", organisationId)
    .eq("status", "pending");
  if (error) throw new Error(`Could not count bank changes: ${error.message}`);
  return count ?? 0;
}

/** What a page needs to know about the viewer to show a request's actions. */
export interface BankChangeViewer {
  userId: string;
  /** Owner, HR or finance: may approve, reject and stop (never their own request). */
  isApprover: boolean;
  /** Owner, HR or finance: may see bank account numbers in full (owner decision 7). */
  canRevealAccount: boolean;
  /** Worker records linked to the viewer's own login: nobody decides their own bank details. */
  ownWorkerIds: readonly string[];
  /** Now, as an ISO string, so the whole page agrees on whether a hold has ended. */
  now: string;
}

/**
 * The viewer for the bank-change cards. The buttons it enables are a convenience: the database
 * refuses the requester and the worker themselves whatever the page shows.
 */
export async function loadBankChangeViewer(
  supabase: Client,
  organisationId: string,
  userId: string,
  role: ManagerRole,
  canRevealAccount: boolean,
): Promise<BankChangeViewer> {
  const { data, error } = await supabase
    .from("memberships")
    .select("worker_id")
    .eq("organisation_id", organisationId)
    .eq("user_id", userId);
  if (error) throw new Error(`Could not read your membership: ${error.message}`);
  return {
    userId,
    isApprover: isBankChangeApprover(role),
    canRevealAccount,
    ownWorkerIds: (data ?? []).flatMap((m) => (m.worker_id ? [m.worker_id] : [])),
    now: new Date().toISOString(),
  };
}
