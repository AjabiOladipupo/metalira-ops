import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/types/db";

import { plainText } from "./names";

/** Same rules as the organisations.name check constraint: 1 to 200 characters, plain text. */
export const organisationNameSchema = plainText(
  z
    .string()
    .trim()
    .min(1, "Enter your company name")
    .max(200, "Company name must be 200 characters or fewer"),
  "Company name",
);

/**
 * Creates an organisation with the signed-in user as owner, in one database
 * transaction. Pass the user's own client (createServerSupabase), never the
 * admin client: the RPC takes the owner from the session. The audit triggers
 * log `organisations.insert` and `memberships.insert`.
 */
export async function createOrganisation(
  supabase: SupabaseClient<Database>,
  name: string,
): Promise<string> {
  const p_name = organisationNameSchema.parse(name);
  const { data, error } = await supabase.rpc("create_organisation", { p_name });
  if (error) {
    throw new Error(`Could not create the organisation: ${error.message}`);
  }
  return data;
}
