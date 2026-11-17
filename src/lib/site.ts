/** Public site URL when NEXT_PUBLIC_APP_URL is not set (production domain). */
export const SITE_URL_FALLBACK = "https://ops.metaliratech.com";

/**
 * Absolute base URL for the public pages: sitemap, robots and social cards. Uses
 * NEXT_PUBLIC_APP_URL when it is an http(s) URL, otherwise the production domain. No trailing
 * slash.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.NEXT_PUBLIC_APP_URL?.trim();
  const base = raw && /^https?:\/\//i.test(raw) ? raw : SITE_URL_FALLBACK;
  return base.replace(/\/+$/, "");
}

/** Public marketing pages, in sitemap order. */
export const MARKETING_PATHS = [
  "/",
  "/for/owners",
  "/for/hr",
  "/for/finance",
  "/for/operations",
  "/for/workers",
] as const;
