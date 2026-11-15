// Sentry for the browser. Runs before hydration, so keep it synchronous and small.
// Without NEXT_PUBLIC_SENTRY_DSN this does nothing.
import * as Sentry from "@sentry/nextjs";

import { sharedSentryOptions } from "@/lib/observability/sentry-options";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    ...sharedSentryOptions(process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV),
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
