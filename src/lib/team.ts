import { ROLE_LABELS, type Role } from "@/lib/roles";

/**
 * Team rules (slice 1.12; "the owner" became "an owner" in slice 1.13), shared by the Team page (which buttons to show) and the server
 * (which refusals to explain). The database enforces the same rules for every client
 * (supabase/migrations/20261117120000_team_invites.sql); these never replace that check.
 */

/** The roles a team invite or a role change may grant. Owner, worker and client approver never. */
export const TEAM_ROLES = ["admin", "hr", "finance", "ops_manager", "line_manager"] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

/** Roles that may open Settings → Team and invite, change and remove managers. */
export const TEAM_MANAGERS = ["owner", "admin"] as const satisfies readonly Role[];

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

export function canManageTeam(role: Role): boolean {
  return (TEAM_MANAGERS as readonly Role[]).includes(role);
}

/** One line per role, for the invite form's hint and the role picker. */
export const TEAM_ROLE_HINTS: Record<TeamRole, string> = {
  admin: "Everything, including settings and the team, except owner-only actions.",
  hr: "People, pay details and bank-detail approvals.",
  finance: "Payroll, invoices, collections and bank-detail approvals.",
  ops_manager: "Rosters, attendance, sites and projects.",
  line_manager: "Their own team's timesheets and leave.",
};

/**
 * Roles only an owner may give, change or take away (admin since 1.12; finance and HR from
 * 19 Nov 2026, because they approve bank account and bank-detail changes).
 */
export const OWNER_ONLY_ROLES = ["admin", "hr", "finance"] as const satisfies readonly TeamRole[];

export function isOwnerOnlyRole(role: string): boolean {
  return (OWNER_ONLY_ROLES as readonly string[]).includes(role);
}

/** The roles `actor` may offer in an invite or a role change. */
export function grantableRoles(actor: Role): TeamRole[] {
  if (actor === "owner") return [...TEAM_ROLES];
  if (actor === "admin") return TEAM_ROLES.filter((r) => !isOwnerOnlyRole(r));
  return [];
}

export function roleOptions(actor: Role): { value: TeamRole; label: string }[] {
  return grantableRoles(actor).map((r) => ({ value: r, label: ROLE_LABELS[r] }));
}

export type TeamRefusal =
  | "not_allowed"
  | "owner_only"
  | "own_membership"
  | "owner_protected"
  | "not_a_manager"
  | "same_role"
  | "bad_role";

/** Why `actor` may not invite someone as `role`, or null when they may. */
export function inviteRefusal(actor: Role, role: string): TeamRefusal | null {
  if (!canManageTeam(actor)) return "not_allowed";
  if (!isTeamRole(role)) return "bad_role";
  if (isOwnerOnlyRole(role) && actor !== "owner") return "owner_only";
  return null;
}

export interface TeamTarget {
  userId: string;
  role: Role;
}

/** Why `actor` may not change or remove `target`, or null when they may. */
export function memberRefusal(
  actor: { userId: string; role: Role },
  target: TeamTarget,
): TeamRefusal | null {
  if (!canManageTeam(actor.role)) return "not_allowed";
  if (target.userId === actor.userId) return "own_membership";
  if (target.role === "owner") return "owner_protected";
  if (!isTeamRole(target.role)) return "not_a_manager";
  if (isOwnerOnlyRole(target.role) && actor.role !== "owner") return "owner_only";
  return null;
}

/** Why `actor` may not give `target` the role `next`, or null when they may. */
export function roleChangeRefusal(
  actor: { userId: string; role: Role },
  target: TeamTarget,
  next: string,
): TeamRefusal | null {
  const refusal = memberRefusal(actor, target);
  if (refusal) return refusal;
  if (!isTeamRole(next)) return "bad_role";
  if (isOwnerOnlyRole(next) && actor.role !== "owner") return "owner_only";
  if (next === target.role) return "same_role";
  return null;
}

export const TEAM_REFUSAL_MESSAGES: Record<TeamRefusal, string> = {
  not_allowed: "Only an owner or an admin can manage the team.",
  owner_only: "Only an owner can give, change or remove the admin, finance or HR role.",
  own_membership: "You can't change your own role or remove yourself.",
  owner_protected:
    "Owners are changed with an owner request: make someone an owner, or ask another owner to approve a removal.",
  not_a_manager: "Workers are managed from People, not here.",
  same_role: "They already have that role.",
  bad_role: "Choose admin, HR, finance, operations manager or line manager.",
};

export type InviteState = "pending" | "expired" | "accepted" | "revoked";

/** The state of an invite at `now`: used and cancelled win over expired. */
export function inviteState(
  invite: { acceptedAt: string | null; revokedAt: string | null; expiresAt: string },
  now: Date = new Date(),
): InviteState {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  return Date.parse(invite.expiresAt) <= now.getTime() ? "expired" : "pending";
}

/** The path of a team invite link: /join/<64 hex characters>. */
export const TEAM_INVITE_PATH = "/join";

export function teamInvitePath(token: string): string {
  return `${TEAM_INVITE_PATH}/${token}`;
}

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
