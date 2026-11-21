import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { todayIn } from "@/lib/dates";
import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { formatDayCount } from "@/lib/leave/days";
import { formatLeaveRange } from "@/lib/leave/requests";
import { emailAppUrl } from "@/server/email/config";
import { sendEmail } from "@/server/email/send";
import { emailDisplayName } from "@/server/email/team";
import { LeaveRequestEmail, leaveRequestSubject } from "@/server/email/templates/leave-request";
import { createAdminSupabase } from "@/server/supabase/admin";
import { notifyWorker } from "@/server/workforce/notify";

/**
 * Leave notices (slice 4.4). Rule 8: email or the in-app inbox only.
 *
 * - Managers have no inbox yet, so the line manager is emailed a new request and HR is emailed
 *   when step 1 approves. One claim per request and step (public.claim_manager_email), counted
 *   against the shared caps with the worker inbox emails (30 per company, 80 overall a day). Past
 *   a cap nothing is sent; the request still shows on /app/leave.
 * - The worker gets an inbox item, and an email within the caps, at each decision and when HR
 *   cancels approved leave (notifyWorker).
 *
 * Runs after the change is saved (from `after()`), with the secret key because manager addresses
 * live in Supabase Auth. Each call is scoped to one organisation and one request, both from the
 * saved change, never from request input. Never undoes the change; logs error names only.
 */

type Admin = ReturnType<typeof createAdminSupabase>;

const MAX_RECIPIENTS = 5;

function logFailure(what: string, error: unknown): void {
  console.error(`people.${what}:`, error instanceof Error ? error.name : "unknown");
}

interface RequestFacts {
  id: string;
  workerId: string;
  workerName: string;
  firstName: string;
  leaveTypeName: string;
  counting: "working_days" | "calendar_days";
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  lineManagerMembershipId: string | null;
  lineManagerWorkerId: string | null;
  organisationName: string | null;
}

