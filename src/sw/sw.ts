/// <reference lib="webworker" />
/**
 * The worker app's service worker (slice 3.4), bundled by scripts/build-sw.mjs (esbuild, before
 * `next build` and `next dev`) into public/sw.js, which injects the precache list into
 * `self.__SW_MANIFEST`. Registered with scope /m, so it never controls the manager app (/app)
 * or the marketing pages.
 *
 * Caching per request type is decided in src/lib/offline/sw-routes.ts (table there). In short:
 * hashed static assets are cached, the offline page and the worker icons are precached, worker
 * page loads go to the network and fall back to the offline page, and nothing that can hold
 * personal data (pages, RSC payloads, Server Actions, API, Supabase) is ever cached.
 *
 * Updates: a new version waits until the page asks it to take over ("New version ready, tap to
 * reload"), so a worker is never reloaded in the middle of a clock-in.
 */
import type { PrecacheEntry, RouteMatchCallbackOptions, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist, StaleWhileRevalidate } from "serwist";

import { BACKGROUND_SYNC_TAG, DRAIN_MESSAGE } from "../lib/offline/sync-constants";
import {
  CHECKPOINT_PATH,
  classifyRequest,
  OFFLINE_PATH,
  staticAssetsIn,
} from "../lib/offline/sw-routes";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const STATIC_CACHE = "m-static";
const PUBLIC_CACHE = "m-public";

const is =
  (wanted: ReturnType<typeof classifyRequest>) =>
  ({ request, url }: RouteMatchCallbackOptions) =>
    classifyRequest({
      method: request.method,
      url,
      origin: self.location.origin,
      mode: request.mode,
      headers: request.headers,
    }) === wanted;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // Wait for the page's "tap to reload" (Serwist handles the SKIP_WAITING message).
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: is("static"),
      handler: new CacheFirst({
        cacheName: STATIC_CACHE,
        plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },
    {
      matcher: is("public"),
      handler: new StaleWhileRevalidate({ cacheName: PUBLIC_CACHE }),
    },
    {
      // Never cached: the response is the worker's own data.
      matcher: is("navigation"),
      handler: new NetworkOnly(),
    },
  ],
  fallbacks: {
    entries: [
      // Slice 3.8: a checkpoint's QR code opens /m/checkpoint#<token>. With no network the
      // precached scan page (static, no personal data) loads instead of the offline page, keeps
      // the fragment, and saves the scan in the phone's queue.
      {
        url: CHECKPOINT_PATH,
        matcher: ({ request, url }) =>
          request.mode === "navigate" && url.pathname === CHECKPOINT_PATH,
      },
      {
        url: OFFLINE_PATH,
        matcher: ({ request }) => request.mode === "navigate",
      },
    ],
  },
});

/**
 * Warms the static cache with the offline and checkpoint pages' scripts and styles, so they render fully
 * (unsent count, buttons) the first time the phone is offline. Best effort: install never
 * fails because of it.
 */
async function warmOfflinePage(): Promise<void> {
  try {
    const assets: string[] = [];
    for (const page of [OFFLINE_PATH, CHECKPOINT_PATH]) {
      const response = await fetch(page, { credentials: "same-origin", cache: "no-store" });
      if (response.ok) assets.push(...staticAssetsIn(await response.text()));
    }
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(
      assets.map(async (asset) => {
        try {
          if (!(await cache.match(asset))) await cache.add(asset);
        } catch {
          // One missing asset should not stop the rest.
        }
      }),
    );
  } catch {
    // Offline during install, or the page moved: the static cache fills as pages are used.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(warmOfflinePage());
});

/**
 * Background Sync (Chrome on Android; not iOS): the browser wakes the worker when the network
 * returns. The page holds the sender, so this asks open worker pages to drain their queue. With
 * no page open the queue waits for the next app start, online event or timer.
 */
self.addEventListener("sync", (event) => {
  const sync = event as ExtendableEvent & { tag?: string };
  if (sync.tag !== BACKGROUND_SYNC_TAG) return;
  sync.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) client.postMessage({ type: DRAIN_MESSAGE });
    }),
  );
});

serwist.addEventListeners();
