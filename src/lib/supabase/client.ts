"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/types/db";

import { getSupabasePublicEnv } from "./env";

/**
 * Supabase client for Client Components. Uses the publishable key and the
 * signed-in user's session cookie, so every query runs under RLS.
 */
export function createBrowserSupabase() {
  const { url, publishableKey } = getSupabasePublicEnv();
  return createBrowserClient<Database>(url, publishableKey);
}
