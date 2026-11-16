import { canAccessHref } from "@/lib/nav";
import { NO_ACCESS_PATH, SIGN_IN_PATH, WORKER_HOME_PATH, safeNextPath } from "@/lib/auth/routes";
import { isManagerRole, type ManagerRole, type Role } from "@/lib/roles";

/**
 * Pure rules for the active organisation and for who may open which page. No I/O, so they are
 * unit-tested directly; src/server/identity/session.ts feeds them the signed-in user's rows.
 */

/** httpOnly cookie holding the organisation the manager is working in. */
export const ACTIVE_ORG_COOKIE = "mo_org";

export const ACTIVE_ORG_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
} as const;

export interface Membership {
  organisationId: string;
  organisationName: string;
  role: Role;
}

export interface ManagerMembership extends Membership {
  role: ManagerRole;
}

/** Memberships that open the manager app, sorted by organisation name. */
export function managerMemberships(memberships: readonly Membership[]): ManagerMembership[] {
  return memberships
    .filter((m): m is ManagerMembership => isManagerRole(m.role))
    .sort(
      (a, b) =>
        a.organisationName.localeCompare(b.organisationName, "en", { sensitivity: "base" }) ||
        a.organisationId.localeCompare(b.organisationId),
    );
}

/**
 * The organisation the manager is working in. The cookie counts only when it names one of the
 * user's manager memberships (it is a preference, never an authorisation); otherwise the first
 * manager membership by name; otherwise null.
 */
export function resolveActiveOrg(
  cookieValue: string | null | undefined,
  memberships: readonly Membership[],
): ManagerMembership | null {
  const managed = managerMemberships(memberships);
  return managed.find((m) => m.organisationId === cookieValue) ?? managed[0] ?? null;
}

export type AppAccess =
  { type: "allow"; active: ManagerMembership } | { type: "redirect"; to: string };

/**
 * Where a request for `href` in the manager app goes. Signed out: sign-in. No manager
 * membership: workers to the worker app, everyone else (client approvers, or no organisation
 * at all) to the no-access page. A role the page does not list: no-access.
 */
export function appAccess(
  signedIn: boolean,
  active: ManagerMembership | null,
  memberships: readonly Membership[],
  href: string,
): AppAccess {
  if (!signedIn) {
    const next = safeNextPath(href);
    return {
      type: "redirect",
      to: next === "/app" ? SIGN_IN_PATH : `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`,
    };
  }
  if (!active) {
    const isWorker = memberships.some((m) => m.role === "worker");
    return { type: "redirect", to: isWorker ? WORKER_HOME_PATH : NO_ACCESS_PATH };
  }
  if (!canAccessHref(active.role, href)) return { type: "redirect", to: NO_ACCESS_PATH };
  return { type: "allow", active };
}
