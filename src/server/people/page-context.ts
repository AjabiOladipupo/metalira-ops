import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { lagosToday } from "@/lib/dates";
import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import type { ManagerRole } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import { getSession } from "@/server/identity/session";
import type { Database } from "@/types/db";

import { PEOPLE_EDITORS } from "./workers";

export interface PeoplePageContext {
  supabase: SupabaseClient<Database>;
  organisationId: string;
  role: ManagerRole;
  /** Owner, admin or hr: may add and change employees. Actions check this again. */
  canEdit: boolean;
  /** Today in Lagos, `YYYY-MM-DD`. */
  today: string;
}

/**
 * What a People page needs: the caller's own Supabase client, the active organisation and role,
 * and today's date. Call inside the page's RouteGate (it has already checked the role may open
 * the page); reads cookies, so it sits behind that Suspense boundary.
 */
export async function peoplePageContext(): Promise<PeoplePageContext> {
  const session = await getSession();
  if (!session?.active) redirect(NO_ACCESS_PATH);
  const { organisationId, role } = session.active;
  return {
    supabase: await createServerSupabase(),
    organisationId,
    role,
    canEdit: (PEOPLE_EDITORS as readonly ManagerRole[]).includes(role),
    today: lagosToday(),
  };
}
