import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { invitePasswordStep, PASSWORD_SET_AT_KEY, type InvitePasswordStep } from "@/lib/auth/amr";
import { SET_PASSWORD_PATH, safeNextPath } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import { sessionUsedPassword } from "./claims";
import { appOrigin } from "./origin";

/**
 * Passwords chosen after an email link (slice 1.13). A password counts only once it was chosen
 * after the address was confirmed, from an email-link session: app_metadata.password_set_at,
 * written here with the secret key (accounts confirmed before the 1.13 migration were
 * backfilled). The join page, the set-password page and password sign-in all apply that rule,
 * and accept_membership_invite applies it in the database.
 */

type Client = SupabaseClient<Database>;

/** The join page's password step for the signed-in user. Verified with getUser. */
export async function invitePasswordStepFor(supabase: Client): Promise<InvitePasswordStep> {
  const [usedPassword, { data }] = await Promise.all([
    sessionUsedPassword(supabase),
    supabase.auth.getUser(),
  ]);
  return invitePasswordStep({
    usedPassword,
    confirmedAt: data.user?.email_confirmed_at ?? null,
    passwordSetAt: data.user?.app_metadata?.[PASSWORD_SET_AT_KEY],
  });
}

/** Records that `userId` chose their password from an email-link session. */
export async function markPasswordChosen(userId: string): Promise<void> {
  const { error } = await createAdminSupabase().auth.admin.updateUserById(userId, {
    app_metadata: { [PASSWORD_SET_AT_KEY]: new Date().toISOString() },
  });
  if (error) throw new Error(`Could not record the new password: ${error.code ?? error.name}`);
}

/**
 * Ends the user's other sessions (public.end_other_sessions deletes them from auth.sessions, so
 * their refresh tokens die; an access token already issued lasts at most jwt_expiry, 15 minutes),
 * then refreshes this session so its token carries the new password_set_at. Failures are logged
 * by error code only and never block the user.
 */
export async function afterPasswordChosen(supabase: Client): Promise<void> {
  const { error } = await supabase.rpc("end_other_sessions");
  if (error) console.error("identity.end_other_sessions_failed:", error.code);
  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error) {
    console.error("identity.refresh_after_password_failed:", refreshed.error.code ?? "unknown");
  }
}

/**
 * Sets the signed-in user's password from an email-link session and records it. Returns a
 * field error to show, or null when it worked.
 */
export async function chooseOwnPassword(
  supabase: Client,
  userId: string,
  password: string,
): Promise<string | null> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error && error.code !== "same_password") {
    if (error.code === "weak_password") {
      return "Choose a stronger password with letters and numbers.";
    }
    throw new Error(`Could not set the password: ${error.code ?? "unknown"}`);
  }
  await markPasswordChosen(userId);
  await afterPasswordChosen(supabase);
  return null;
}

/** The link an email for choosing a password lands on, back through /auth/callback. */
export async function setPasswordLinkTarget(next: string): Promise<string> {
  const target = `${SET_PASSWORD_PATH}?next=${encodeURIComponent(safeNextPath(next))}`;
  return `${await appOrigin()}/auth/callback?next=${encodeURIComponent(target)}`;
}

/** Emails `email` a sign-in link that lands on the set-password page. Never throws. */
export async function sendSetPasswordLink(email: string, next: string): Promise<void> {
  try {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: await setPasswordLinkTarget(next) },
    });
    if (error) console.error("identity.set_password_link_failed:", error.code ?? "unknown");
  } catch (error) {
    console.error(
      "identity.set_password_link_failed:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
