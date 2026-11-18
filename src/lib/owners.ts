import type { Role } from "@/lib/roles";
import { isTeamRole } from "@/lib/team";

/**
 * Owner rules (slice 1.13, owner request 18 Nov 2026), shared by the Team page (which buttons to
 * show) and the server (which refusals to explain). The database enforces the same rules for
 * every client (supabase/migrations/20261118120000_owners.sql); these never replace that check.
 *
 * - A company can have several owners. With exactly one owner, that owner alone makes an
 *   existing manager an owner or invites someone as owner.
 * - With two or more owners, adding an owner, removing one or demoting one (stepping down
 *   included) waits for a second owner's approval.
 * - The last owner is never removed or demoted. Nobody removes themselves; an owner steps down
 *   to another manager role only while another owner remains.
 * - Workers and client approvers never become owners.
 */

export const OWNER_CHANGE_KINDS = ["add", "invite", "remove", "demote"] as const;
export type OwnerChangeKind = (typeof OWNER_CHANGE_KINDS)[number];

export function isOwnerChangeKind(value: unknown): value is OwnerChangeKind {
  return typeof value === "string" && (OWNER_CHANGE_KINDS as readonly string[]).includes(value);
}

/** True when the change waits for a second owner; false when the one owner decides alone. */
export function needsSecondOwner(kind: OwnerChangeKind, ownerCount: number): boolean {
  if (kind === "add" || kind === "invite") return ownerCount >= 2;
  return true;
}

export type OwnerRefusal =
  "not_owner" | "last_owner" | "not_eligible" | "already_owner" | "not_an_owner" | "own_removal";

export interface OwnerActor {
  userId: string;
  role: Role;
}

export interface OwnerTarget {
  userId: string;
  role: Role;
}

/**
 * Why `actor` may not ask for `kind` on `target` (null for an invite) in a company with
 * `ownerCount` owners, or null when they may. A null answer can still mean "waits for a second
 * owner": see needsSecondOwner.
 */
export function ownerChangeRefusal(
  actor: OwnerActor,
  kind: OwnerChangeKind,
  target: OwnerTarget | null,
  ownerCount: number,
): OwnerRefusal | null {
  if (actor.role !== "owner") return "not_owner";
  if (kind === "invite") return null;
  if (!target) return "not_eligible";
  if (kind === "add") {
    if (target.role === "owner") return "already_owner";
    return isTeamRole(target.role) ? null : "not_eligible";
  }
  if (target.role !== "owner") return "not_an_owner";
  if (kind === "remove" && target.userId === actor.userId) return "own_removal";
  if (ownerCount < 2) return "last_owner";
  return null;
}

export type OwnerChangeStatus = "pending" | "approved" | "rejected" | "cancelled";

/** What `actor` may do with a pending change: an owner other than the requester decides. */
export function ownerChangeChoices(
  actor: OwnerActor,
  change: { requestedBy: string; status: OwnerChangeStatus },
): { decide: boolean; withdraw: boolean } {
  if (change.status !== "pending") return { decide: false, withdraw: false };
  const mine = change.requestedBy === actor.userId;
  return { decide: actor.role === "owner" && !mine, withdraw: mine };
}

export const OWNER_REFUSAL_MESSAGES: Record<OwnerRefusal, string> = {
  not_owner: "Only an owner can change who owns the company.",
  last_owner:
    "A company always keeps at least one owner. Make someone else an owner first, then step down.",
  not_eligible:
    "Only a manager on the team can become an owner. Workers and client approvers can't.",
  already_owner: "They are already an owner.",
  not_an_owner: "They are not an owner.",
  own_removal: "You can't remove yourself. Step down to another role instead.",
};

/** Refusals from request_owner_change and decide_owner_change, in plain English. */
export const OWNER_DB_MESSAGES: Record<string, string> = {
  MLOW1: OWNER_REFUSAL_MESSAGES.last_owner,
  MLOW2: "You asked for this change, so another owner must approve or reject it.",
  MLOW3: OWNER_REFUSAL_MESSAGES.not_eligible,
  MLOW4: "This request has already been decided. Refresh the page.",
  MLOW5:
    "This request is out of date: the owner who asked is no longer an owner, or the person changed. Reject it.",
  MLOW6:
    "The company has two or more owners now, so this owner invite needs another owner's approval. Cancel it and ask again.",
  MLOW7: "A request for this person is already waiting for approval.",
};

/** One sentence per change, for the Team page and the owner emails. */
export function describeOwnerChange(change: {
  kind: OwnerChangeKind;
  targetName: string | null;
  inviteEmail: string | null;
  newRoleLabel: string | null;
  requesterName: string | null;
  selfDemotion: boolean;
}): string {
  const who = change.targetName ?? "a manager";
  switch (change.kind) {
    case "add":
      return `Make ${who} an owner`;
    case "invite":
      return `Invite ${change.inviteEmail ?? "someone"} as an owner`;
    case "remove":
      return `Remove ${who} as an owner`;
    case "demote":
      return change.selfDemotion
        ? `${change.requesterName ?? who} steps down to ${change.newRoleLabel ?? "another role"}`
        : `Change ${who} from owner to ${change.newRoleLabel ?? "another role"}`;
  }
}
