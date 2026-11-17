import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { isRole, ROLE_LABELS, type Role } from "@/lib/roles";
import {
  inviteRefusal,
  isTeamRole,
  TEAM_MANAGERS,
  TEAM_REFUSAL_MESSAGES,
  TEAM_ROLES,
  type TeamRole,
} from "@/lib/team";
import type { Database } from "@/types/db";

import { MutationError, type MutationSpec } from "./mutate";

/**
 * Settings → Team (slice 1.12), server side: the managers and pending invites of the active
 * company, and the changes owners and admins make there. Each change is one SQL function
 * (public.create_membership_invite, resend_membership_invite, revoke_membership_invite,
 * change_member_role, remove_member) called with the user's own client through mutate(), so
 * the database checks the role and the team rules again and its triggers write the audit rows
 * (who, what, before, after) in the same transaction.
 *
 * Raw invite tokens exist only in the return value of create and resend: the caller emails the
 * link (or, when email is not set up, shows it once to the inviter). Addresses are never logged.
 */

type Client = SupabaseClient<Database>;

export interface TeamMember {
  membershipId: string;
  userId: string;
  role: Role;
  fullName: string | null;
  email: string;
  joinedAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  sentAt: string;
  expiresAt: string;
  invitedBy: string | null;
}

export interface Team {
  members: TeamMember[];
  invites: PendingInvite[];
}

