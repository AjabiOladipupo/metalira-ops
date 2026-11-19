import "server-only";

import { z } from "zod";

import { COMPANY_BANK_APPROVERS } from "@/lib/company-bank";
import { formatDateTime } from "@/lib/dates";
import {
  sendCompanyBankAppliedEmail,
  sendCompanyBankApprovedEmail,
  sendCompanyBankRequestedEmail,
} from "@/server/email/company-bank";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * Emails about the company bank account (slice 2.3): approvers (owner and finance, never the
 * requester) when a request is raised; every owner and finance user when it is approved and when
 * it takes effect (the first account during setup takes effect at once, so it gets the second
 * kind only). They run after the change is saved (`after()` or the daily cron route) and never
 * undo it. A failed send is logged by error name only, never with an address, a name or digits.
 *
 * They read with the secret key because addresses live in Supabase Auth, which no signed-in user
 * can read. Every query is scoped to one organisation and one account, except the cron sweep,
 * which looks for accounts in use that nobody has been told about yet.
 */

type Admin = ReturnType<typeof createAdminSupabase>;

const DAY = 86_400_000;
/** How long a failed "in use" email is retried before the sweep gives up on it. */
export const APPLIED_NOTICE_RETRY_DAYS = 7;

function logFailure(what: string, error: unknown): void {
  console.error(`billing.${what}:`, error instanceof Error ? error.name : "unknown");
}

const COLUMNS =
  "id, organisation_id, requested_by, status, bank_name, bank_account_last4, applies_after, activated_at, organisations ( name )";

