// Sentry for the Node.js server runtime, loaded by src/instrumentation.ts.
// Without a DSN this does nothing, so local runs, CI and previews without Sentry still work.
import * as Sentry from "@sentry/nextjs";

import { sharedSentryOptions } from "@/lib/observability/sentry-options";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    ...sharedSentryOptions(process.env.VERCEL_ENV || process.env.NODE_ENV),
  });
}
