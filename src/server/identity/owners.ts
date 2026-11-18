import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  isOwnerChangeKind,
  OWNER_CHANGE_KINDS,
  OWNER_DB_MESSAGES,
  type OwnerChangeKind,
  type OwnerChangeStatus,
} from "@/lib/owners";
import { isRole, MANAGER_ROLES, type Role } from "@/lib/roles";
import { TEAM_ROLES } from "@/lib/team";
import type { Database } from "@/types/db";

import { MutationError, type MutationSpec } from "./mutate";
import { teamDbError } from "./team";

/**
 * Owner changes (slice 1.13), server side. public.request_owner_change and
 * public.decide_owner_change enforce every rule for every client (one owner adds an owner alone;
 * with two or more owners a different owner approves; the last owner stays; workers never become
 * owners) and the audit triggers log every row. Both are called with the user's own client
 * through mutate(). An owner invite's raw token exists only in the result; the action emails it.
 */

type Client = SupabaseClient<Database>;

export interface PendingOwnerChange {
  id: string;
  kind: OwnerChangeKind;
  status: OwnerChangeStatus;
  requestedBy: string;
  requesterName: string | null;
  targetUserId: string | null;
  targetName: string | null;
  inviteEmail: string | null;
  newRole: Role | null;
  createdAt: string;
}

/** The company's owner changes waiting for approval, oldest first (owners and admins read). */
export async function loadPendingOwnerChanges(
  supabase: Client,
  organisationId: string,
): Promise<PendingOwnerChange[]> {
  const { data, error } = await supabase
    .from("owner_changes")
    .select("id, kind, status, requested_by, target_user_id, invite_email, new_role, created_at")
    .eq("organisation_id", organisationId)
    .eq("status", "pending")
    .order("created_at")
    .limit(100);
  if (error) throw new Error(`Could not load owner changes: ${error.code}`);
  const rows = data ?? [];
  const ids = [
    ...new Set(rows.flatMap((r) => [r.requested_by, r.target_user_id]).filter(Boolean)),
  ] as string[];
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    for (const p of profiles ?? []) names.set(p.user_id, p.full_name);
  }
  return rows.flatMap((r): PendingOwnerChange[] =>
    isOwnerChangeKind(r.kind)
      ? [
          {
            id: r.id,
            kind: r.kind,
            status: r.status,
            requestedBy: r.requested_by,
            requesterName: names.get(r.requested_by) ?? null,
            targetUserId: r.target_user_id,
            targetName: r.target_user_id ? (names.get(r.target_user_id) ?? null) : null,
            inviteEmail: r.invite_email,
            newRole: r.new_role && isRole(r.new_role) ? r.new_role : null,
            createdAt: r.created_at,
          },
        ]
      : [],
  );
}

/** Turns a refusal from the owner functions into a MutationError the form can show. */
export function ownerDbError(error: PostgrestError, what: string): MutationError {
  const known = OWNER_DB_MESSAGES[error.code];
  if (known) return new MutationError(error.code === "MLOW2" ? "forbidden" : "invalid", known);
  if (error.code === "42501" && /only an owner can change who owns/i.test(error.message)) {
    return new MutationError("forbidden", "Only an owner can change who owns the company.");
  }
  if (error.code === "42501" && /withdraw/i.test(error.message)) {
    return new MutationError(
      "forbidden",
      "Only the owner who asked can withdraw this. Another owner can reject it.",
    );
  }
  if (error.code === "42501" && /another owner can/i.test(error.message)) {
    return new MutationError("forbidden", "Only another owner can approve or reject this.");
  }
  return teamDbError(error, what);
}

// ---------------------------------------------------------------------------
// Specs (run through mutate())
// ---------------------------------------------------------------------------

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter their work email.")
  .max(320, "Email address must be 320 characters or fewer.")
  .pipe(z.email("Enter a valid email address."));

export const requestOwnerChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), membershipId: z.uuid("Choose a member.") }),
  z.object({ kind: z.literal("remove"), membershipId: z.uuid("Choose a member.") }),
  z.object({
    kind: z.literal("demote"),
    membershipId: z.uuid("Choose a member."),
    newRole: z.enum(TEAM_ROLES, {
      error: "Choose admin, HR, finance, operations manager or line manager.",
    }),
  }),
  z.object({ kind: z.literal("invite"), email }),
]);

export interface RequestedOwnerChange {
  changeId: string;
  kind: OwnerChangeKind;
  status: OwnerChangeStatus;
  /** Only for an invite that happened at once: the raw token to email. */
  inviteToken: string | null;
  inviteEmail: string | null;
}

/** Asks for an owner change; with one owner adding an owner it happens at once. */
export const requestOwnerChangeSpec: MutationSpec<
  typeof requestOwnerChangeSchema,
  RequestedOwnerChange
> = {
  schema: requestOwnerChangeSchema,
  roles: ["owner"],
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase.rpc("request_owner_change", {
      p_organisation_id: organisationId,
      p_kind: data.kind,
      p_membership_id: data.kind === "invite" ? undefined : data.membershipId,
      p_email: data.kind === "invite" ? data.email : undefined,
      p_new_role: data.kind === "demote" ? data.newRole : undefined,
    });
    if (error) throw ownerDbError(error, "request_owner_change");
    const row = rows?.[0];
    if (!row) throw new Error("request_owner_change returned nothing");
    return {
      changeId: row.change_id,
      kind: data.kind,
      status: row.change_status,
      inviteToken: row.invite_token ?? null,
      inviteEmail: data.kind === "invite" ? data.email : null,
    };
  },
};

export const decideOwnerChangeSchema = z.object({
  changeId: z.uuid("Choose a request."),
  decision: z.enum(["approve", "reject", "cancel"], { error: "Choose approve or reject." }),
});

export interface DecidedOwnerChange {
  changeId: string;
  status: OwnerChangeStatus;
  inviteToken: string | null;
}

/**
 * Approves, rejects or withdraws a pending owner change. Any manager may try (a requester who
 * was demoted can still withdraw); the database decides who may do what.
 */
export const decideOwnerChangeSpec: MutationSpec<
  typeof decideOwnerChangeSchema,
  DecidedOwnerChange
> = {
  schema: decideOwnerChangeSchema,
  roles: MANAGER_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase.rpc("decide_owner_change", {
      p_organisation_id: organisationId,
      p_change_id: data.changeId,
      p_decision: data.decision,
    });
    if (error) throw ownerDbError(error, "decide_owner_change");
    const row = rows?.[0];
    if (!row) throw new Error("decide_owner_change returned nothing");
    return { changeId: row.change_id, status: row.change_status, inviteToken: row.invite_token };
  },
};

export { OWNER_CHANGE_KINDS };
