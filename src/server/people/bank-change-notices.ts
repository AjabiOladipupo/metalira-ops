import "server-only";

import { z } from "zod";

import { formatDateTime } from "@/lib/dates";
import {
  sendBankChangeAppliedEmail,
  sendBankChangeApprovedEmail,
  sendBankChangeRequestedEmail,
} from "@/server/email/bank-changes";
import { createAdminSupabase } from "@/server/supabase/admin";

import { BANK_CHANGE_APPROVERS } from "./bank-changes";

/**
 * Emails about bank-detail changes (slice 1.7): approvers when a request is raised, and the
 * worker when it is approved and when it applies. They run after the change is saved (from
 * `after()` or the daily cron route) and never undo it: a failed send is logged by error name
 * only, never with an address, name or account digits.
 *
 * They read with the secret key because approvers' email addresses live in Supabase Auth, which
 * no signed-in user can read. Every query is scoped to one organisation and one change, except
 * the cron sweep, which looks for applied changes not yet notified in every organisation.
 *
 * The worker's notices are the warning decision 9 relies on during the 72-hour hold, so they go
 * to every address the worker record has held from 90 days before the request until now, not
 * only the current one (see `workerAddresses`).
 */

type Admin = ReturnType<typeof createAdminSupabase>;

const DAY = 86_400_000;
/** How far before a request a changed worker email still gets the worker's notices. */
export const FORMER_ADDRESS_DAYS = 90;
/** How long a failed "applied" email is retried before the sweep gives up on it. */
export const APPLIED_NOTICE_RETRY_DAYS = 7;

function logFailure(what: string, error: unknown): void {
  console.error(`people.${what}:`, error instanceof Error ? error.name : "unknown");
}

const CHANGE_COLUMNS =
  "id, organisation_id, worker_id, requested_by, raised_by_worker, status, bank_account_last4, created_at, applies_after, applied_at, workers!bank_detail_changes_worker_fkey ( first_name, last_name, staff_id, email ), organisations ( name )";

async function loadChange(admin: Admin, organisationId: string, changeId: string) {
  const { data, error } = await admin
    .from("bank_detail_changes")
    .select(CHANGE_COLUMNS)
    .eq("organisation_id", organisationId)
    .eq("id", changeId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the bank change: ${error.code}`);
  return data;
}

const workerName = (w: { first_name: string; last_name: string }) =>
  `${w.first_name} ${w.last_name}`;

/**
 * Where the worker's notices about one change go: their email now, plus every address the
 * worker record held from FORMER_ADDRESS_DAYS before the request until now, read from the row
 * audit (which keeps emails; it drops only secrets). Any people editor can change a worker's
 * email alone, so without this an editor could point it at an address they control, before or
 * during the hold, and the worker would never hear about a change to where they are paid.
 * Addresses are compared without case; the current one comes first.
 */
export async function workerAddresses(
  admin: Admin,
  organisationId: string,
  workerId: string,
  current: string | null,
  requestedAt: string,
): Promise<string[]> {
  const since = new Date(Date.parse(requestedAt) - FORMER_ADDRESS_DAYS * DAY).toISOString();
  const { data, error } = await admin
    .from("audit_log")
    .select("before, after")
    .eq("organisation_id", organisationId)
    .eq("entity", "workers")
    .eq("entity_id", workerId)
    .eq("action", "workers.update")
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Could not read the worker's history: ${error.code}`);

  const found = new Map<string, string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const address = value.trim();
    if (address && !found.has(address.toLowerCase())) found.set(address.toLowerCase(), address);
  };
  add(current);
  const emailOf = (doc: unknown) =>
    doc && typeof doc === "object" ? (doc as { email?: unknown }).email : undefined;
  for (const row of data ?? []) {
    const before = emailOf(row.before);
    const after = emailOf(row.after);
    if (before !== after) {
      add(before);
      add(after);
    }
  }
  return [...found.values()];
}

/**
 * Tells every owner, HR and finance user who could approve the change: not the requester, and
 * not the worker themselves if they hold one of those roles.
 */
export async function notifyApproversOfBankChange(
  organisationId: string,
  changeId: string,
): Promise<number> {
  try {
    const admin = createAdminSupabase();
    const change = await loadChange(admin, organisationId, changeId);
    if (!change || change.status !== "pending" || !change.workers || !change.organisations) {
      return 0;
    }

    const { data: members, error } = await admin
      .from("memberships")
      .select("user_id, worker_id")
      .eq("organisation_id", organisationId)
      .in("role", [...BANK_CHANGE_APPROVERS]);
    if (error) throw new Error(`Could not read approvers: ${error.code}`);
    const approvers = (members ?? []).filter(
      (m) => m.user_id !== change.requested_by && m.worker_id !== change.worker_id,
    );

    let requesterName: string | null = null;
    if (!change.raised_by_worker) {
      const { data: profile } = await admin
        .from("profiles")
        .select("full_name")
        .eq("user_id", change.requested_by)
        .maybeSingle();
      requesterName = profile?.full_name?.trim() || "Someone in your company";
    }

    let sent = 0;
    for (const approver of approvers) {
      try {
        const { data: user } = await admin.auth.admin.getUserById(approver.user_id);
        const to = user.user?.email;
        if (!to || !user.user?.email_confirmed_at) continue;
        await sendBankChangeRequestedEmail({
          to,
          changeId: change.id,
          recipientId: approver.user_id,
          organisationName: change.organisations.name,
          workerName: workerName(change.workers),
          staffId: change.workers.staff_id,
          requesterName,
          last4: change.bank_account_last4,
        });
        sent += 1;
      } catch (sendError) {
        logFailure("bank_change_request_email_failed", sendError);
      }
    }
    return sent;
  } catch (error) {
    logFailure("bank_change_request_notice_failed", error);
    return 0;
  }
}

