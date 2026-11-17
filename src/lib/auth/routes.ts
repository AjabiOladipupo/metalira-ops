/**
 * Auth routes and the pure decisions around them. Isomorphic: used by src/proxy.ts, server
 * actions, route handlers and unit tests.
 */

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";
export const CHECK_EMAIL_PATH = "/check-email";
export const NO_ACCESS_PATH = "/no-access";
export const APP_HOME_PATH = "/app";
/** The worker app (phone PWA). Workers sign in with company code, staff ID and PIN. */
export const WORKER_HOME_PATH = "/m";
export const WORKER_SIGN_IN_PATH = "/m/sign-in";
/** Invite links: /m/invite/<token>. */
export const WORKER_INVITE_PATH = "/m/invite";
/** Team (manager) invite links: /join/<token> (slice 1.12). */
export const TEAM_JOIN_PATH = "/join";

/**
 * A worker's login is a Supabase Auth user marked in `app_metadata` (which only the server's
 * secret key can write), so the proxy can tell a worker session from a manager's without a
 * database read. Roles are still checked next to the data and by RLS.
 */
export const WORKER_LOGIN_MARK = { key: "login", value: "worker" } as const;

/** True when a JWT's `app_metadata` claim marks a worker login. */
export function isWorkerAppMetadata(appMetadata: unknown): boolean {
  return (
    typeof appMetadata === "object" &&
    appMetadata !== null &&
    (appMetadata as Record<string, unknown>)[WORKER_LOGIN_MARK.key] === WORKER_LOGIN_MARK.value
  );
}

/** Pages for signed-out managers. A signed-in visitor is sent on to the app instead. */
const SIGNED_OUT_ONLY = new Set([SIGN_IN_PATH, SIGN_UP_PATH]);

function isProtected(pathname: string): boolean {
  return pathname === APP_HOME_PATH || pathname.startsWith(`${APP_HOME_PATH}/`);
}

/** A team invite page, /join/<64 hex characters>: where an invited manager signs in or up. */
function isTeamJoin(pathname: string): boolean {
  return /^\/join\/[0-9a-f]{64}$/.test(pathname);
}

function isWorkerApp(pathname: string): boolean {
  return pathname === WORKER_HOME_PATH || pathname.startsWith(`${WORKER_HOME_PATH}/`);
}

/** Worker pages anyone may open: sign-in and invite links. */
function isWorkerPublic(pathname: string): boolean {
  return pathname === WORKER_SIGN_IN_PATH || pathname.startsWith(`${WORKER_INVITE_PATH}/`);
}

/**
 * A same-site path to send the user to after signing in, or `fallback`. Blocks open redirects:
 * only a single leading slash is allowed (no `//host`, `/\host` or scheme), no control
 * characters, and the path must stay inside the manager app (or be a team invite page, so an
 * invited manager comes back to their invite after signing in or confirming their email).
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
  if (!isProtected(url.pathname) && !isTeamJoin(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Where an emailed auth link lands the user. The link carries `next` itself (sign-up
 * confirmation, PKCE callback), or `redirect_to`: the magic-link template passes Supabase's
 * `{{ .RedirectTo }}` through, which is the `emailRedirectTo` the app asked for
 * (`…/auth/callback?next=…`) or, when that was not on the project's allow list, the Site URL.
 * Only the path in its `next` is used, never its origin, and it goes through safeNextPath.
 */
export function emailLinkNextPath(params: URLSearchParams): string {
  const next = params.get("next");
  if (next !== null) return safeNextPath(next);

  const redirectTo = params.get("redirect_to");
  if (!redirectTo || redirectTo.length > 1024) return APP_HOME_PATH;
  try {
    return safeNextPath(new URL(redirectTo).searchParams.get("next"));
  } catch {
    return APP_HOME_PATH;
  }
}

export type ProxyDecision = { type: "next" } | { type: "redirect"; location: string };

/**
 * The optimistic check the proxy makes on every matched request. It only knows whether the
 * request carries a valid session and whether that session is a worker login; roles and
 * organisations are checked again next to the data (src/server/identity/session.ts,
 * worker-session.ts) and by row-level security.
 *
 * - Manager app (/app) and team invites (/join): signed out goes to /sign-in (the invite page
 *   itself is public); a worker session goes to the worker app.
 * - Worker app (/m): signed out goes to /m/sign-in, except sign-in and invite links; a worker
 *   who is already signed in skips /m/sign-in.
 */
export function proxyDecision(
  pathname: string,
  search: string,
  hasUser: boolean,
  isWorker = false,
): ProxyDecision {
  if (isWorkerApp(pathname)) {
    if (!hasUser && !isWorkerPublic(pathname)) {
      return { type: "redirect", location: WORKER_SIGN_IN_PATH };
    }
    if (hasUser && isWorker && pathname === WORKER_SIGN_IN_PATH) {
      return { type: "redirect", location: WORKER_HOME_PATH };
    }
    return { type: "next" };
  }
  if (
    hasUser &&
    isWorker &&
    (isProtected(pathname) || SIGNED_OUT_ONLY.has(pathname) || isTeamJoin(pathname))
  ) {
    return { type: "redirect", location: WORKER_HOME_PATH };
  }
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
