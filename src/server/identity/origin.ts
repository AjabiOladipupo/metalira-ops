import "server-only";

import { headers } from "next/headers";

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Base URL for links in auth emails (`emailRedirectTo`). NEXT_PUBLIC_APP_URL wins when set;
 * otherwise the request's own origin, then the Vercel deployment URL, then localhost.
 *
 * A forged Origin header cannot send someone else's link elsewhere: Supabase Auth only
 * redirects to URLs on the project's allow list and falls back to the Site URL.
 */
export async function appOrigin(): Promise<string> {
  const configured = originOf(process.env.NEXT_PUBLIC_APP_URL);
  if (configured) return configured;

  const h = await headers();
  const fromRequest = originOf(h.get("origin"));
  if (fromRequest) return fromRequest;

  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}
