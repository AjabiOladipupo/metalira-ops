import "server-only";

import type { User } from "@supabase/supabase-js";

import { sendWelcomeOwnerEmail } from "@/server/email";

import type { CreatedOrganisation } from "./sign-up";

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
  fullName: string | null,
): Promise<void> {
  if (!user.email || !user.email_confirmed_at) return;
  try {
    await sendWelcomeOwnerEmail({
      to: user.email,
      ownerName: fullName?.trim() || user.email.slice(0, user.email.indexOf("@")) || "there",
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
