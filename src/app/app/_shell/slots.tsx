import { Suspense } from "react";

import { PlanCard } from "@/components/shell/app-sidebar";
import { NavLinks, NavSkeleton } from "@/components/shell/nav-links";
import { OrgSwitcher } from "@/components/shell/org-switcher";
import { OrgSwitcherSkeleton } from "@/components/shell/top-bar";
import { UserMenu, UserMenuFallback } from "@/components/shell/user-menu";
import { planName } from "@/lib/company";
import { navForRole } from "@/lib/nav";
import { ROLE_LABELS } from "@/lib/roles";
import { signOut, switchOrganisation } from "@/server/identity/actions";
import { getActiveCompany, getActiveCompanyLogoUrl } from "@/server/identity/company-data";
import { getSession, requireAppAccess } from "@/server/identity/session";

/**
 * Session-dependent parts of the manager shell. Each reads the session (cookies), so each sits
 * behind its own Suspense boundary and the rest of the shell stays in the static prerender.
 * getSession() is cached per request, so they share one lookup.
 */

async function RoleNavInner() {
  const session = await getSession();
  if (!session?.active) return null;
  return <NavLinks groups={navForRole(session.active.role)} />;
}

export function RoleNav() {
  return (
    <Suspense fallback={<NavSkeleton />}>
      <RoleNavInner />
    </Suspense>
  );
}

async function OrgSwitcherInner() {
  const session = await getSession();
  if (!session?.active) return null;
  const logoUrl = await getActiveCompanyLogoUrl();
  return (
    <OrgSwitcher
      logoUrl={logoUrl}
      options={session.managerMemberships.map((m) => ({
        id: m.organisationId,
        name: m.organisationName,
        roleLabel: ROLE_LABELS[m.role],
      }))}
      activeId={session.active.organisationId}
      switchAction={switchOrganisation}
    />
  );
}

export function OrgSwitcherSlot() {
  return (
    <Suspense fallback={<OrgSwitcherSkeleton />}>
      <OrgSwitcherInner />
    </Suspense>
  );
}

async function PlanCardInner() {
  const company = await getActiveCompany();
  return <PlanCard planName={planName(company?.plan ?? "trial")} />;
}

/** The plan the active company chose, at the foot of the sidebar and the mobile menu. */
export function PlanCardSlot() {
  return (
    <Suspense fallback={<PlanCard />}>
      <PlanCardInner />
    </Suspense>
  );
}

async function UserMenuInner() {
  const session = await getSession();
  if (!session) return <UserMenuFallback />;
  return (
    <UserMenu
      name={session.user.fullName}
      email={session.user.email}
      roleLabel={session.active ? ROLE_LABELS[session.active.role] : null}
      signOutAction={signOut}
    />
  );
}

export function UserMenuSlot() {
  return (
    <Suspense fallback={<UserMenuFallback />}>
      <UserMenuInner />
    </Suspense>
  );
}

async function AccessGateInner() {
  await requireAppAccess("/app");
  return null;
}

/** Layout-wide check: signed in, and a manager in some organisation. Renders nothing. */
export function AccessGate() {
  return (
    <Suspense fallback={null}>
      <AccessGateInner />
    </Suspense>
  );
}

async function RouteGateInner({ href, children }: { href: string; children: React.ReactNode }) {
  await requireAppAccess(href);
  return children;
}

function PageSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <span className="h-3 w-24 rounded bg-surface" />
      <span className="h-9 w-56 rounded bg-surface" />
      <span className="h-4 w-80 max-w-full rounded bg-surface" />
    </div>
  );
}

/**
 * Per-page check against the role-to-nav decision, so typing a URL is refused the same way
 * the sidebar hides the link. Every page under /app wraps its content in this. Layouts cannot
 * see the pathname, which is why the check lives in the page.
 */
export function RouteGate({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RouteGateInner href={href}>{children}</RouteGateInner>
    </Suspense>
  );
}
