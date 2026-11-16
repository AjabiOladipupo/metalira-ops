import { createHash, timingSafeEqual } from "node:crypto";

/** Header that carries SENTRY_TEST_TOKEN to POST /api/debug/sentry. */
export const SENTRY_TEST_HEADER = "x-debug-token";

/** Below this length a configured token is treated as unset, so a weak token never opens the route. */
const MIN_TOKEN_LENGTH = 16;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * True only when a strong SENTRY_TEST_TOKEN is configured and `provided` equals it.
 * Both sides are hashed to the same length first, so the compare is constant-time and
 * does not leak the token length.
 */
export function isSentryTestTokenValid(
  provided: string | null | undefined,
  expected: string | undefined = process.env.SENTRY_TEST_TOKEN,
): boolean {
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  if (!provided) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}
