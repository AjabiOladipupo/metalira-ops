import "server-only";

import type { User } from "@supabase/supabase-js";

import { sendWelcomeOwnerEmail } from "@/server/email";

import { fullNameSchema } from "./names";
import type { CreatedOrganisation } from "./sign-up";

/**
 * The name to greet the owner by. `fullName` usually comes from user_metadata, which anyone with
 * the publishable key can set, so it is used only when it passes the sign-up form's rules
 * (plain text, no web address); otherwise the name part of the confirmed address stands in.
 */
export function ownerGreetingName(email: string, fullName: unknown): string {
  const parsed = fullNameSchema.safeParse(fullName);
  if (parsed.success) return parsed.data;
  return email.slice(0, email.indexOf("@")) || "there";
}

/**
 * Sends the welcome email to an owner whose organisation was just created. Call it inside
 * next/server `after()` so the redirect never waits for Resend.
 *
 * The address comes from the authenticated user and only once Supabase has confirmed it, never
 * from form input (see sendWelcomeOwnerEmail). The email is sent once per organisation (Resend
 * idempotency key). Without RESEND_API_KEY it is skipped with a log on previews and in
 * development, and fails in production; either way the failure is logged here, after the
 * response, and never reaches the user.
 */
export async function sendOwnerWelcome(
  user: User,
  org: CreatedOrganisation,
  fullName: unknown,
): Promise<void> {
  if (!user.email || !user.email_confirmed_at) return;
  try {
    await sendWelcomeOwnerEmail({
      to: user.email,
      ownerName: ownerGreetingName(user.email, fullName),
      organisationName: org.organisationName,
      organisationId: org.organisationId,
    });
  } catch (error) {
    console.error(
      `Welcome email not sent for organisation ${org.organisationId}:`,
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
  }
}