/** As above, for the request raised when a new employee was added with bank details. */
export async function notifyApproversOfNewWorkerBankDetails(
  organisationId: string,
  workerId: string,
): Promise<number> {
  try {
    const admin = createAdminSupabase();
    const { data, error } = await admin
      .from("bank_detail_changes")
      .select("id")
      .eq("organisation_id", organisationId)
      .eq("worker_id", workerId)
      .eq("status", "pending")
      .maybeSingle();
    if (error) throw new Error(`Could not read the bank change: ${error.code}`);
    return data ? await notifyApproversOfBankChange(organisationId, data.id) : 0;
  } catch (error) {
    logFailure("bank_change_request_notice_failed", error);
    return 0;
  }
}

/**
 * Tells the worker that their change was approved, at every address in `workerAddresses`.
 * Returns how many emails went.
 */
export async function notifyWorkerOfBankChangeApproval(
  organisationId: string,
  changeId: string,
): Promise<number> {
  try {
    const admin = createAdminSupabase();
    const change = await loadChange(admin, organisationId, changeId);
    if (
      change?.status !== "approved" ||
      !change.applies_after ||
      !change.workers ||
      !change.organisations
    ) {
      return 0;
    }
    const addresses = await workerAddresses(
      admin,
      organisationId,
      change.worker_id,
      change.workers.email,
      change.created_at,
    );
    let sent = 0;
    for (const to of addresses) {
      try {
        await sendBankChangeApprovedEmail({
          to,
          changeId: change.id,
          organisationName: change.organisations.name,
          workerName: workerName(change.workers),
          last4: change.bank_account_last4,
          at: formatDateTime(change.applies_after),
        });
        sent += 1;
      } catch (sendError) {
        logFailure("bank_change_approved_email_failed", sendError);
      }
    }
    return sent;
  } catch (error) {
    logFailure("bank_change_approved_email_failed", error);
    return 0;
  }
}

/**
 * Tells workers whose change has applied and who have not been told yet, at every address in
 * `workerAddresses`. A change is marked as notified (applied_notified_at) only after its emails
 * went, so a failed send is tried again by the next sweep (the approvals page, the worker page
 * or the daily cron route). Sends carry an idempotency key per change and address, so two
 * sweeps at once still send each email once. A send that can never work (an address or name
 * the email checks refuse) is not retried, and after APPLIED_NOTICE_RETRY_DAYS the sweep gives
 * up on the rest, logging each failure. `organisationId` null sweeps every organisation (the
 * cron route only).
 */
export async function sendAppliedBankChangeNotices(organisationId: string | null): Promise<number> {
  try {
    const admin = createAdminSupabase();
    let query = admin
      .from("bank_detail_changes")
      .select(CHANGE_COLUMNS)
      .eq("status", "applied")
      .is("applied_notified_at", null)
      .order("applied_at")
      .limit(200);
    if (organisationId) query = query.eq("organisation_id", organisationId);
    const { data: due, error } = await query;
    if (error) throw new Error(`Could not read applied bank changes: ${error.code}`);

    let sent = 0;
    for (const change of due ?? []) {
      if (!change.workers || !change.organisations || !change.applies_after) continue;
      let delivered = true;
      try {
        const addresses = await workerAddresses(
          admin,
          change.organisation_id,
          change.worker_id,
          change.workers.email,
          change.created_at,
        );
        for (const to of addresses) {
          try {
            await sendBankChangeAppliedEmail({
              to,
              changeId: change.id,
              organisationName: change.organisations.name,
              workerName: workerName(change.workers),
              last4: change.bank_account_last4,
              at: formatDateTime(change.applies_after),
            });
            sent += 1;
          } catch (sendError) {
            logFailure("bank_change_applied_email_failed", sendError);
            // Bad input never becomes good: don't retry it forever.
            if (!(sendError instanceof z.ZodError)) delivered = false;
          }
        }
      } catch (readError) {
        logFailure("bank_change_applied_notice_failed", readError);
        delivered = false;
      }

      const appliedAt = Date.parse(change.applied_at ?? change.applies_after);
      const givenUp = !delivered && Date.now() - appliedAt > APPLIED_NOTICE_RETRY_DAYS * DAY;
      if (!delivered && !givenUp) continue;
      const { error: markError } = await admin
        .from("bank_detail_changes")
        .update({ applied_notified_at: new Date().toISOString() })
        .eq("id", change.id)
        .eq("status", "applied")
        .is("applied_notified_at", null);
      if (markError) logFailure("bank_change_applied_mark_failed", markError);
    }
    return sent;
  } catch (error) {
    logFailure("bank_change_applied_notice_failed", error);
    return 0;
  }
}

/**
 * The scheduled job (daily cron route): applies every change whose hold has ended, in case the
 * pg_cron job is not running, then sends the "applied" emails, including any that failed before.
 */
export async function runBankChangeJob(): Promise<{ applied: number; notified: number }> {
  let applied = 0;
  try {
    const admin = createAdminSupabase();
    // No signed-in user: the database allows every organisation (null) for the secret key only.
    const { data, error } = await admin.rpc("apply_due_bank_detail_changes", {
      p_organisation_id: null as unknown as string,
    });
    if (error) throw new Error(`Could not apply bank changes: ${error.code}`);
    applied = data ?? 0;
  } catch (error) {
    logFailure("bank_change_apply_job_failed", error);
  }
  const notified = await sendAppliedBankChangeNotices(null);
  return { applied, notified };
}