/** The company's managers (owner first, then by join date) and its pending invites. */
export async function loadTeam(supabase: Client, organisationId: string): Promise<Team> {
  const [members, invites] = await Promise.all([
    supabase.rpc("team_members", { p_organisation_id: organisationId }),
    supabase
      .from("membership_invites")
      .select("id, email, role, sent_at, expires_at, created_by")
      .eq("organisation_id", organisationId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .order("sent_at", { ascending: false })
      .limit(500),
  ]);
  if (members.error) throw new Error(`Could not load the team: ${members.error.code}`);
  if (invites.error) throw new Error(`Could not load the invites: ${invites.error.code}`);

  const inviterIds = [
    ...new Set((invites.data ?? []).flatMap((i) => (i.created_by ? [i.created_by] : []))),
  ];
  const names = new Map<string, string | null>();
  if (inviterIds.length > 0) {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", inviterIds);
    for (const p of data ?? []) names.set(p.user_id, p.full_name);
  }

  const rank = (role: Role) => (role === "owner" ? 0 : 1);
  return {
    members: (members.data ?? [])
      .flatMap((m): TeamMember[] =>
        isRole(m.role)
          ? [
              {
                membershipId: m.membership_id,
                userId: m.user_id,
                role: m.role,
                fullName: m.full_name,
                email: m.email,
                joinedAt: m.joined_at,
              },
            ]
          : [],
      )
      .sort((a, b) => rank(a.role) - rank(b.role) || a.joinedAt.localeCompare(b.joinedAt)),
    invites: (invites.data ?? []).flatMap((i): PendingInvite[] =>
      isRole(i.role)
        ? [
            {
              id: i.id,
              email: i.email,
              role: i.role,
              sentAt: i.sent_at,
              expiresAt: i.expires_at,
              invitedBy: i.created_by ? (names.get(i.created_by) ?? null) : null,
            },
          ]
        : [],
    ),
  };
}

// ---------------------------------------------------------------------------
// Refusals from the database, in plain English
// ---------------------------------------------------------------------------

const DB_MESSAGES: Record<string, { code: "invalid" | "forbidden"; message: string }> = {
  MLTM1: { code: "invalid", message: "This person is already a member of your company." },
  MLTM2: { code: "invalid", message: "This address can't be invited as a manager." },
  MLTM3: { code: "invalid", message: "This invite has already been used." },
  MLTM4: { code: "invalid", message: "This invite has expired. Send a new one." },
  MLTM5: { code: "invalid", message: "This invite was cancelled." },
  MLTM6: { code: "forbidden", message: TEAM_REFUSAL_MESSAGES.own_membership },
  MLTM7: { code: "forbidden", message: TEAM_REFUSAL_MESSAGES.owner_protected },
  MLTM8: { code: "forbidden", message: TEAM_REFUSAL_MESSAGES.not_a_manager },
  MLTM9: {
    code: "invalid",
    message:
      "Your company has sent the most invites allowed in 24 hours. Try again tomorrow, or ask the people already invited to use their links.",
  },
  // Two invites for one address at the same moment: the other one won.
  "23505": {
    code: "invalid",
    message: "An invite for this address was just sent. Refresh the page to see it.",
  },
  P0002: {
    code: "invalid",
    message: "That is no longer on your team page. Refresh and try again.",
  },
};

/** Turns a refusal from one of the team functions into a MutationError the form can show. */
export function teamDbError(error: PostgrestError, what: string): MutationError {
  const known = DB_MESSAGES[error.code];
  if (known) return new MutationError(known.code, known.message);
  if (error.code === "42501") {
    return new MutationError(
      "forbidden",
      /only the owner can/i.test(error.message)
        ? TEAM_REFUSAL_MESSAGES.owner_only
        : TEAM_REFUSAL_MESSAGES.not_allowed,
    );
  }
  if (error.code === "22023") {
    const text = error.message.trim();
    return new MutationError("invalid", `${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
  }
  return new MutationError("failed", `${what} failed (${error.code}).`);
}

// ---------------------------------------------------------------------------
// Specs (run through mutate())
// ---------------------------------------------------------------------------

const teamRole = z.enum(TEAM_ROLES, {
  error: "Choose admin, HR, finance, operations manager or line manager.",
});

export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter their work email.")
    .max(320, "Email address must be 320 characters or fewer.")
    .pipe(z.email("Enter a valid email address.")),
  role: teamRole,
});

export interface IssuedInvite {
  inviteId: string;
  token: string;
  email: string;
  role: TeamRole;
  expiresAt: Date;
}

/** Creates (or replaces) the pending invite for an address. The token exists only in the result. */
export const inviteSpec: MutationSpec<typeof inviteSchema, IssuedInvite> = {
  schema: inviteSchema,
  roles: TEAM_MANAGERS,
  run: async ({ supabase, organisationId, role, data }) => {
    const refusal = inviteRefusal(role, data.role);
    if (refusal) throw new MutationError("forbidden", TEAM_REFUSAL_MESSAGES[refusal]);

    const { data: token, error } = await supabase.rpc("create_membership_invite", {
      p_organisation_id: organisationId,
      p_email: data.email,
      p_role: data.role,
    });
    if (error) throw teamDbError(error, "create_membership_invite");

    const { data: row, error: readError } = await supabase
      .from("membership_invites")
      .select("id, expires_at")
      .eq("organisation_id", organisationId)
      .eq("email", data.email)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .single();
    if (readError) throw new Error(`Could not read the new invite: ${readError.code}`);
    return {
      inviteId: row.id,
      token,
      email: data.email,
      role: data.role,
      expiresAt: new Date(row.expires_at),
    };
  },
};

export const inviteIdSchema = z.object({ inviteId: z.uuid("Choose an invite.") });

/** A new link for a pending or expired invite (7 more days); the old link stops working. */
export const resendSpec: MutationSpec<typeof inviteIdSchema, IssuedInvite> = {
  schema: inviteIdSchema,
  roles: TEAM_MANAGERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase.rpc("resend_membership_invite", {
      p_organisation_id: organisationId,
      p_invite_id: data.inviteId,
    });
    if (error) throw teamDbError(error, "resend_membership_invite");
    const row = rows?.[0];
    if (!row || !isTeamRole(row.invite_role)) throw new Error("resend returned no invite");
    return {
      inviteId: data.inviteId,
      token: row.token,
      email: row.invite_email,
      role: row.invite_role,
      expiresAt: new Date(row.invite_expires_at),
    };
  },
};

/** Cancels a pending invite. */
export const cancelSpec: MutationSpec<typeof inviteIdSchema, { inviteId: string }> = {
  schema: inviteIdSchema,
  roles: TEAM_MANAGERS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("revoke_membership_invite", {
      p_organisation_id: organisationId,
      p_invite_id: data.inviteId,
    });
    if (error) throw teamDbError(error, "revoke_membership_invite");
    return { inviteId: data.inviteId };
  },
};

export interface ChangedMember {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  oldRole: Role;
  newRole: Role | null;
}

export const changeRoleSchema = z.object({
  membershipId: z.uuid("Choose a member."),
  role: teamRole,
});

/** Gives a manager another manager role. */
export const changeRoleSpec: MutationSpec<typeof changeRoleSchema, ChangedMember> = {
  schema: changeRoleSchema,
  roles: TEAM_MANAGERS,
  run: async ({ supabase, organisationId, role, data }) => {
    if (data.role === "admin" && role !== "owner") {
      throw new MutationError("forbidden", TEAM_REFUSAL_MESSAGES.owner_only);
    }
    const { data: rows, error } = await supabase.rpc("change_member_role", {
      p_organisation_id: organisationId,
      p_membership_id: data.membershipId,
      p_role: data.role,
    });
    if (error) throw teamDbError(error, "change_member_role");
    const row = rows?.[0];
    if (!row || !isRole(row.old_role) || !isRole(row.new_role)) {
      throw new Error("change_member_role returned no member");
    }
    return {
      membershipId: data.membershipId,
      userId: row.member_user_id,
      email: row.member_email,
      name: row.member_name,
      oldRole: row.old_role,
      newRole: row.new_role,
    };
  },
};

export const memberIdSchema = z.object({ membershipId: z.uuid("Choose a member.") });

/** Removes a manager from the company. */
export const removeSpec: MutationSpec<typeof memberIdSchema, ChangedMember> = {
  schema: memberIdSchema,
  roles: TEAM_MANAGERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase.rpc("remove_member", {
      p_organisation_id: organisationId,
      p_membership_id: data.membershipId,
    });
    if (error) throw teamDbError(error, "remove_member");
    const row = rows?.[0];
    if (!row || !isRole(row.old_role)) throw new Error("remove_member returned no member");
    return {
      membershipId: data.membershipId,
      userId: row.member_user_id,
      email: row.member_email,
      name: row.member_name,
      oldRole: row.old_role,
      newRole: null,
    };
  },
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}