async function loadFacts(
  admin: Admin,
  organisationId: string,
  requestId: string,
): Promise<RequestFacts | null> {
  const { data, error } = await admin
    .from("leave_requests")
    .select(
      "id, worker_id, start_date, end_date, days, status, leave_types ( name, counting ), workers!leave_requests_worker_fkey ( first_name, last_name, line_manager_membership_id, line_manager_worker_id ), organisations ( name )",
    )
    .eq("organisation_id", organisationId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the leave request (${error.code})`);
  if (!data || !data.workers) return null;
  return {
    id: data.id,
    workerId: data.worker_id,
    workerName: `${data.workers.first_name} ${data.workers.last_name}`.trim(),
    firstName: data.workers.first_name,
    leaveTypeName: data.leave_types?.name ?? "Leave",
    counting: data.leave_types?.counting === "calendar_days" ? "calendar_days" : "working_days",
    startDate: data.start_date,
    endDate: data.end_date,
    days: data.days,
    status: data.status,
    lineManagerMembershipId: data.workers.line_manager_membership_id,
    lineManagerWorkerId: data.workers.line_manager_worker_id,
    organisationName: data.organisations?.name ?? null,
  };
}

/** The logins to email for a step, the worker's own login never among them. */
async function recipients(
  admin: Admin,
  organisationId: string,
  facts: RequestFacts,
  step: "line_manager" | "hr",
): Promise<string[]> {
  const { data, error } = await admin
    .from("memberships")
    .select("id, user_id, role, worker_id")
    .eq("organisation_id", organisationId)
    .in("role", ["owner", "admin", "hr", "ops_manager", "line_manager"]);
  if (error) throw new Error(`Could not read managers (${error.code})`);
  const members = (data ?? []).filter((m) => m.worker_id !== facts.workerId);
  const byRole = (...roles: string[]) =>
    members.filter((m) => roles.includes(m.role)).map((m) => m.user_id);
  let users: string[];
  if (step === "line_manager") {
    const managers = members
      .filter(
        (m) =>
          m.role === "line_manager" &&
          (m.id === facts.lineManagerMembershipId ||
            (m.worker_id !== null && m.worker_id === facts.lineManagerWorkerId)),
      )
      .map((m) => m.user_id);
    // No line manager: an owner, admin or ops_manager decides step 1 (decision 6).
    users = managers.length > 0 ? managers : byRole("ops_manager");
    if (users.length === 0) users = byRole("admin", "owner");
  } else {
    users = byRole("hr");
    if (users.length === 0) users = byRole("admin", "owner");
  }
  return [...new Set(users)].slice(0, MAX_RECIPIENTS);
}

/**
 * The worker's line manager when it is a worker-supervisor (slice 4.7b): a worker login on the
 * worker's line_manager_worker_id whose worker record is still employed (the same rule as
 * private.leave_has_line_manager). Null otherwise.
 */
async function supervisorWorkerId(
  admin: Admin,
  organisationId: string,
  facts: RequestFacts,
): Promise<string | null> {
  const lmWorker = facts.lineManagerWorkerId;
  if (!lmWorker || lmWorker === facts.workerId) return null;
  const login = await admin
    .from("memberships")
    .select("role")
    .eq("organisation_id", organisationId)
    .eq("worker_id", lmWorker)
    .maybeSingle();
  if (login.error) throw new Error(`Could not read the line manager (${login.error.code})`);
  if (login.data?.role !== "worker") return null;
  const record = await admin
    .from("workers")
    .select("status, end_date")
    .eq("organisation_id", organisationId)
    .eq("id", lmWorker)
    .maybeSingle();
  if (record.error) throw new Error(`Could not read the line manager (${record.error.code})`);
  if (!record.data || record.data.status !== "active") return null;
  if (record.data.end_date) {
    // The company's own calendar day, as private.org_today uses in SQL.
    const org = await admin
      .from("organisations")
      .select("timezone")
      .eq("id", organisationId)
      .maybeSingle();
    if (org.error) throw new Error(`Could not read the company (${org.error.code})`);
    if (record.data.end_date < todayIn(org.data?.timezone ?? "Africa/Lagos")) return null;
  }
  return lmWorker;
}

/**
 * Emails the managers who decide the next step of a request: the line manager after the worker
 * asks, HR after step 1 approves. Returns how many emails went.
 */
export async function notifyLeaveDeciders(
  organisationId: string,
  requestId: string,
  step: "line_manager" | "hr",
): Promise<number> {
  try {
    z.uuid().parse(organisationId);
    z.uuid().parse(requestId);
    const admin = createAdminSupabase({ channel: "system" });
    const facts = await loadFacts(admin, organisationId, requestId);
    const waiting = step === "line_manager" ? "pending_line_manager" : "pending_hr";
    if (!facts || facts.status !== waiting) return 0;

    // A worker-supervisor decides step 1 from /m/team (slice 4.7b): they have an inbox.
    if (step === "line_manager") {
      const supervisor = await supervisorWorkerId(admin, organisationId, facts);
      if (supervisor) {
        await notifyWorker(organisationId, supervisor, {
          kind: "leave_step1",
          title: `${emailDisplayName(facts.workerName)} asked for leave`,
          body: `${emailDisplayName(facts.leaveTypeName)}: ${formatDayCount(facts.days, facts.counting)}, ${formatLeaveRange(facts.startDate, facts.endDate)}.\nOpen My team to approve or decline.`,
          link: "/m/team",
        });
        return 1;
      }
    }

    const addresses: string[] = [];
    for (const userId of await recipients(admin, organisationId, facts, step)) {
      const { data: user } = await admin.auth.admin.getUserById(userId);
      const to = user.user?.email;
      if (to && user.user?.email_confirmed_at && z.email().safeParse(to).success) addresses.push(to);
    }
    if (addresses.length === 0) return 0;

    const claim = await admin.rpc("claim_manager_email", {
      p_organisation_id: organisationId,
      p_kind: step === "line_manager" ? "leave_line_manager" : "leave_hr",
      p_ref_id: requestId,
      p_recipients: addresses.length,
      p_org_cap: INBOX_EMAIL_CAPS.perCompany,
      p_global_cap: INBOX_EMAIL_CAPS.overall,
    });
    if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
    if (!claim.data) return 0;

    const appUrl = emailAppUrl();
    const workerName = emailDisplayName(facts.workerName);
    const summary = `${formatDayCount(facts.days, facts.counting)}, ${formatLeaveRange(facts.startDate, facts.endDate)}`;
    let sent = 0;
    for (const to of addresses) {
      try {
        await sendEmail({
          to,
          subject: leaveRequestSubject(step, workerName),
          react: createElement(LeaveRequestEmail, {
            step,
            organisationName: emailDisplayName(facts.organisationName),
            workerName,
            leaveTypeName: emailDisplayName(facts.leaveTypeName),
            summary,
            openUrl: `${appUrl}/app/leave/${facts.id}`,
            appUrl,
          }),
          tags: [{ name: "type", value: `leave_${step}` }],
          idempotencyKey: `leave-${step}/${facts.id}/${addresses.indexOf(to)}`,
        });
        sent += 1;
      } catch (error) {
        logFailure("leave_decider_email_failed", error);
      }
    }
    return sent;
  } catch (error) {
    logFailure("leave_decider_notice_failed", error);
    return 0;
  }
}

export type WorkerLeaveEvent =
  | "line_manager_approved"
  | "line_manager_declined"
  | "hr_approved"
  | "hr_declined"
  | "cancelled_by_hr";

/** Tells the worker what happened to their request, by inbox and (within the caps) email. */
export async function notifyWorkerOfLeave(
  organisationId: string,
  requestId: string,
  event: WorkerLeaveEvent,
  extra: { balanceAfter?: number; returned?: number } = {},
): Promise<void> {
  try {
    const admin = createAdminSupabase({ channel: "system" });
    const facts = await loadFacts(admin, organisationId, requestId);
    if (!facts) return;
    const range = formatLeaveRange(facts.startDate, facts.endDate);
    const type = facts.leaveTypeName;
    const count = formatDayCount(facts.days, facts.counting);
    const lower = type.toLowerCase();
    const messages: Record<WorkerLeaveEvent, { title: string; body: string }> = {
      line_manager_approved: {
        title: `${type} leave: your manager approved`,
        body: `Your line manager approved ${count} of ${lower} leave, ${range}. HR decides next. Your balance changes when HR approves.`,
      },
      line_manager_declined: {
        title: `${type} leave declined`,
        body: `Your line manager declined ${lower} leave for ${range}. Open Leave in the app to see why.`,
      },
      hr_approved: {
        title: `${type} leave approved`,
        body:
          `HR approved ${count} of ${lower} leave, ${range}.` +
          (extra.balanceAfter !== undefined
            ? ` ${extra.balanceAfter} ${extra.balanceAfter === 1 ? "day" : "days"} of ${lower} leave left this year.`
            : "") +
          " Your manager arranges cover for your shifts.",
      },
      hr_declined: {
        title: `${type} leave declined`,
        body: `HR declined ${lower} leave for ${range}. Open Leave in the app to see why.`,
      },
      cancelled_by_hr: {
        title: `${type} leave cancelled`,
        body:
          `HR cancelled your ${lower} leave for ${range}.` +
          (extra.returned ? ` ${extra.returned} ${extra.returned === 1 ? "day is" : "days are"} back in your balance.` : "") +
          " Open Leave in the app to see why.",
      },
    };
    await notifyWorker(organisationId, facts.workerId, {
      kind: "leave",
      ...messages[event],
      link: "/m/leave",
    });
  } catch (error) {
    logFailure("leave_worker_notice_failed", error);
  }
}
