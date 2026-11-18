import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { formatDateTime } from "@/lib/dates";
import { COMPANY_WINDOW_MINUTES, COMPANY_WRONG_PIN_CAP } from "@/lib/pin-lockout";
import { sendSignInPausedEmail } from "@/server/email/staff-id";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * The alert when a company reaches its cap on wrong PINs (owner decision, 18 Nov 2026): one email
 * to each owner and HR user with a confirmed address. The database decides when: only the first
 * refused sign-in of a 15-minute window returns the organisation to the server (and writes the
 * worker_auth.company_throttled audit row), so a sustained attack sends at most one alert per
 * company per window. The audit row's id is the idempotency key, so a retry never sends twice.
 * Sent with `after()` from the sign-in action, so sign-in itself never waits for it.
 */

/** Who hears about it. */
export const SIGN_IN_ALERT_ROLES = ["owner", "hr"] as const;

type Admin = SupabaseClient<Database>;

export interface SignInAlertDeps {
  admin: Admin;
  send: typeof sendSignInPausedEmail;
}

/** Sends the alert for the organisation's latest capped window. Returns how many went. */
export async function notifyCompanyThrottled(
  organisationId: string,
  deps?: Partial<SignInAlertDeps>,
): Promise<number> {
  const logFailure = (what: string, error: unknown) =>
    console.error(`worker_auth.${what}:`, error instanceof Error ? error.name : "unknown");
  try {
    const admin = deps?.admin ?? createAdminSupabase();
    const send = deps?.send ?? sendSignInPausedEmail;

    const since = new Date(Date.now() - 2 * COMPANY_WINDOW_MINUTES * 60_000).toISOString();
    const { data: alert, error } = await admin
      .from("audit_log")
      .select("id, after")
      .eq("organisation_id", organisationId)
      .eq("action", "worker_auth.company_throttled")
      .gte("at", since)
      .order("at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Could not read the alert: ${error.code}`);
    if (!alert) return 0;
    const after = (alert.after ?? {}) as { until?: unknown; wrong_pin_cap?: unknown };
    const until = typeof after.until === "string" ? after.until : null;
    if (!until) return 0;
    const cap =
      typeof after.wrong_pin_cap === "number" ? after.wrong_pin_cap : COMPANY_WRONG_PIN_CAP;

    const { data: org } = await admin
      .from("organisations")
      .select("name")
      .eq("id", organisationId)
      .maybeSingle();
    if (!org) return 0;

    const { data: members, error: membersError } = await admin
      .from("memberships")
      .select("user_id")
      .eq("organisation_id", organisationId)
      .in("role", [...SIGN_IN_ALERT_ROLES]);
    if (membersError) throw new Error(`Could not read recipients: ${membersError.code}`);

    let sent = 0;
    for (const member of new Set((members ?? []).map((m) => m.user_id))) {
      try {
        const { data: user } = await admin.auth.admin.getUserById(member);
        const to = user.user?.email;
        if (!to || !user.user?.email_confirmed_at) continue;
        await send({
          to,
          alertId: alert.id,
          recipientId: member,
          organisationName: org.name,
          cap,
          minutes: COMPANY_WINDOW_MINUTES,
          until: formatDateTime(until),
        });
        sent += 1;
      } catch (sendError) {
        logFailure("sign_in_paused_email_failed", sendError);
      }
    }
    return sent;
  } catch (error) {
    logFailure("sign_in_paused_notice_failed", error);
    return 0;
  }
}
