import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { invitePasswordStep, PASSWORD_SET_AT_KEY, type InvitePasswordStep } from "@/lib/auth/amr";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import { sessionUsedPassword } from "./claims";

/**
 * The join page's password step for the signed-in user (slice 1.13): how they signed in (the
 * token's `amr`) and, from Auth, when their address was confirmed and whether a password was
 * chosen from an email link since. Verified with getUser, so it is safe in actions too.
 */
export async function invitePasswordStepFor(
  supabase: SupabaseClient<Database>,
  invitedAt: string,
): Promise<InvitePasswordStep> {
  const [usedPassword, { data }] = await Promise.all([
    sessionUsedPassword(supabase),
    supabase.auth.getUser(),
  ]);
  return invitePasswordStep({
    usedPassword,
    confirmedAt: data.user?.email_confirmed_at ?? null,
    passwordSetAt: data.user?.app_metadata?.[PASSWORD_SET_AT_KEY],
    invitedAt,
  });
}

/**
 * Records that `userId` chose their password from an email-link session (app_metadata, which
 * only the secret key writes; accept_membership_invite reads it).
 */
export async function markPasswordChosen(userId: string): Promise<void> {
  const { error } = await createAdminSupabase().auth.admin.updateUserById(userId, {
    app_metadata: { [PASSWORD_SET_AT_KEY]: new Date().toISOString() },
  });
  if (error) throw new Error(`Could not record the new password: ${error.code ?? error.name}`);
}
