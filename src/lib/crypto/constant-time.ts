import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares two secrets (tokens, signature headers, hashes) in constant time.
 *
 * Both values are hashed with SHA-256 first, so the comparison always runs over 32 equal-length
 * buffers: it never throws on a length mismatch and does not leak the expected length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
