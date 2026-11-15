import { isSentryTestTokenValid, SENTRY_TEST_HEADER } from "@/server/observability/sentry-test";

// Token-gated test error for checking that server errors reach Sentry.
// Without the right x-debug-token header every request gets an empty 404, so the route is not revealed.

function notFound() {
  return new Response(null, { status: 404 });
}

export async function POST(request: Request) {
  if (!isSentryTestTokenValid(request.headers.get(SENTRY_TEST_HEADER))) {
    return notFound();
  }
  // Reported to Sentry by onRequestError in src/instrumentation.ts; the caller sees a 500.
  throw new Error(`Sentry test error ${new Date().toISOString()}`);
}

export async function GET() {
  return notFound();
}
