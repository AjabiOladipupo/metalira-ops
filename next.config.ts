import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

// The offline queue's test sender and hooks (slice 3.4) are for the Playwright build only. A
// Vercel build with the flag set would ship them, so it fails instead (security review M1).
if (process.env.VERCEL && process.env.NEXT_PUBLIC_OFFLINE_TEST_SENDER) {
  throw new Error("NEXT_PUBLIC_OFFLINE_TEST_SENDER must never be set on Vercel.");
}

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    return [
      {
        // The worker app's service worker (slice 3.4, built by scripts/build-sw.mjs). Never
        // cached by the browser or the CDN, so a new version is found on the next visit; its own
        // CSP limits it to this origin. Registered with scope /m (src/app/m/_components/offline).
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'; worker-src 'self'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  experimental: {
    serverActions: {
      // Company logos may be up to 1 MB (slice 1.1); multipart adds a little on top. The logo
      // action checks the size itself before reading the file.
      bodySizeLimit: "2mb",
    },
  },
  turbopack: {
    // Sentry injects debug IDs itself after compile and rewrites the source maps to match.
    // Turbopack's native debug IDs would be a second, earlier snippet that Sentry's step
    // shifts by one line without fixing the maps, so production stack traces stay minified.
    debugIds: false,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Source maps are uploaded only when SENTRY_AUTH_TOKEN is set (Vercel builds).
// Without it the build skips Sentry's upload and release steps and still passes.
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: { disable: !uploadSourceMaps, deleteSourcemapsAfterUpload: true },
  release: { create: uploadSourceMaps, finalize: uploadSourceMaps },
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeReplayIframe: true,
    excludeReplayShadowDom: true,
    excludeReplayWorker: true,
  },
});
