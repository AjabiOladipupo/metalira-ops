import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { passwordTrusted, PASSWORD_SET_AT_KEY } from "@/lib/auth/amr";
import type { Database } from "@/types/db";

import { companyNameSchema } from "./names";

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
 * user_metadata is user-editable: anyone with the publishable key can sign up through
 * Supabase's API directly, and a signed-in user can change it with auth.updateUser. So the
 * name is checked again here with the sign-up form's rules (plain text, no web address), and
 * nothing is created when it fails; the database refuses such names too. The "no membership
 * yet" check and the insert are one step in the database (public.create_first_organisation,
 * under a per-user lock), so two sign-ins racing create one organisation and one welcome email.
 */
export async function ensureOrganisationForNewUser(
  supabase: SupabaseClient<Database>,
  user: User,
): Promise<CreatedOrganisation | null> {
  if (!user.email_confirmed_at) return null;
  // Slice 1.13: only once the account's password is trusted (chosen after confirming, from an
  // email link). Before that, the pending name may be someone else's: they could have signed the
  // address up first with a company name of their choosing. /set-password asks for the company
  // name and creates it with createOwnerCompany instead.
  if (!passwordTrusted(user.app_metadata?.[PASSWORD_SET_AT_KEY], user.email_confirmed_at)) {
    return null;
  }

  const parsed = companyNameSchema.safeParse(user.user_metadata?.[PENDING_COMPANY_KEY]);
  if (!parsed.success) return null;

  const { data, error } = await supabase.rpc("create_first_organisation", {
    p_name: parsed.data,
  });
  if (error) throw new Error(`Could not create the organisation: ${error.message}`);
  // Null when the user already belongs to an organisation (another sign-in got there first).
  const organisationId: string | null = data ?? null;
  if (!organisationId) return null;

  // Best effort: a failure only means the next sign-in finds the membership and stops above.
  await supabase.auth.updateUser({ data: { [PENDING_COMPANY_KEY]: null } });

  return { organisationId, organisationName: parsed.data };
}

/**
 * Creates the owner's company from the name they typed on /set-password (slice 1.13), right after
 * they chose their password there. Same database step as above (public.create_first_organisation:
 * confirmed address, no membership yet, one per user). Clears the pending name parked at sign-up.
 * Returns null when the user already belongs to a company.
 */
export async function createOwnerCompany(
  supabase: SupabaseClient<Database>,
  companyName: string,
): Promise<CreatedOrganisation | null> {
  const { data, error } = await supabase.rpc("create_first_organisation", { p_name: companyName });
  if (error) throw new Error(`Could not create the organisation: ${error.code}`);
  const organisationId: string | null = data ?? null;
  await supabase.auth.updateUser({ data: { [PENDING_COMPANY_KEY]: null } });
  if (!organisationId) return null;
  return { organisationId, organisationName: companyName };
}
