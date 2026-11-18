import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { describeOwnerChange, isOwnerChangeKind } from "@/lib/owners";
import { ROLE_LABELS, isRole } from "@/lib/roles";
import { emailDisplayName, sendOwnerChangeEmail } from "@/server/email/team";
import type { OwnerChangeEvent } from "@/server/email/templates/owner-change";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * Owner-change emails (slice 1.13): every owner change, and every request, rejection and
 * withdrawal, emails all owners of the company with a confirmed address, plus the owner removed
 * or demoted (they are no longer an owner once it is done). Reads with the secret key: owners'
 * addresses live in Supabase Auth. Names that look like a web address are left out
 * (emailDisplayName). Addresses are never logged; failures are logged by error name only.
 * Sent with `after()` from the actions, so the change never waits for email.
 */

type Admin = SupabaseClient<Database>;

export interface OwnerNoticeDeps {
  admin: Admin;
  send: typeof sendOwnerChangeEmail;
}

function logFailure(what: string, error: unknown) {
  console.error(`owners.${what}:`, error instanceof Error ? error.name : "unknown");
}

async function confirmedEmail(admin: Admin, userId: string): Promise<string | null> {
  const { data } = await admin.auth.admin.getUserById(userId);
  const user = data.user;
  return user?.email && user.email_confirmed_at ? user.email : null;
}

async function ownerIds(admin: Admin, organisationId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("memberships")
    .select("user_id")
    .eq("organisation_id", organisationId)
    .eq("role", "owner");
  if (error) throw new Error(`Could not read owners: ${error.code}`);
  return (data ?? []).map((m) => m.user_id);
}

async function nameOf(admin: Admin, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data } = await admin
    .from("profiles")
    .select("full_name")
    .eq("user_id", userId)
    .maybeSingle();
  return emailDisplayName(data?.full_name?.trim() || null);
}

async function sendAll(
  deps: OwnerNoticeDeps,
  recipients: Iterable<string>,
  build: (to: string, recipientId: string) => Parameters<typeof sendOwnerChangeEmail>[0],
): Promise<number> {
  let sent = 0;
  for (const recipientId of new Set(recipients)) {
    try {
      const to = await confirmedEmail(deps.admin, recipientId);
      if (!to) continue;
      const result = await deps.send(build(to, recipientId));
      if (result.status === "sent") sent += 1;
    } catch (error) {
      logFailure("notice_failed", error);
    }
  }
  return sent;
}

/** Emails the owners about one owner change request and what happened to it. Never throws. */
export async function notifyOwnerChange(
  changeId: string,
  event: Exclude<OwnerChangeEvent, "joined">,
  actorId: string,
  deps?: Partial<OwnerNoticeDeps>,
): Promise<number> {
  try {
    const all: OwnerNoticeDeps = {
      admin: deps?.admin ?? createAdminSupabase(),
      send: deps?.send ?? sendOwnerChangeEmail,
    };
    const { data: change, error } = await all.admin
      .from("owner_changes")
      .select(
        "id, organisation_id, kind, target_user_id, invite_email, new_role, requested_by, single_owner",
      )
      .eq("id", changeId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the change: ${error.code}`);
    if (!change || !isOwnerChangeKind(change.kind)) return 0;

    const { data: org } = await all.admin
      .from("organisations")
      .select("name")
      .eq("id", change.organisation_id)
      .maybeSingle();
    if (!org) return 0;

    const [targetName, requesterName, actorName] = await Promise.all([
      nameOf(all.admin, change.target_user_id),
      nameOf(all.admin, change.requested_by),
      nameOf(all.admin, actorId),
    ]);
    const summary = describeOwnerChange({
      kind: change.kind,
      targetName,
      inviteEmail: emailDisplayName(change.invite_email),
      newRoleLabel:
        change.new_role && isRole(change.new_role) ? ROLE_LABELS[change.new_role] : null,
      requesterName,
      selfDemotion: change.kind === "demote" && change.target_user_id === change.requested_by,
    });

    const recipients = await ownerIds(all.admin, change.organisation_id);
    // A removed or demoted owner hears about it too, though they are no longer an owner.
    if (change.target_user_id && (change.kind === "remove" || change.kind === "demote")) {
      recipients.push(change.target_user_id);
    }
    return await sendAll(all, recipients, (to, recipientId) => ({
      to,
      idempotencyKey: `owner-change/${change.id}/${event}/${recipientId}`,
      organisationName: org.name,
      event,
      summary,
      actorName,
      singleOwner: change.single_owner,
    }));
  } catch (error) {
    logFailure("notice_failed", error);
    return 0;
  }
}

/** Emails the owners that someone accepted an owner invite and is now an owner. Never throws. */
export async function notifyOwnerJoined(
  organisationId: string,
  newOwnerId: string,
  deps?: Partial<OwnerNoticeDeps>,
): Promise<number> {
  try {
    const all: OwnerNoticeDeps = {
      admin: deps?.admin ?? createAdminSupabase(),
      send: deps?.send ?? sendOwnerChangeEmail,
    };
    const { data: org } = await all.admin
      .from("organisations")
      .select("name")
      .eq("id", organisationId)
      .maybeSingle();
    if (!org) return 0;
    const actorName = await nameOf(all.admin, newOwnerId);
    return await sendAll(all, await ownerIds(all.admin, organisationId), (to, recipientId) => ({
      to,
      idempotencyKey: `owner-joined/${organisationId}/${newOwnerId}/${recipientId}`,
      organisationName: org.name,
      event: "joined",
      summary: "A new owner joined",
      actorName,
      singleOwner: false,
    }));
  } catch (error) {
    logFailure("notice_failed", error);
    return 0;
  }
}
