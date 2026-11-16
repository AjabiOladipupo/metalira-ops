import * as Sentry from "@sentry/nextjs";

// Proxy and every route run on Node.js (cacheComponents needs it), so there is no edge config.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
}

// Reports errors from server components, route handlers, server actions and proxy.
export const onRequestError = Sentry.captureRequestError;
