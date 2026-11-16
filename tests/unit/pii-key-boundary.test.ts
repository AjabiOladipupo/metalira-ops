/**
 * CLAUDE.md rule 9 and slice 1.2: the personal data key is read only on the server, in one
 * module, and the decrypting modules never reach the browser. `import "server-only"` makes a
 * client import fail the build; this test and the ESLint rule catch it before that.
 */
import { describe, expect, it } from "vitest";

import { isClientModule, isServerFile, sourceFiles } from "./helpers/source-files";

const KEY_MODULE = "src/server/crypto/pii.ts";
/** The crypto module: only src/server/ may import it. */
const CRYPTO_IMPORT = /["'][^"']*server\/crypto(?:\/[^"']*)?["']/;
/** The reveal helper: server components may import it, client modules never. */
const PII_ACCESS_IMPORT = /["'][^"']*server\/people\/pii-access["']/;
// Files allowed to name the crypto module outside src/server: the ESLint rule that bans it.
const ALLOWED_IMPORTERS = new Set(["eslint.config.mjs"]);

const files = sourceFiles();

describe("personal data key boundary", () => {
  it("scans the app source", () => {
    expect(files.some(({ file }) => file === KEY_MODULE)).toBe(true);
    expect(files.some(({ file }) => file.startsWith("src/app/"))).toBe(true);
  });

  it("names PII_ENCRYPTION_KEY only under src/server/", () => {
    const offenders = files
      .filter(({ file, text }) => !isServerFile(file) && /PII_ENCRYPTION_KEY/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("reads PII_ENCRYPTION_KEY in exactly one module", () => {
    const readers = files
      .filter(({ text }) => /process\.env(?:\.PII_ENCRYPTION_KEY|\[\s*["'`]PII_)/.test(text))
      .map(({ file }) => file);
    expect(readers).toEqual([KEY_MODULE]);
  });

  it("never exposes the key through a NEXT_PUBLIC_ variable", () => {
    const offenders = files
      .filter(({ text }) => /NEXT_PUBLIC_[A-Z_]*PII/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("marks the decrypting modules server-only", () => {
    for (const path of [KEY_MODULE, "src/server/people/pii-access.ts"]) {
      const source = files.find(({ file }) => file === path);
      expect(source?.text).toMatch(/^import "server-only";/m);
    }
  });

  it("imports src/server/crypto only from src/server/", () => {
    const offenders = files
      .filter(({ file }) => !isServerFile(file) && !ALLOWED_IMPORTERS.has(file))
      .filter(({ text }) => CRYPTO_IMPORT.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("never imports the decrypting modules from a client module", () => {
    const offenders = files
      .filter(({ text }) => isClientModule(text))
      .filter(({ text }) => CRYPTO_IMPORT.test(text) || PII_ACCESS_IMPORT.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
