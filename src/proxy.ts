import type { NextRequest } from "next/server";

import { proxyDecision } from "@/lib/auth/routes";
import { redirectWithCookies, updateSession } from "@/lib/supabase/proxy";

/**
 * Next 16 proxy (the renamed middleware). Refreshes the Supabase session cookies and makes the
 * optimistic sign-in checks: no session on /app/* goes to /sign-in and on /m/* (except sign-in
 * and invite links) to /m/sign-in; a signed-in visitor on /sign-in or /sign-up goes to the app;
 * a worker's session on the manager app goes to the worker app (proxyDecision).
 *
 * This is not the authorisation boundary. Pages check the session, organisation and role next
 * to the data (src/server/identity/session.ts), and row-level security checks every query.
 */
export async function proxy(request: NextRequest) {
  const { response, userId, isWorker } = await updateSession(request);
  const { pathname, search } = request.nextUrl;
  const decision = proxyDecision(pathname, search, userId !== null, isWorker);
  if (decision.type === "redirect") {
    return redirectWithCookies(request, decision.location, response);
  }
  return response;
}

export const config = {
  // Only routes that read the session. Server Functions post to these same paths, so they are
  // covered too. /auth/* route handlers manage their own cookies.
  matcher: ["/app/:path*", "/m", "/m/:path*", "/sign-in", "/sign-up", "/no-access", "/join/:path*"],
};
