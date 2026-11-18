"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { passwordTrusted, PASSWORD_SET_AT_KEY } from "@/lib/auth/amr";
import { CHECK_EMAIL_PATH, SIGN_IN_PATH, safeNextPath } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";

import { sessionUsedPassword } from "./claims";
import { emailLinkAllowed } from "./email-link-limit";
import { chooseOwnPassword, sendSetPasswordLink } from "./invite-password";
import { formFields, newPasswordSchema } from "./schemas";

/**
 * Set-password (slice 1.13): a manager chooses their password from an email-link session, after
 * confirming their address (owner sign-up, or a password sign-in that wasn't trusted). The
 * password counts once chosen here (app_metadata.password_set_at, written with the secret key);
 * the account's other sessions end.
 */

export type SetPasswordState = { formError?: string; fieldErrors?: { password?: string } } | null;

const FAILED = "That was not saved. Try again in a minute.";

/** Chooses the password, from an email-link session only. */
export async function setPasswordAction(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const fields = formFields(formData);
  const next = safeNextPath(fields.next);
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`);
  if (passwordTrusted(user.app_metadata?.[PASSWORD_SET_AT_KEY], user.email_confirmed_at)) {
    redirect(next);
  }
  // A password sign-in can't choose the trusted password: that is the password in question.
  if (await sessionUsedPassword(supabase)) {
    return { formError: "Open the link we email you to choose your password." };
  }
  const password = newPasswordSchema.safeParse(fields.password ?? "");
  if (!password.success) {
    return { fieldErrors: { password: password.error.issues[0]?.message ?? "Choose a password." } };
  }
  try {
    const refusal = await chooseOwnPassword(supabase, user.id, password.data);
    if (refusal) return { fieldErrors: { password: refusal } };
  } catch (error) {
    console.error(
      "identity.set_password_failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return { formError: FAILED };
  }
  redirect(next);
}

/**
 * For a password session that isn't trusted: signs out and emails a link to choose a password
 * (to the account's own address). Says the same whatever happens.
 */
export async function sendSetPasswordLinkAction(formData: FormData): Promise<void> {
  const next = safeNextPath(formFields(formData).next);
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email;
  await supabase.auth.signOut({ scope: "local" });
  if (email && (await emailLinkAllowed({ kind: "email", value: email }, await headers()))) {
    await sendSetPasswordLink(email, next);
  }
  redirect(`${CHECK_EMAIL_PATH}?sent=password`);
}
