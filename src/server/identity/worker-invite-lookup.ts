import "server-only";

import { connection } from "next/server";

import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * What the invite page (/m/invite/[token]) shows before the worker sets a PIN. The visitor has
 * no session, so the lookup goes through the secret-key client and public.worker_invite_lookup,
 * which only the server may call. Holding the token (256 random bits, single use, 7 days) is
 * what entitles the visitor to see the name and staff ID it was made for.
 */

export type InviteView =
  | {
      state: "valid";
      firstName: string;
      lastName: string;
      staffId: string;
      organisationName: string;
      companyCode: string;
      /** True when the worker already has a login: this invite resets their PIN. */
      isReset: boolean;
    }
  | { state: "invalid" | "used" | "revoked" | "expired" | "ended" | "unavailable" };

const STATES = new Set(["used", "revoked", "expired", "ended"]);

export async function lookupWorkerInvite(token: string): Promise<InviteView> {
  await connection();
  if (!/^[0-9a-f]{64}$/.test(token)) return { state: "invalid" };
  try {
    const { data, error } = await createAdminSupabase()
      .rpc("worker_invite_lookup", { p_token: token })
      .maybeSingle();
    if (error) throw new Error(`Invite lookup failed: ${error.code}`);
    if (!data) return { state: "invalid" };
    if (data.state === "valid") {
      return {
        state: "valid",
        firstName: data.first_name,
        lastName: data.last_name,
        staffId: data.staff_id,
        organisationName: data.organisation_name,
        companyCode: data.company_code,
        isReset: data.auth_user_id !== null,
      };
    }
    return { state: STATES.has(data.state) ? (data.state as "used") : "invalid" };
  } catch (error) {
    console.error(
      "worker_invite.lookup_failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
    return { state: "unavailable" };
  }
}
