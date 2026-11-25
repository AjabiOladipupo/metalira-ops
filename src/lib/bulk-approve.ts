/**
 * Bulk actions on the lists (slice U.2): why an item is skipped, in words, and the preview's
 * summary line ("3 will be approved, 2 skipped: 1 your own, 1 flagged"). Pure, so the screens,
 * the capability previews and the unit tests share it. Skipping is not failing: the run approves
 * what passes every single-approval check and lists the rest with the reason.
 */

import { CLEAN_REFUSAL_TEXT, type CleanRefusal } from "@/lib/timesheets/approval";

/** Why public.bulk_approve_leave skipped a request (migration 20261122270000_list_bulk). */
export type LeaveSkipCode =
  | "not_found"
  | "own"
  | "not_yours"
  | "decided"
  | "certificate"
  | "recount"
  | "pay_below_service"
  | "refused";

export const LEAVE_SKIP_TEXT: Record<LeaveSkipCode, string> = {
  not_found: "Not in your list",
  own: "Your own leave",
  not_yours: "Not yours to decide",
  decided: "Not waiting for a decision",
  certificate: "Certificate not seen yet: open it to tick Certificate seen",
  recount: "Working days changed since the request: open it to check",
  pay_below_service: "Service below what this leave's pay needs: open it to decide",
  refused: "Couldn't be approved: open it to decide",
};

const LEAVE_CODES = Object.keys(LEAVE_SKIP_TEXT) as LeaveSkipCode[];

export function leaveSkipCode(value: unknown): LeaveSkipCode {
  return LEAVE_CODES.find((c) => c === value) ?? "refused";
}

/**
 * The reason shown for a skipped request: the single decision's own words when it refused one
 * (the balance, say), with the day count for a recount, else the code's text.
 */
export function leaveSkipReason(code: LeaveSkipCode, detail: string | null): string {
  if ((code === "refused" || code === "recount") && detail) {
    return code === "recount" ? `${LEAVE_SKIP_TEXT.recount}. ${detail}` : detail;
  }
  return LEAVE_SKIP_TEXT[code];
}

/** Why "Approve selected" skipped a timesheet day (approve_clean_timesheet_lines' codes). */
export const TIMESHEET_SKIP_TEXT: Record<CleanRefusal, string> = {
  ...CLEAN_REFUSAL_TEXT,
  not_found: "Not in your list any more",
  flagged: "Flagged: open the day to decide",
  needs_review: "Time needs checking: open the day to decide",
};

/** Why a bulk invite resend or cancel skipped a worker (bulk_*_worker_invites' codes). */
export type InviteSkipCode =
  | "left"
  | "no_email"
  | "not_invited"
  | "signed_up"
  | "resent_today"
  | "cap"
  | "not_claimed"
  | "not_sent"
  | "no_open_invite"
  | "expired";

export const INVITE_SKIP_TEXT: Record<InviteSkipCode, string> = {
  left: "Has left the company",
  no_email: "No email address: print a sheet instead",
  not_invited: "Not invited yet: use Email invites",
  signed_up: "Already signed up",
  resent_today: "Already resent today: print a sheet or try tomorrow",
  cap: "Today's email limit is reached: print a sheet or try tomorrow",
  not_claimed: "Not resent: preview again",
  not_sent: "Link not sent: print a sheet or try tomorrow. Their earlier link still works",
  no_open_invite: "No open invite to cancel",
  expired: "The invite already expired",
};

const INVITE_CODES = Object.keys(INVITE_SKIP_TEXT) as InviteSkipCode[];

export function inviteSkipCode(value: unknown): InviteSkipCode | null {
  return INVITE_CODES.find((c) => c === value) ?? null;
}

/**
 * A ticked row the confirm left alone because its preview skipped it (security review M1): the
 * confirm acts only on what the preview said it would.
 */
export const NOT_IN_PREVIEW = "Skipped in the preview: preview again to include it";

const count = (n: number) => n.toLocaleString("en-NG");

/**
 * "3 will be approved, 2 skipped: 1 your own leave, 1 not yours to decide". Reasons are grouped
 * and counted, most common first; `done` words the line once the run has happened.
 */
export function bulkSummary(
  passing: number,
  skippedReasons: readonly string[],
  options: { verb: string; done?: boolean } = { verb: "approved" },
): string {
  const head = options.done
    ? `${count(passing)} ${options.verb}`
    : `${count(passing)} will be ${options.verb}`;
  if (skippedReasons.length === 0) return `${head}.`;
  const groups = new Map<string, number>();
  for (const reason of skippedReasons) groups.set(reason, (groups.get(reason) ?? 0) + 1);
  const parts = [...groups]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${count(n)} ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
  return `${head}, ${count(skippedReasons.length)} skipped: ${parts.join("; ")}.`;
}
