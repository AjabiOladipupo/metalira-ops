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
 * Emails about the company bank account (slice 2.3):
 * - requested: approvers (owner and finance, never the requester) when a request is waiting;
 * - approved: every owner and finance user when a second person approves, so a change nobody
 *   asked for can be stopped during the 72-hour hold;
 * - applied: every owner and finance user when an account takes effect (the first account during
 *   setup takes effect at once, so it gets only this one).
 *
 * All three are sweeps over the rows themselves, not hooks on the app's actions: a request or an
 * approval made straight against the Data API is announced just the same. Each row is marked
 * (`requested_notified_at`, `approved_notified_at`, `applied_notified_at`; only the secret key can
 * write them, and the trigger allows each once, for its own status) only after its emails went,
 * so a failed send is retried by the next sweep for up to NOTICE_RETRY_DAYS. Sends carry an
 * idempotency key per row, kind and recipient, so overlapping sweeps send each email once.
 *
 * Sweeps run after every change in the app (`after()`), when the bank account page loads, and
 * daily (`/api/cron/bank-detail-changes`; Vercel Hobby allows daily crons only), so an approval
 * made outside the app is announced within a day, well inside the 72-hour hold. They read
 * with the secret key because addresses live in Supabase Auth. A failed send is logged by error
 * name only, never with an address, a name or digits.
 */

type Admin = ReturnType<typeof createAdminSupabase>;

const DAY = 86_400_000;
/** How long a failed email is retried before the sweep gives up on it. */
export const NOTICE_RETRY_DAYS = 7;

function logFailure(what: string, error: unknown): void {
  console.error(`billing.${what}:`, error instanceof Error ? error.name : "unknown");
}

const COLUMNS =
  "id, organisation_id, requested_by, status, bank_name, bank_account_last4, created_at, decided_at, applies_after, activated_at, organisations ( name )";

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

type Kind = "requested" | "approved" | "applied";

const KINDS: Record<
  Kind,
  {
    statuses: ("pending" | "approved" | "active" | "retired")[];
    column: "requested_notified_at" | "approved_notified_at" | "applied_notified_at";
  }
> = {
  requested: { statuses: ["pending"], column: "requested_notified_at" },
  approved: { statuses: ["approved"], column: "approved_notified_at" },
  // A replaced account nobody was told about is marked without an email.
  applied: { statuses: ["active", "retired"], column: "applied_notified_at" },
};

function markPatch(kind: Kind, at: string) {
  switch (kind) {
    case "requested":
      return { requested_notified_at: at };
    case "approved":
      return { approved_notified_at: at };
    case "applied":
      return { applied_notified_at: at };
  }
}

/**
 * Sends one kind of email for every row that needs it and marks each row once its emails went.
 * `organisationId` null sweeps every organisation (cron routes only). Returns emails sent.
 */
async function sweep(kind: Kind, organisationId: string | null): Promise<number> {
  const { statuses, column } = KINDS[kind];
  try {
    const admin = createAdminSupabase();
    let query = admin
      .from("organisation_bank_accounts")
      .select(COLUMNS)
      .in("status", statuses)
      .is(column, null)
      .order("created_at")
      .limit(200);
    if (organisationId) query = query.eq("organisation_id", organisationId);
    const { data: due, error } = await query;
    if (error) throw new Error(`Could not read bank accounts: ${error.code}`);

    let sent = 0;
    for (const row of due ?? []) {
      if (!row.organisations) continue;
      let delivered = true;
      try {
        const common = {
          accountId: row.id,
          organisationName: row.organisations.name,
          bankName: row.bank_name,
          last4: row.bank_account_last4,
        };
        let send: ((to: { userId: string; email: string }) => Promise<unknown>) | null = null;
        let except: string | null = null;
        if (kind === "requested") {
          const { data: profile } = await admin
            .from("profiles")
            .select("full_name")
            .eq("user_id", row.requested_by)
            .maybeSingle();
          const requesterName = profile?.full_name?.trim() || null;
          except = row.requested_by;
          send = (to) =>
            sendCompanyBankRequestedEmail({
              ...common,
              to: to.email,
              recipientId: to.userId,
              requesterName,
            });
        } else if (kind === "approved" && row.applies_after) {
          const at = formatDateTime(row.applies_after);
          send = (to) =>
            sendCompanyBankApprovedEmail({ ...common, to: to.email, recipientId: to.userId, at });
        } else if (kind === "applied" && row.status === "active" && row.activated_at) {
          const at = formatDateTime(row.activated_at);
          send = (to) =>
            sendCompanyBankAppliedEmail({ ...common, to: to.email, recipientId: to.userId, at });
        }
        if (send) {
          for (const to of await recipients(admin, row.organisation_id, except)) {
            try {
              await send(to);
              sent += 1;
            } catch (sendError) {
              logFailure(`company_bank_${kind}_email_failed`, sendError);
              // Bad input never becomes good: don't retry it forever.
              if (!(sendError instanceof z.ZodError)) delivered = false;
            }
          }
        }
      } catch (readError) {
        logFailure(`company_bank_${kind}_notice_failed`, readError);
        delivered = false;
      }

      const since = Date.parse(
        (kind === "requested" ? row.created_at : (row.decided_at ?? row.created_at)) ?? "",
      );
      const givenUp = !delivered && Date.now() - since > NOTICE_RETRY_DAYS * DAY;
      if (!delivered && !givenUp) continue;
      const { error: markError } = await admin
        .from("organisation_bank_accounts")
        .update(markPatch(kind, new Date().toISOString()))
        .eq("id", row.id)
        .eq("status", row.status)
        .is(column, null);
      if (markError) logFailure(`company_bank_${kind}_mark_failed`, markError);
    }
    return sent;
  } catch (error) {
    logFailure(`company_bank_${kind}_notice_failed`, error);
    return 0;
  }
}

/**
 * Every company bank account email that is due, for one organisation or (null, cron routes
 * only) all of them. Safe to call any number of times.
 */
export async function sendCompanyBankNotices(
  organisationId: string | null,
): Promise<{ requested: number; approved: number; applied: number }> {
  const requested = await sweep("requested", organisationId);
  const approved = await sweep("approved", organisationId);
  const applied = await sweep("applied", organisationId);
  return { requested, approved, applied };
}

/**
 * The scheduled job (daily, with the bank-change route): applies every
 * account whose hold has ended, in case pg_cron is not running, then sends every email due.
 */
export async function runCompanyBankJob(): Promise<{
  applied: number;
  notified: { requested: number; approved: number; applied: number };
}> {
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
  const notified = await sendCompanyBankNotices(null);
  return { applied, notified };
}
