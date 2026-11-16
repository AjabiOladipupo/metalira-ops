import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";
import { isRole } from "@/lib/roles";
import type { Database } from "@/types/db";

import {
  ACTIVE_ORG_COOKIE,
  appAccess,
  managerMemberships,
  resolveActiveOrg,
  type ManagerMembership,
  type Membership,
} from "./active-org";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string | null;
}

export interface Session {
  user: SessionUser;
  /** Every membership of the signed-in user, in any role. */
  memberships: Membership[];
  /** Manager memberships only: what the organisation switcher lists. */
  managerMemberships: ManagerMembership[];
  /** The organisation the manager is working in, or null when they manage none. */
  active: ManagerMembership | null;
}

function supabaseConfigured(): boolean {
  try {
    getSupabasePublicEnv();
    return true;
  } catch {
    return false;
  }
}

/** The signed-in user's memberships, read under RLS and filtered to their own rows. */
export async function loadMemberships(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Membership[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select("organisation_id, role, organisations ( name )")
    .eq("user_id", userId);
  if (error) throw new Error(`Could not load memberships: ${error.message}`);

  return (data ?? []).flatMap((row) =>
    isRole(row.role) && row.organisations
      ? [
          {
            organisationId: row.organisation_id,
            organisationName: row.organisations.name,
            role: row.role,
          },
        ]
      : [],
  );
}

/**
 * The signed-in user, their memberships and the active organisation, or null when signed out.
 * Read once per request (React cache). The user comes from `auth.getUser()`, which asks the
 * Auth server, so a revoked session is not trusted here even if its JWT has not expired.
 *
 * Reads cookies: call it inside a <Suspense> boundary, a Server Function or a Route Handler.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  // Request-time only: never part of a prerender or a runtime prefetch, where the Supabase
  // client's clock reads (Date.now) are not allowed. This also keeps a build without Supabase
  // settings from ever reaching the env check.
  await connection();
  const cookieStore = await cookies();
  if (!supabaseConfigured()) return null;

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const user = data.user;

  const [memberships, profile] = await Promise.all([
    loadMemberships(supabase, user.id),
    supabase.from("profiles").select("full_name").eq("user_id", user.id).maybeSingle(),
  ]);

  return {
    user: { id: user.id, email: user.email ?? "", fullName: profile.data?.full_name ?? null },
    memberships,
    managerMemberships: managerMemberships(memberships),
    active: resolveActiveOrg(cookieStore.get(ACTIVE_ORG_COOKIE)?.value, memberships),
  };
});

/** The session, or a redirect to sign-in. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

/**
 * Gate for a manager-app page. Redirects unless the signed-in user manages an organisation and
 * their role there may open `href` (the owner's role-to-nav decision in src/lib/nav.ts).
 */
export async function requireAppAccess(
  href: string,
): Promise<Session & { active: ManagerMembership }> {
  const session = await getSession();
  const access = appAccess(
    session !== null,
    session?.active ?? null,
    session?.memberships ?? [],
    href,
  );
  if (access.type === "redirect") redirect(access.to);
  return { ...(session as Session), active: access.active };
}
