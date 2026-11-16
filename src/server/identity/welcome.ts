import "server-only";

import type { User } from "@supabase/supabase-js";

import type { CreatedOrganisation } from "./sign-up";

/**
 * Sends the welcome email to an owner whose organisation was just created. Call it with
 * next/server `after()` so the redirect is not held up by Resend.
 *
 * Only for a confirmed address taken from the authenticated user, never from form input.
 *
 * TODO(0.5b): slice 0.5b (src/server/email, PR #5) is not on main yet. Once it merges, replace
 * the body with:
 *
 *   await sendWelcomeOwnerEmail({
 *     to: user.email,
 *     ownerName: fullName,
 *     organisationName: org.organisationName,
 *     organisationId: org.organisationId,
 *   });
 *
 * and catch EmailSendError so a failed send is logged, not thrown after the response.
 */
export async function sendOwnerWelcome(
  user: User,
  org: CreatedOrganisation,
  fullName: string | null,
): Promise<void> {
  if (!user.email || !user.email_confirmed_at) return;
  void org;
  void fullName;
}
