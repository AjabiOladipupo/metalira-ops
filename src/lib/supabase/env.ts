/**
 * Public Supabase settings, safe for the browser.
 *
 * Read by literal property name so Next.js inlines them into client bundles.
 * The secret key is never read here; only the admin client under src/server/ reads it.
 */
export interface SupabasePublicEnv {
  url: string;
  publishableKey: string;
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  const missing = [
    url ? null : "NEXT_PUBLIC_SUPABASE_URL",
    publishableKey ? null : "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ].filter((name): name is string => name !== null);

  if (!url || !publishableKey) {
    throw new Error(
      `Supabase is not configured: set ${missing.join(" and ")}. ` +
        "Local values come from `pnpm exec supabase status -o env`.",
    );
  }

  return { url, publishableKey };
}
