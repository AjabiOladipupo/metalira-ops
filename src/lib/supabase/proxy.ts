import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isWorkerAppMetadata } from "@/lib/auth/routes";
import type { Database } from "@/types/db";

import { getSupabasePublicEnv, type SupabasePublicEnv } from "./env";

export interface SessionUpdate {
  /** The response to return (or to copy cookies from): it carries any refreshed auth cookies. */
  response: NextResponse;
  /** The signed-in user's id, or null. Verified from the JWT, never from an unchecked cookie. */
  userId: string | null;
  /** True when the session is a worker's phone login (app_metadata, set only by the server). */
  isWorker: boolean;
}

function publicEnvOrNull(): SupabasePublicEnv | null {
  try {
    return getSupabasePublicEnv();
  } catch {
    return null;
  }
}

/**
 * Refreshes the Supabase session cookies for one proxy request and reports who is signed in.
 *
 * `getClaims()` verifies the access token against the project's signing keys. With asymmetric
 * keys (the local stack and new hosted projects use ES256) that is a local check with a cached
 * JWKS; with a legacy shared secret it falls back to a call to the Auth server.
 *
 * Without Supabase settings (for example a preview with no environment variables) nobody is
 * signed in, so protected pages redirect to sign-in instead of failing.
 */
export async function updateSession(request: NextRequest): Promise<SessionUpdate> {
  let response = NextResponse.next({ request });
  const env = publicEnvOrNull();
  if (!env) return { response, userId: null, isWorker: false };

  const supabase = createServerClient<Database>(env.url, env.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Nothing may run between creating the client and getClaims(): the refresh happens here.
  const { data, error } = await supabase.auth.getClaims();
  const claims = !error && data?.claims ? data.claims : null;
  const sub = claims?.sub;
  const userId = typeof sub === "string" && sub ? sub : null;
  return {
    response,
    userId,
    isWorker: userId !== null && isWorkerAppMetadata(claims?.app_metadata),
  };
}

/** A redirect that keeps any auth cookies `from` refreshed during this request. */
export function redirectWithCookies(
  request: NextRequest,
  location: string,
  from: NextResponse,
): NextResponse {
  const redirect = NextResponse.redirect(new URL(location, request.url));
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  for (const key of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(key);
    if (value) redirect.headers.set(key, value);
  }
  return redirect;
}
