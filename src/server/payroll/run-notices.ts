import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { formatDate } from "@/lib/dates";
import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { formatLeaveRange } from "@/lib/leave/requests";
import { emailAppUrl } from "@/server/email/config";
import { sendEmail } from "@/server/email/send";
import { emailDisplayName } from "@/server/email/team";
import {
  PayrollDecidedEmail,
  payrollDecidedSubject,
} from "@/server/email/templates/payroll-decided";
import {
  PayrollSubmittedEmail,
  payrollSubmittedSubject,
} from "@/server/email/templates/payroll-submitted";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * "Submit emails Finance and the other owners" (slice 5.2). One email per submission to the
 * company's finance members and owners, never the person who submitted, inside the shared caps:
 * one claim per decision (public.claim_manager_email, kind `payroll_submitted`), counted with the
 * worker inbox emails (30 per company, 80 overall a day). Past a cap nothing is sent; the run
 * still shows "Waiting for approval" in the app. Managers have no inbox yet.
 *
 * No amounts in the email: the period, the pay date, the number of workers and who prepared it.
 * Runs after the submission is saved (from `after()`), with the secret key because manager
 * addresses live in Supabase Auth. The run is read back from the database by the decision, never
 * from request input. Never undoes anything; logs error names only.
 */

const MAX_RECIPIENTS = 5;

function logFailure(what: string, error: unknown): void {
  console.error(`payroll.${what}:`, error instanceof Error ? error.name : "unknown");
}

