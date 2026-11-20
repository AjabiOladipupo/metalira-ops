import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { LAGOS_TIME_ZONE, todayIn } from "@/lib/dates";
import type { ManagerRole } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import { canEditClientTax, canEditClients, canEditContacts } from "@/server/business/clients";
import { canEditContracts } from "@/server/business/contracts";
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
  /** A client's tax settings (deducts WHT, withholds VAT): owner, admin, finance. */
  canEditClientTax: boolean;
  /** The company's calendar day in its own time zone (as `private.org_today`). */
  today: string;
}

/**
 * What a Clients page needs. Render only: call inside the page's RouteGate (it has checked the
 * role may open the page). Server Actions verify the user again through `mutate()`.
 */
export async function clientsPageContext(): Promise<ClientsPageContext> {
  const session = await getPageSession();
  if (!session?.active) redirect(NO_ACCESS_PATH);
  const { organisationId, role } = session.active;
  const supabase = await createServerSupabase();
  const { data: org } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", organisationId)
    .maybeSingle();
  return {
    supabase,
    today: todayIn(org?.timezone ?? LAGOS_TIME_ZONE),
    organisationId,
    role,
    canEdit: canEditClients(role),
    canEditContacts: canEditContacts(role),
    canEditContracts: canEditContracts(role),
    canEditClientTax: canEditClientTax(role),
  };
}
