import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import type { ManagerRole } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import { canEditClients, canEditContacts } from "@/server/business/clients";
import { canEditContracts, canEditWht } from "@/server/business/contracts";
import { getPageSession } from "@/server/identity/session";
import type { Database } from "@/types/db";

export interface ClientsPageContext {
  supabase: SupabaseClient<Database>;
  organisationId: string;
  role: ManagerRole;
  /** Owner, admin or ops_manager. The actions check again. */
  canEdit: boolean;
  /** Also finance. */
  canEditContacts: boolean;
  /** Contracts, their sites and rate cards: owner, admin, ops_manager (slice 2.4). */
  canEditContracts: boolean;
  /** A contract's WHT rates: owner, admin, finance. */
  canEditWht: boolean;
}

/**
 * What a Clients page needs. Render only: call inside the page's RouteGate (it has checked the
 * role may open the page). Server Actions verify the user again through `mutate()`.
 */
export async function clientsPageContext(): Promise<ClientsPageContext> {
  const session = await getPageSession();
  if (!session?.active) redirect(NO_ACCESS_PATH);
  const { organisationId, role } = session.active;
  return {
    supabase: await createServerSupabase(),
    organisationId,
    role,
    canEdit: canEditClients(role),
    canEditContacts: canEditContacts(role),
    canEditContracts: canEditContracts(role),
    canEditWht: canEditWht(role),
  };
}
