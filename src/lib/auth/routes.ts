/**
 * Auth routes and the pure decisions around them. Isomorphic: used by src/proxy.ts, server
 * actions, route handlers and unit tests.
 */

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";
export const CHECK_EMAIL_PATH = "/check-email";
export const NO_ACCESS_PATH = "/no-access";
export const APP_HOME_PATH = "/app";
/** Where a worker-only user goes. Phase 1 (worker sign-in) turns /m into the worker app. */
export const WORKER_HOME_PATH = "/m/sign-in";

/** Pages for signed-out managers. A signed-in visitor is sent on to the app instead. */
const SIGNED_OUT_ONLY = new Set([SIGN_IN_PATH, SIGN_UP_PATH]);

function isProtected(pathname: string): boolean {
  return pathname === APP_HOME_PATH || pathname.startsWith(`${APP_HOME_PATH}/`);
}

/**
 * A same-site path to send the user to after signing in, or `fallback`. Blocks open redirects:
 * only a single leading slash is allowed (no `//host`, `/\host` or scheme), no control
 * characters, and the path must stay inside the manager app.
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback: string = APP_HOME_PATH,
): string {
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (/\p{Cc}/u.test(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, "http://n.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://n.invalid") return fallback;
  if (!isProtected(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

export type ProxyDecision = { type: "next" } | { type: "redirect"; location: string };

/**
 * The optimistic check the proxy makes on every matched request. It only knows whether the
 * request carries a valid session; roles and organisations are checked again next to the data
 * (src/server/identity/session.ts) and by row-level security.
 */
export function proxyDecision(pathname: string, search: string, hasUser: boolean): ProxyDecision {
  if (!hasUser && isProtected(pathname)) {
    const next = `${pathname}${search}`;
    const location =
      next === APP_HOME_PATH
        ? SIGN_IN_PATH
        : `${SIGN_IN_PATH}?next=${encodeURIComponent(safeNextPath(next))}`;
    return { type: "redirect", location };
  }
  if (hasUser && SIGNED_OUT_ONLY.has(pathname)) {
    return { type: "redirect", location: safeNextPath(new URLSearchParams(search).get("next")) };
  }
  return { type: "next" };
}
