import "server-only";

import { connection } from "next/server";

import { isTeamRole, isInviteToken, type TeamRole } from "@/lib/team";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * What the team invite page (/join/[token]) shows (slice 1.12). The visitor may be signed out,
 * so the lookup goes through the secret-key client and public.membership_invite_lookup, which
 * only the server may call. Holding the token (256 random bits, single use, 7 days) is what
 * entitles the visitor to see the company, the role and the address it was sent to.
 */

export type TeamInviteView =
  | {
      state: "pending";
      inviteId: string;
      organisationId: string;
      organisationName: string;
      email: string;
      /** A manager role, or owner for an owner invite (slice 1.13). */
      role: TeamRole | "owner";
      inviterName: string | null;
      expiresAt: string;
      /** When the invite was made (slice 1.13: an address confirmed after it sets a password). */
      invitedAt: string;
    }
  | {
      state: "accepted" | "revoked" | "expired";
      organisationId: string;
      organisationName: string;
    }
  | { state: "invalid" | "unavailable" };

export async function lookupTeamInvite(token: string): Promise<TeamInviteView> {
  await connection();
  if (!isInviteToken(token)) return { state: "invalid" };
  try {
    const { data, error } = await createAdminSupabase()
      .rpc("membership_invite_lookup", { p_token: token })
      .maybeSingle();
    if (error) throw new Error(`Team invite lookup failed: ${error.code}`);
    if (!data) return { state: "invalid" };
    if (data.state === "pending") {
      // An invite from before slice 1.12 with a role this page can't grant.
      if (!isTeamRole(data.role) && data.role !== "owner") return { state: "invalid" };
      const role: TeamRole | "owner" = data.role === "owner" ? "owner" : data.role;
      return {
        state: "pending",
        inviteId: data.invite_id,
        organisationId: data.organisation_id,
        organisationName: data.organisation_name,
        email: data.email,
        role,
        inviterName: data.inviter_name,
        expiresAt: data.expires_at,
        invitedAt: data.invited_at,
      };
    }
    if (data.state === "accepted" || data.state === "revoked" || data.state === "expired") {
      return {
        state: data.state,
        organisationId: data.organisation_id,
        organisationName: data.organisation_name,
      };
    }
    return { state: "invalid" };
  } catch (error) {
    console.error(
      "team_invite.lookup_failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
    return { state: "unavailable" };
  }
}
