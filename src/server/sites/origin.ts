import "server-only";

/** The production app, for codes printed where no app URL is configured. */
export const PRODUCTION_ORIGIN = "https://ops.metaliratech.com";

export interface OriginEnv {
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
  NODE_ENV?: string;
  PORT?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin of `value` when it is https, or http on this machine; else null. */
export function validOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return url.origin;
    return null;
  } catch {
    return null;
  }
}

/**
 * The origin printed in checkpoint QR codes (slice 2.2). Stickers outlive deployments and
 * requests, so it never comes from a request header:
 * - production (and anything not marked preview or development): a valid NEXT_PUBLIC_APP_URL,
 *   else the production app;
 * - a Vercel preview: that deployment's own VERCEL_URL, so its codes can be tried there;
 * - development: a valid NEXT_PUBLIC_APP_URL, else localhost.
 */
export function checkpointOrigin(env: OriginEnv): string {
  const configured = validOrigin(env.NEXT_PUBLIC_APP_URL);
  if (env.VERCEL_ENV === "preview") {
    const deployment = env.VERCEL_URL ? validOrigin(`https://${env.VERCEL_URL}`) : null;
    return deployment ?? configured ?? PRODUCTION_ORIGIN;
  }
  const development =
    env.VERCEL_ENV === "development" || (!env.VERCEL_ENV && env.NODE_ENV === "development");
  if (development) {
    const port = /^\d{2,5}$/.test(env.PORT ?? "") ? env.PORT : "3000";
    return configured ?? `http://localhost:${port}`;
  }
  return configured ?? PRODUCTION_ORIGIN;
}
