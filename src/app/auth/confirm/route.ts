import type { EmailOtpType } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { finishEmailLink } from "@/server/identity/finish-sign-in";

// Sign-up confirmation and magic links only. Password recovery, invites and email changes
// need their own screens and arrive with them.
const EMAIL_OTP_TYPES: readonly EmailOtpType[] = ["signup", "magiclink", "email"];

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (EMAIL_OTP_TYPES as readonly string[]).includes(value);
}

/**
 * Token-hash return from the email templates in supabase/templates
 * (`?token_hash=…&type=…`). Works in any browser, so it is the flow the templates use.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  return finishEmailLink(request, async (supabase) => {
    if (!tokenHash || tokenHash.length > 512 || !isEmailOtpType(type)) return false;
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    return !error;
  });
}
