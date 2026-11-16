/** Production app URL, used when NEXT_PUBLIC_APP_URL is not set. */
export const PRODUCTION_APP_URL = "https://ops.metaliratech.com";

/** Default sender until EMAIL_FROM is set. metaliratech.com is verified in Resend (16 Nov 2026). */
export const DEFAULT_EMAIL_FROM = "Metalira Ops <dipo@metaliratech.com>";

/**
 * Absolute base URL for links and images in emails. Emails are read outside the app,
 * so every URL must be absolute. Trailing slashes are removed.
 */
export function emailAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.NEXT_PUBLIC_APP_URL?.trim();
  const base = raw && /^https?:\/\//i.test(raw) ? raw : PRODUCTION_APP_URL;
  return base.replace(/\/+$/, "");
}

/**
 * True when a missing email key must fail loudly: Vercel production, or a production
 * Node build outside Vercel. Previews, development and tests skip with a log instead.
 */
export function isProductionEmailEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "production";
  return env.NODE_ENV === "production";
}
