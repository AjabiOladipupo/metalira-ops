/**
 * CLAUDE.md stack note: no payment provider names outside src/lib/payments/ and
 * src/server/billing/ (slice 2.3b added the account name lookup, which uses Metalira's provider).
 * Exceptions: the Sentry scrubber names the webhook signature header to redact it, and the bank
 * list cites the page its codes were taken from (a comment, no code).
 */
import { describe, expect, it } from "vitest";

import { sourceFiles } from "../helpers/source-files";

const PROVIDERS = /monnify|paystack|flutterwave/i;
const ALLOWED_DIRS = ["src/lib/payments/", "src/server/billing/"];
const ALLOWED_FILES = new Set(["src/lib/observability/scrub.ts", "src/lib/banks.ts"]);

describe("payment provider names", () => {
  it("appear only in src/lib/payments/ and src/server/billing/", () => {
    const offenders = sourceFiles()
      .filter(({ file }) => file.startsWith("src/"))
      .filter(({ file }) => !ALLOWED_DIRS.some((dir) => file.startsWith(dir)))
      .filter(({ file }) => !ALLOWED_FILES.has(file))
      .filter(({ text }) => PROVIDERS.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keep the provider's keys server-only", () => {
    const offenders = sourceFiles()
      .filter(({ text }) => /NEXT_PUBLIC_MONNIFY/i.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    const readers = sourceFiles()
      .filter(({ text }) => /process\.env\.MONNIFY_|env\.MONNIFY_/.test(text))
      .map(({ file }) => file);
    expect(readers).toEqual(["src/server/billing/bank-lookup.ts"]);
  });
});
