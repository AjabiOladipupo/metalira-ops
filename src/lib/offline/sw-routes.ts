/**
 * What the worker app's service worker does with each request (slice 3.4). Pure, so the rules
 * are unit tested; src/sw/sw.ts maps each class to a Serwist strategy.
 *
 * | Class        | Requests                                              | Strategy                          |
 * | ------------ | ----------------------------------------------------- | --------------------------------- |
 * | static       | GET /_next/static/* (content-hashed JS, CSS, fonts)   | Cache first, 30 days, 300 entries |
 * | public       | GET /icons/worker-*, /worker.webmanifest              | Precached; stale-while-revalidate |
 * | navigation   | Page loads of /m and /m/*                             | Network only; offline page if the network fails |
 * | passthrough  | Everything else: RSC payloads, Server Actions (POST), | Not touched by the service worker |
 * |              | /api, /auth, /sw.js, the manager app, Supabase,      | (straight to the network, never   |
 * |              | Sentry and every other origin                         | cached)                           |
 *
 * Pages and RSC payloads of signed-in screens carry personal data (names, shifts, payslips),
 * so they are never written to a cache. Only the offline page (static, no personal data) is.
 */
import { WORKER_CHECKPOINT_PATH, WORKER_OFFLINE_PATH } from "../auth/routes";

export type RequestClass = "static" | "public" | "navigation" | "passthrough";

/** The worker app: /m and everything under /m/ (not /me-something or /manager). */
export function isWorkerAppPath(pathname: string): boolean {
  return pathname === "/m" || pathname.startsWith("/m/");
}

/** The offline page, precached and shown when a worker page cannot load. */
export const OFFLINE_PATH = WORKER_OFFLINE_PATH;

/** The checkpoint scan page (slice 3.8), precached and shown for /m/checkpoint offline. */
export const CHECKPOINT_PATH = WORKER_CHECKPOINT_PATH;

const PUBLIC_FILE = /^\/(icons\/worker-[\w-]+\.png|worker\.webmanifest)$/;

export interface RequestFacts {
  method: string;
  url: URL;
  /** The service worker's own origin. */
  origin: string;
  mode: RequestMode;
  headers: Pick<Headers, "get">;
}

export function classifyRequest({
  method,
  url,
  origin,
  mode,
  headers,
}: RequestFacts): RequestClass {
  if (method !== "GET") return "passthrough";
  if (url.origin !== origin) return "passthrough";
  // RSC payloads (soft navigations and prefetches) hold the same data as the page.
  if (headers.get("RSC") !== null || url.searchParams.has("_rsc")) return "passthrough";
  if (url.pathname.startsWith("/_next/static/")) return "static";
  if (PUBLIC_FILE.test(url.pathname)) return "public";
  if (mode === "navigate" && isWorkerAppPath(url.pathname)) return "navigation";
  return "passthrough";
}

/** Asset URLs (/_next/static/...) referenced by an HTML page, to warm the cache at install. */
export function staticAssetsIn(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\/_next\/static\/[A-Za-z0-9._~\-/%]+/g)) {
    found.add(match[0]);
  }
  return [...found];
}
