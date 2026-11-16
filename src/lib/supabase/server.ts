import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/types/db";

import { getSupabasePublicEnv } from "./env";

/**
 * Supabase client for Server Components, Server Functions and Route Handlers.
 * Uses the publishable key plus the user's session cookies, so every query runs
 * under RLS as that user.
 *
 * With `cacheComponents` on, this reads `cookies()`: call it inside a
 * `<Suspense>` boundary (or from a Server Function or Route Handler), and never
 * inside `"use cache"`.
 */
export async function createServerSupabase() {
  const { url, publishableKey } = getSupabasePublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. The session is refreshed in
          // Server Functions, Route Handlers and the proxy instead.
        }
      },
    },
  });
}
