import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { signedInWithEmailLink } from "@/lib/auth/amr";
import type { Database } from "@/types/db";

export interface ClaimsUser {
  id: string;
  email: string;
}

/**
 * The user named by the session's access token, from `auth.getClaims()`. With asymmetric signing
 * keys (ES256) the signature is checked locally against the cached JWKS, with no call to the
 * Auth server; an expired or tampered token reads as signed out. Render paths only: a session
 * revoked on the server stays valid here until the token expires, so every write verifies with
 * `auth.getUser()` instead.
 */
export async function claimsUser(supabase: SupabaseClient<Database>): Promise<ClaimsUser | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  const { sub, email } = data.claims;
  if (typeof sub !== "string" || !sub) return null;
  return { id: sub, email: typeof email === "string" ? email : "" };
}

/**
 * True only when the session was opened from an email link (the token's `amr`, checked by
 * getClaims). False for a password sign-in, no session, a bad token or an unreadable claim, so
 * every caller fails closed (slice 1.13).
 */
export async function sessionFromEmailLink(supabase: SupabaseClient<Database>): Promise<boolean> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return false;
  return signedInWithEmailLink((data.claims as { amr?: unknown }).amr);
}