export async function notifyRunSubmitted(
  organisationId: string,
  decisionId: string,
): Promise<number> {
  try {
    z.uuid().parse(organisationId);
    z.uuid().parse(decisionId);
    const admin = createAdminSupabase({ channel: "system" });
    const { data: decision, error } = await admin
      .from("payroll_run_decisions")
      .select("id, run_id, decision, actor_id, worker_count")
      .eq("organisation_id", organisationId)
      .eq("id", decisionId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the decision (${error.code})`);
    if (!decision || decision.decision !== "submitted") return 0;
    const [run, org, members, preparer] = await Promise.all([
      admin
        .from("payroll_runs")
        .select("id, status, period_start, period_end, pay_date")
        .eq("organisation_id", organisationId)
        .eq("id", decision.run_id)
        .maybeSingle(),
      admin.from("organisations").select("name").eq("id", organisationId).maybeSingle(),
      admin
        .from("memberships")
        .select("user_id, role")
        .eq("organisation_id", organisationId)
        .in("role", ["finance", "owner"]),
      admin.from("profiles").select("full_name").eq("user_id", decision.actor_id).maybeSingle(),
    ]);
    if (run.error) throw new Error(`Could not read the run (${run.error.code})`);
    if (members.error) throw new Error(`Could not read managers (${members.error.code})`);
    if (!run.data || run.data.status !== "review") return 0;

    const users = [
      ...new Set(
        (members.data ?? []).map((m) => m.user_id).filter((id) => id !== decision.actor_id),
      ),
    ].slice(0, MAX_RECIPIENTS);
    const addresses: string[] = [];
    for (const userId of users) {
      const { data: user } = await admin.auth.admin.getUserById(userId);
      const to = user.user?.email;
      if (to && user.user?.email_confirmed_at && z.email().safeParse(to).success)
        addresses.push(to);
    }
    if (addresses.length === 0) return 0;

    const claim = await admin.rpc("claim_manager_email", {
      p_organisation_id: organisationId,
      p_kind: "payroll_submitted",
      p_ref_id: decisionId,
      p_recipients: addresses.length,
      p_org_cap: INBOX_EMAIL_CAPS.perCompany,
      p_global_cap: INBOX_EMAIL_CAPS.overall,
    });
    if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
    if (!claim.data) return 0;

    const appUrl = emailAppUrl();
    const period = formatLeaveRange(run.data.period_start, run.data.period_end);
    let sent = 0;
    for (const [i, to] of addresses.entries()) {
      try {
        await sendEmail({
          to,
          subject: payrollSubmittedSubject(period),
          react: createElement(PayrollSubmittedEmail, {
            organisationName: emailDisplayName(org.data?.name ?? null),
            period,
            payDate: formatDate(run.data.pay_date),
            workers: decision.worker_count,
            preparerName: emailDisplayName(preparer.data?.full_name ?? null),
            runUrl: `${appUrl}/app/payroll/${run.data.id}`,
            appUrl,
          }),
          tags: [{ name: "type", value: "payroll_submitted" }],
          idempotencyKey: `payroll-submitted/${decisionId}/${i}`,
        });
        sent += 1;
      } catch (e) {
        logFailure("submitted_email_failed", e);
      }
    }
    return sent;
  } catch (e) {
    logFailure("submitted_notice_failed", e);
    return 0;
  }
}

/**
 * "The preparer gets an email on approval or return" (slice 5.3). One email per decision to the
 * person who prepared the run (and the person who submitted it, when that was someone else),
 * never the decider, inside the shared caps (claim_manager_email, kinds `payroll_approved` and
 * `payroll_returned`). No amounts and no reason text. Runs after the decision is saved (from
 * `after()`), with the secret key; the run and decision are read back by id, never from input.
 */
export async function notifyRunDecided(
  organisationId: string,
  decisionId: string,
): Promise<number> {
  try {
    z.uuid().parse(organisationId);
    z.uuid().parse(decisionId);
    const admin = createAdminSupabase({ channel: "system" });
    const { data: decision, error } = await admin
      .from("payroll_run_decisions")
      .select("id, run_id, decision, actor_id, worker_count")
      .eq("organisation_id", organisationId)
      .eq("id", decisionId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the decision (${error.code})`);
    if (!decision || (decision.decision !== "approved" && decision.decision !== "returned")) {
      return 0;
    }
    const kind = decision.decision === "approved" ? "approved" : "returned";
    const [run, org, decider, submitted] = await Promise.all([
      admin
        .from("payroll_runs")
        .select("id, status, period_start, period_end, pay_date, prepared_by")
        .eq("organisation_id", organisationId)
        .eq("id", decision.run_id)
        .maybeSingle(),
      admin.from("organisations").select("name").eq("id", organisationId).maybeSingle(),
      admin.from("profiles").select("full_name").eq("user_id", decision.actor_id).maybeSingle(),
      admin
        .from("payroll_run_decisions")
        .select("actor_id")
        .eq("organisation_id", organisationId)
        .eq("run_id", decision.run_id)
        .eq("decision", "submitted")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (run.error) throw new Error(`Could not read the run (${run.error.code})`);
    if (!run.data) return 0;
    // Still in the state the decision put it in (a later decision sends its own notice).
    if (kind === "approved" ? run.data.status !== "approved" : run.data.status !== "draft")
      return 0;

    const users = [
      ...new Set(
        [run.data.prepared_by, submitted.data?.actor_id ?? null].filter(
          (id): id is string => typeof id === "string" && id !== decision.actor_id,
        ),
      ),
    ].slice(0, 2);
    const addresses: string[] = [];
    for (const userId of users) {
      // Only someone still in the company hears about its payroll.
      const { data: member } = await admin
        .from("memberships")
        .select("user_id")
        .eq("organisation_id", organisationId)
        .eq("user_id", userId)
        .in("role", ["owner", "hr"])
        .limit(1)
        .maybeSingle();
      if (!member) continue;
      const { data: user } = await admin.auth.admin.getUserById(userId);
      const to = user.user?.email;
      if (to && user.user?.email_confirmed_at && z.email().safeParse(to).success)
        addresses.push(to);
    }
    if (addresses.length === 0) return 0;

    const claim = await admin.rpc("claim_manager_email", {
      p_organisation_id: organisationId,
      p_kind: `payroll_${kind}`,
      p_ref_id: decisionId,
      p_recipients: addresses.length,
      p_org_cap: INBOX_EMAIL_CAPS.perCompany,
      p_global_cap: INBOX_EMAIL_CAPS.overall,
    });
    if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
    if (!claim.data) return 0;

    const appUrl = emailAppUrl();
    const period = formatLeaveRange(run.data.period_start, run.data.period_end);
    let sent = 0;
    for (const [i, to] of addresses.entries()) {
      try {
        await sendEmail({
          to,
          subject: payrollDecidedSubject(kind, period),
          react: createElement(PayrollDecidedEmail, {
            decision: kind,
            organisationName: emailDisplayName(org.data?.name ?? null),
            period,
            payDate: formatDate(run.data.pay_date),
            workers: decision.worker_count,
            deciderName: emailDisplayName(decider.data?.full_name ?? null),
            runUrl: `${appUrl}/app/payroll/${run.data.id}`,
            appUrl,
          }),
          tags: [{ name: "type", value: `payroll_${kind}` }],
          idempotencyKey: `payroll-${kind}/${decisionId}/${i}`,
        });
        sent += 1;
      } catch (e) {
        logFailure(`${kind}_email_failed`, e);
      }
    }
    return sent;
  } catch (e) {
    logFailure("decided_notice_failed", e);
    return 0;
  }
}
