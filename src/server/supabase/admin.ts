import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getSupabasePublicEnv } from "@/lib/supabase/env";
import type { Database } from "@/types/db";

/**
 * Supabase client with the secret key. It bypasses RLS, so use it only for
 * work no signed-in user can do (system jobs, webhooks, invites) and always
 * scope queries to an organisation yourself.
 *
 * This is the only place SUPABASE_SECRET_KEY is read. Never import this module
 * outside src/server/ (ESLint and tests/unit/secret-key-boundary.test.ts
 * enforce it).
 */
export function createAdminSupabase() {
  const { url } = getSupabasePublicEnv();
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("Supabase is not configured: set SUPABASE_SECRET_KEY (server only).");
  }

  return createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
