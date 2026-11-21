import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { formatLeaveRange } from "@/lib/leave/requests";
import { formatOpenedAtSites, formatOpenedShifts, type OpenedShift } from "@/lib/leave/roster";
import { mondayOf } from "@/lib/roster";
import { emailAppUrl } from "@/server/email/config";
import { sendEmail } from "@/server/email/send";
import { emailDisplayName } from "@/server/email/team";
import { LeaveCoverEmail, leaveCoverSubject } from "@/server/email/templates/leave-cover";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * "Ops is told" (slice 4.5, owner decision 8). When HR's approval opened shifts, one email goes to
 * the company's ops managers (owner or admin when there is none), naming how many shifts opened
 * and at which sites, with a link to the roster. Ops managers aren't tied to sites, so every ops
 * manager of the company counts as an ops manager of the affected sites.
 *
 * Inside the shared caps: one claim per request (public.claim_manager_email, kind `leave_cover`),
 * counted with the worker inbox emails (30 per company, 80 overall a day). Past a cap nothing is
 * sent; the shifts still show in the Uncovered tray. Managers have no inbox yet.
 *
 * Runs after the approval is saved (from `after()`), with the secret key because manager addresses
 * live in Supabase Auth. The organisation and request come from the saved change, and the shifts
 * are read back from the database (assignments this approval removed for that worker in the
 * request's range), never from request input. Never undoes anything; logs error names only.
 */

type Admin = ReturnType<typeof createAdminSupabase>;

const MAX_RECIPIENTS = 5;

function logFailure(what: string, error: unknown): void {
  console.error(`people.${what}:`, error instanceof Error ? error.name : "unknown");
}

/** The shifts approved leave opened for this request's worker and dates, with names. */
async function openedShifts(
  admin: Admin,
  organisationId: string,
  workerId: string,
  from: string,
  to: string,
  decidedAt: string,
): Promise<OpenedShift[]> {
  const { data: rows, error } = await admin
    .from("shift_assignments")
    .select("id, shift_id, site_id, shift_date, starts_at, ends_at")
    .eq("organisation_id", organisationId)
    .eq("worker_id", workerId)
    .eq("status", "removed")
    .eq("removed_reason", "on_leave")
    .gte("shift_date", from)
    .lte("shift_date", to)
    // Removed by this approval (same transaction, so the same now()), not an earlier one.
    .gte("removed_at", decidedAt)
    .order("starts_at")
    .limit(400);
  if (error) throw new Error(`Could not read the opened shifts (${error.code})`);
  if (!rows || rows.length === 0) return [];
  const [shifts, sites] = await Promise.all([
    admin
      .from("shifts")
      .select("id, post_id")
      .eq("organisation_id", organisationId)
      .in("id", [...new Set(rows.map((r) => r.shift_id))]),
    admin
      .from("sites")
      .select("id, name")
      .eq("organisation_id", organisationId)
      .in("id", [...new Set(rows.map((r) => r.site_id))]),
  ]);
  if (shifts.error) throw new Error(`Could not read shifts (${shifts.error.code})`);
  if (sites.error) throw new Error(`Could not read sites (${sites.error.code})`);
  const postOf = new Map((shifts.data ?? []).map((s) => [s.id, s.post_id] as const));
  const posts = await admin
    .from("posts")
    .select("id, name")
    .eq("organisation_id", organisationId)
    .in("id", [...new Set(postOf.values())]);
  if (posts.error) throw new Error(`Could not read posts (${posts.error.code})`);
  const postName = new Map((posts.data ?? []).map((p) => [p.id, p.name] as const));
  const siteName = new Map((sites.data ?? []).map((s) => [s.id, s.name] as const));
  return rows.map((r) => {
    const postId = postOf.get(r.shift_id) ?? "";
    return {
      assignmentId: r.id,
      shiftDate: r.shift_date,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      siteId: r.site_id,
      siteName: emailDisplayName(siteName.get(r.site_id) ?? null) ?? "a site",
      postId,
      postName: emailDisplayName(postName.get(postId) ?? null) ?? "A post",
    };
  });
}

/** Ops managers' logins (owner or admin when there is none), never the worker's own. */
async function recipients(
  admin: Admin,
  organisationId: string,
  workerId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from("memberships")
    .select("user_id, role, worker_id")
    .eq("organisation_id", organisationId)
    .in("role", ["owner", "admin", "ops_manager"]);
  if (error) throw new Error(`Could not read managers (${error.code})`);
  const members = (data ?? []).filter((m) => m.worker_id !== workerId);
  let users = members.filter((m) => m.role === "ops_manager").map((m) => m.user_id);
  if (users.length === 0) {
    users = members.filter((m) => m.role === "admin" || m.role === "owner").map((m) => m.user_id);
  }
  return [...new Set(users)].slice(0, MAX_RECIPIENTS);
}

/**
 * Emails ops about the shifts HR's approval of one leave request opened. Returns how many emails
 * went (0 when nothing opened, the request isn't approved, nobody has a confirmed address, or the
 * caps are reached).
 */
export async function notifyOpsOfOpenedShifts(
  organisationId: string,
  requestId: string,
): Promise<number> {
  try {
    z.uuid().parse(organisationId);
    z.uuid().parse(requestId);
    const admin = createAdminSupabase({ channel: "system" });
    const { data: request, error } = await admin
      .from("leave_requests")
      .select(
        "id, worker_id, start_date, end_date, status, decided_at, workers!leave_requests_worker_fkey ( first_name, last_name ), organisations ( name )",
      )
      .eq("organisation_id", organisationId)
      .eq("id", requestId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the leave request (${error.code})`);
    if (!request || request.status !== "approved" || !request.decided_at) return 0;

    const opened = await openedShifts(
      admin,
      organisationId,
      request.worker_id,
      request.start_date,
      request.end_date,
      request.decided_at,
    );
    if (opened.length === 0) return 0;

    const addresses: string[] = [];
    for (const userId of await recipients(admin, organisationId, request.worker_id)) {
      const { data: user } = await admin.auth.admin.getUserById(userId);
      const to = user.user?.email;
      if (to && user.user?.email_confirmed_at && z.email().safeParse(to).success)
        addresses.push(to);
    }
    if (addresses.length === 0) return 0;

    const claim = await admin.rpc("claim_manager_email", {
      p_organisation_id: organisationId,
      p_kind: "leave_cover",
      p_ref_id: requestId,
      p_recipients: addresses.length,
      p_org_cap: INBOX_EMAIL_CAPS.perCompany,
      p_global_cap: INBOX_EMAIL_CAPS.overall,
    });
    if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
    if (!claim.data) return 0;

    const appUrl = emailAppUrl();
    const workerName = emailDisplayName(
      request.workers ? `${request.workers.first_name} ${request.workers.last_name}`.trim() : null,
    );
    const first = opened[0]!;
    const rosterUrl = `${appUrl}/app/roster?site=${first.siteId}&week=${mondayOf(first.shiftDate)}`;
    const detail = formatOpenedShifts(opened).replace(/^Opens [^:]+: /, "");
    let sent = 0;
    for (const [i, to] of addresses.entries()) {
      try {
        await sendEmail({
          to,
          subject: leaveCoverSubject(opened.length, workerName),
          react: createElement(LeaveCoverEmail, {
            organisationName: emailDisplayName(request.organisations?.name ?? null),
            workerName,
            range: formatLeaveRange(request.start_date, request.end_date),
            opened: formatOpenedAtSites(opened),
            detail,
            rosterUrl,
            appUrl,
          }),
          tags: [{ name: "type", value: "leave_cover" }],
          idempotencyKey: `leave-cover/${requestId}/${i}`,
        });
        sent += 1;
      } catch (error) {
        logFailure("leave_cover_email_failed", error);
      }
    }
    return sent;
  } catch (error) {
    logFailure("leave_cover_notice_failed", error);
    return 0;
  }
}
