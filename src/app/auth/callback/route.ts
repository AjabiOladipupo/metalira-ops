import type { NextRequest } from "next/server";

import { finishEmailLink } from "@/server/identity/finish-sign-in";

/**
 * PKCE return from a Supabase email link (`?code=`). Works when the link is opened in the same
 * browser that asked for it, because the code verifier lives in that browser's cookies.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  return finishEmailLink(request, async (supabase) => {
    if (!code || code.length > 512) return false;
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return !error;
  });
}
