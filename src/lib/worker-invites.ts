/**
 * Pure rules for the worker invites screen (/app/people/invites): each worker's sign-in status
 * and the counts in the header. Isomorphic, unit-tested in tests/unit/worker-invites.test.ts.
 */

export type InviteChannel = "email" | "print";

export interface RosterWorker {
  id: string;
  staffId: string;
  firstName: string;
  lastName: string;
  hasEmail: boolean;
  siteId: string | null;
  siteName: string | null;
  /** From worker_credentials: the worker has set a PIN. */
  pinSetAt: string | null;
  lastSignInAt: string | null;
  lockedUntil: string | null;
  /** Locked 3 times in 24 hours: held until a new PIN is set (owner decision 18). */
  heldAt?: string | null;
  /** The open (unused, unrevoked) invite, if any. */
  openInvite: { sentVia: InviteChannel; createdAt: string; expiresAt: string } | null;
}

export type InviteStatusKind = "signed_up" | "locked" | "invited" | "expired" | "not_invited";

export interface InviteStatus {
  kind: InviteStatusKind;
  label: string;
  /** Matches the Status component: done, pending or action. */
  tone: "done" | "pending" | "action";
}

/** "14 Nov 2026" in Lagos time. */
export function lagosDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Lagos",
  }).format(new Date(iso));
}

/** "09:05", 24-hour Lagos time. */
export function lagosTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Africa/Lagos",
  }).format(new Date(iso));
}

export function inviteStatus(worker: RosterWorker, now: Date = new Date()): InviteStatus {
  if (worker.pinSetAt) {
    if (worker.heldAt) {
      return { kind: "locked", label: "Locked until a new PIN", tone: "action" };
    }
    if (worker.lockedUntil && new Date(worker.lockedUntil) > now) {
      return {
        kind: "locked",
        label: `Locked until ${lagosTime(worker.lockedUntil)}`,
        tone: "action",
      };
    }
    return { kind: "signed_up", label: "Signed up", tone: "done" };
  }
  const invite = worker.openInvite;
  if (invite && new Date(invite.expiresAt) > now) {
    return {
      kind: "invited",
      label: invite.sentVia === "email" ? "Invite emailed" : "Invite printed",
      tone: "pending",
    };
  }
  if (invite) return { kind: "expired", label: "Invite expired", tone: "action" };
  return { kind: "not_invited", label: "Not invited", tone: "action" };
}

export interface RosterSummary {
  total: number;
  signedUp: number;
  invited: number;
  notInvited: number;
}

export function rosterSummary(
  workers: readonly RosterWorker[],
  now: Date = new Date(),
): RosterSummary {
  const summary: RosterSummary = { total: workers.length, signedUp: 0, invited: 0, notInvited: 0 };
  for (const worker of workers) {
    const kind = inviteStatus(worker, now).kind;
    if (kind === "signed_up" || kind === "locked") summary.signedUp += 1;
    else if (kind === "invited") summary.invited += 1;
    else summary.notInvited += 1;
  }
  return summary;
}

/** "1 employee" or "12 employees". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-NG")} ${count === 1 ? one : many}`;
}
