import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import type { Database } from "@/types/db";

import { createOrganisation, organisationNameSchema } from "./organisations";

/** user_metadata key where sign-up parks the company name until the email is confirmed. */
export const PENDING_COMPANY_KEY = "company_name";

export interface CreatedOrganisation {
  organisationId: string;
  organisationName: string;
}

/**
 * Creates the owner's organisation on their first confirmed sign-in.
 *
 * Sign-up stores the company name in user_metadata, because with email confirmation on there
 * is no session until the link is followed. The callback and confirm routes (and sign-up
 * itself, when confirmation is off) call this. It creates the organisation only when the user
 * has a confirmed email, a pending company name and no membership at all, then clears the
 * pending name so a later sign-in never creates a second one.
 *
 * user_metadata is user-editable, which is fine here: any signed-in user may create an
 * organisation through public.create_organisation anyway, and RLS keeps it theirs alone.
 */
export async function ensureOrganisationForNewUser(
  supabase: SupabaseClient<Database>,
  user: User,
): Promise<CreatedOrganisation | null> {
  if (!user.email_confirmed_at) return null;

  const parsed = organisationNameSchema.safeParse(user.user_metadata?.[PENDING_COMPANY_KEY]);
  if (!parsed.success) return null;

  const { count, error } = await supabase
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (error) throw new Error(`Could not check memberships: ${error.message}`);
  if ((count ?? 0) > 0) return null;

  const organisationId = await createOrganisation(supabase, parsed.data);

  // Best effort: a failure only means the next sign-in finds the membership and stops above.
  await supabase.auth.updateUser({ data: { [PENDING_COMPANY_KEY]: null } });

  return { organisationId, organisationName: parsed.data };
}
