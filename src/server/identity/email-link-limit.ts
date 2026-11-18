import "server-only";

import { createHash } from "node:crypto";

import { createAdminSupabase } from "@/server/supabase/admin";

import { clientIp } from "./worker-sign-in";

/**
 * A cap on email links the app asks Supabase to send (slice 1.13): the join page's "Email me a
 * link", owner sign-up and the set-password link. Supabase's own limit counts the server's
 * address, not the visitor's, so the app counts per subject (invite token or typed email, 5 an
 * hour) and per visitor address (`x-real-ip`, 20 an hour) in private.email_link_sends. Keys are
 * hashes; nothing readable is stored. Fails closed.
 */

function hash(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(`${kind}:${value.trim().toLowerCase()}`).digest("hex")}`;
}

export async function emailLinkAllowed(
  subject: { kind: "token" | "email"; value: string },
  headers: { get(name: string): string | null },
): Promise<boolean> {
  // Without x-real-ip (local runs; Vercel always sets it) only the subject is counted, so one
  // shared "unknown" counter can't lock everybody out.
  const ip = clientIp(headers);
  const keys = [hash(subject.kind, subject.value), ...(ip ? [hash("ip", ip)] : [])];
  try {
    const { data, error } = await createAdminSupabase().rpc("email_link_allowed", {
      p_keys: keys,
    });
    if (error) throw new Error(error.code);
    return data === true;
  } catch (error) {
    console.error(
      "identity.email_link_limit_failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
}
