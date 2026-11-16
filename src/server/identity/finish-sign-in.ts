import "server-only";

import { after, NextResponse, type NextRequest } from "next/server";

import { SIGN_IN_PATH, emailLinkNextPath } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";

import { ensureOrganisationForNewUser } from "./sign-up";
import { sendOwnerWelcome } from "./welcome";

type Supabase = Awaited<ReturnType<typeof createServerSupabase>>;

/**
 * Shared end of /auth/callback and /auth/confirm: `establish` turns the link's code or token
 * into a session (setting the auth cookies), then the owner's pending organisation is created
 * and the user lands on `next` (see emailLinkNextPath). Any failure goes back to sign-in with a
 * generic message.
 */
export async function finishEmailLink(
  request: NextRequest,
  establish: (supabase: Supabase) => Promise<boolean>,
): Promise<NextResponse> {
  const url = request.nextUrl;
  const failed = NextResponse.redirect(new URL(`${SIGN_IN_PATH}?error=link`, url));
  if (url.searchParams.has("error") || url.searchParams.has("error_code")) return failed;

  let supabase: Supabase;
  try {
    supabase = await createServerSupabase();
  } catch {
    return failed;
  }

  if (!(await establish(supabase))) return failed;

  const { data } = await supabase.auth.getUser();
  if (!data.user) return failed;
  const user = data.user;

  try {
    const created = await ensureOrganisationForNewUser(supabase, user);
    if (created) {
      after(() => sendOwnerWelcome(user, created, user.user_metadata?.full_name));
    }
  } catch {
    // Signed in but the organisation could not be created: the app shows the no-access page,
    // and the next password sign-in tries again.
  }

  return NextResponse.redirect(new URL(emailLinkNextPath(url.searchParams), url));
}
