import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { auditChannelHeaders, type SendableAuditChannel } from "@/lib/audit-channel";
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
 *
 * `channel` labels the audit rows this client's writes produce (src/lib/audit-channel.ts):
 * `web` unless the caller is the worker app or an import.
 */
export async function createServerSupabase(options: { channel?: SendableAuditChannel } = {}) {
  const { url, publishableKey } = getSupabasePublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, publishableKey, {
    global: { headers: auditChannelHeaders(options.channel ?? "web") },
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