async function loadAccount(admin: Admin, organisationId: string, accountId: string) {
  const { data, error } = await admin
    .from("organisation_bank_accounts")
    .select(COLUMNS)
    .eq("organisation_id", organisationId)
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the bank account: ${error.code}`);
  return data;
}

/** Owner and finance members with a confirmed address, as { userId, email }. */
async function recipients(
  admin: Admin,
  organisationId: string,
  except: string | null,
): Promise<{ userId: string; email: string }[]> {
  const { data, error } = await admin
    .from("memberships")
    .select("user_id")
    .eq("organisation_id", organisationId)
    .in("role", [...COMPANY_BANK_APPROVERS]);
  if (error) throw new Error(`Could not read approvers: ${error.code}`);
  const ids = [...new Set((data ?? []).map((m) => m.user_id))].filter((id) => id !== except);
  const out: { userId: string; email: string }[] = [];
  for (const userId of ids) {
    const { data: user } = await admin.auth.admin.getUserById(userId);
    const email = user.user?.email;
    if (email && user.user?.email_confirmed_at) out.push({ userId, email });
  }
  return out;
}

/** Tells every owner and finance user other than the requester that a request is waiting. */
export async function notifyApproversOfCompanyBank(
  organisationId: string,
  accountId: string,
): Promise<number> {
  try {
    const admin = createAdminSupabase();
    const account = await loadAccount(admin, organisationId, accountId);
    if (account?.status !== "pending" || !account.organisations) return 0;

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("user_id", account.requested_by)
      .maybeSingle();
    const requesterName = profile?.full_name?.trim() || null;

    let sent = 0;
    for (const to of await recipients(admin, organisationId, account.requested_by)) {
      try {
        await sendCompanyBankRequestedEmail({
          to: to.email,
          accountId: account.id,
          recipientId: to.userId,
          organisationName: account.organisations.name,
          requesterName,
          bankName: account.bank_name,
          last4: account.bank_account_last4,
        });
        sent += 1;
      } catch (sendError) {
        logFailure("company_bank_request_email_failed", sendError);
      }
    }
    return sent;
  } catch (error) {
    logFailure("company_bank_request_notice_failed", error);
    return 0;
  }
}

/** Tells every owner and finance user that a second person approved; it applies after the hold. */
export async function notifyCompanyBankApproval(
  organisationId: string,
  accountId: string,
): Promise<number> {
  try {
    const admin = createAdminSupabase();
    const account = await loadAccount(admin, organisationId, accountId);
    if (account?.status !== "approved" || !account.applies_after || !account.organisations) {
      return 0;
    }
    let sent = 0;
    for (const to of await recipients(admin, organisationId, null)) {
      try {
        await sendCompanyBankApprovedEmail({
          to: to.email,
          accountId: account.id,
          recipientId: to.userId,
          organisationName: account.organisations.name,
          bankName: account.bank_name,
          last4: account.bank_account_last4,
          at: formatDateTime(account.applies_after),
        });
        sent += 1;
      } catch (sendError) {
        logFailure("company_bank_approved_email_failed", sendError);
      }
    }
    return sent;
  } catch (error) {
    logFailure("company_bank_approved_notice_failed", error);
    return 0;
  }
}

/**
 * Tells every owner and finance user about accounts now in use that nobody has been told about.
 * An account is marked (applied_notified_at) only after its emails went, so a failed send is
 * tried again by the next sweep (the bank account page or the daily cron route), for up to
 * APPLIED_NOTICE_RETRY_DAYS. Sends carry an idempotency key per account and recipient, so two
 * sweeps at once still send each email once. `organisationId` null sweeps every organisation
 * (the cron route only).
 */
export async function sendAppliedCompanyBankNotices(
  organisationId: string | null,
): Promise<number> {
  try {
    const admin = createAdminSupabase();
    let query = admin
      .from("organisation_bank_accounts")
      .select(COLUMNS)
      .in("status", ["active", "retired"])
      .is("applied_notified_at", null)
      .order("activated_at")
      .limit(200);
    if (organisationId) query = query.eq("organisation_id", organisationId);
    const { data: due, error } = await query;
    if (error) throw new Error(`Could not read accounts in use: ${error.code}`);

    let sent = 0;
    for (const account of due ?? []) {
      if (!account.organisations || !account.activated_at) continue;
      let delivered = true;
      // An account replaced before anyone was told about it needs no "now in use" email.
      if (account.status === "active") {
        try {
          for (const to of await recipients(admin, account.organisation_id, null)) {
            try {
              await sendCompanyBankAppliedEmail({
                to: to.email,
                accountId: account.id,
                recipientId: to.userId,
                organisationName: account.organisations.name,
                bankName: account.bank_name,
                last4: account.bank_account_last4,
                at: formatDateTime(account.activated_at),
              });
              sent += 1;
            } catch (sendError) {
              logFailure("company_bank_applied_email_failed", sendError);
              // Bad input never becomes good: don't retry it forever.
              if (!(sendError instanceof z.ZodError)) delivered = false;
            }
          }
        } catch (readError) {
          logFailure("company_bank_applied_notice_failed", readError);
          delivered = false;
        }
      }

      const givenUp =
        !delivered &&
        Date.now() - Date.parse(account.activated_at) > APPLIED_NOTICE_RETRY_DAYS * DAY;
      if (!delivered && !givenUp) continue;
      const { error: markError } = await admin
        .from("organisation_bank_accounts")
        .update({ applied_notified_at: new Date().toISOString() })
        .eq("id", account.id)
        .eq("status", account.status)
        .is("applied_notified_at", null);
      if (markError) logFailure("company_bank_applied_mark_failed", markError);
    }
    return sent;
  } catch (error) {
    logFailure("company_bank_applied_notice_failed", error);
    return 0;
  }
}

/**
 * The scheduled job (the daily bank-change cron route): applies every account whose hold has
 * ended, in case pg_cron is not running, then sends the "now in use" emails.
 */
export async function runCompanyBankJob(): Promise<{ applied: number; notified: number }> {
  let applied = 0;
  try {
    const admin = createAdminSupabase();
    // No signed-in user: the database allows every organisation (null) for the secret key only.
    const { data, error } = await admin.rpc("apply_due_org_bank_accounts", {
      p_organisation_id: null as unknown as string,
    });
    if (error) throw new Error(`Could not apply bank accounts: ${error.code}`);
    applied = data ?? 0;
  } catch (error) {
    logFailure("company_bank_apply_job_failed", error);
  }
  const notified = await sendAppliedCompanyBankNotices(null);
  return { applied, notified };
}
