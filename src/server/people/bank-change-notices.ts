import "server-only";

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
 */

type Admin = ReturnType<typeof createAdminSupabase>;

function logFailure(what: string, error: unknown): void {
  console.error(`people.${what}:`, error instanceof Error ? error.name : "unknown");
}

const CHANGE_COLUMNS =
  "id, organisation_id, worker_id, requested_by, raised_by_worker, status, bank_account_last4, applies_after, applied_at, workers!bank_detail_changes_worker_fkey ( first_name, last_name, staff_id, email ), organisations ( name )";

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

/** Tells the worker (when they have an email address) that their change was approved. */
export async function notifyWorkerOfBankChangeApproval(
  organisationId: string,
  changeId: string,
): Promise<boolean> {
  try {
    const admin = createAdminSupabase();
    const change = await loadChange(admin, organisationId, changeId);
    if (
      change?.status !== "approved" ||
      !change.applies_after ||
      !change.workers?.email ||
      !change.organisations
    ) {
      return false;
    }
    await sendBankChangeApprovedEmail({
      to: change.workers.email,
      changeId: change.id,
      organisationName: change.organisations.name,
      workerName: workerName(change.workers),
      last4: change.bank_account_last4,
      at: formatDateTime(change.applies_after),
    });
    return true;
  } catch (error) {
    logFailure("bank_change_approved_email_failed", error);
    return false;
  }
}

/**
 * Tells workers whose change has applied and who have not been told yet. Each change is claimed
 * (applied_notified_at set) before its email goes, so two sweeps never send the same notice; a
 * send that fails after the claim is logged and not retried. `organisationId` null sweeps every
 * organisation (the cron route only).
 */
export async function sendAppliedBankChangeNotices(organisationId: string | null): Promise<number> {
  try {
    const admin = createAdminSupabase();
    let claim = admin
      .from("bank_detail_changes")
      .update({ applied_notified_at: new Date().toISOString() })
      .eq("status", "applied")
      .is("applied_notified_at", null);
    if (organisationId) claim = claim.eq("organisation_id", organisationId);
    const { data: claimed, error } = await claim.select(CHANGE_COLUMNS);
    if (error) throw new Error(`Could not claim applied bank changes: ${error.code}`);

    let sent = 0;
    for (const change of claimed ?? []) {
      if (!change.workers?.email || !change.organisations || !change.applies_after) continue;
      try {
        await sendBankChangeAppliedEmail({
          to: change.workers.email,
          changeId: change.id,
          organisationName: change.organisations.name,
          workerName: workerName(change.workers),
          last4: change.bank_account_last4,
          at: formatDateTime(change.applies_after),
        });
        sent += 1;
      } catch (sendError) {
        logFailure("bank_change_applied_email_failed", sendError);
      }
    }
    return sent;
  } catch (error) {
    logFailure("bank_change_applied_notice_failed", error);
    return 0;
  }
}

/**
 * The scheduled job (daily cron route): applies every change whose hold has ended, in case the
 * pg_cron job is not running, then sends the "applied" emails.
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
