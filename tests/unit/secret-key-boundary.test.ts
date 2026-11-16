/**
 * CLAUDE.md rule 2: the Supabase secret key is used only by server code under
 * src/server/, never in client components. This scans every source file in the
 * repo outside src/server/ and tests/ (the RLS suite is a deliberate,
 * test-only exception) for the variable name or an import of the admin client.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Skipped anywhere in the tree.
const SKIP_ANYWHERE = new Set(["node_modules", ".next", ".git", ".vercel"]);
// Skipped at the repo root only. tests/ is the deliberate exception.
const SKIP_AT_ROOT = new Set([
  "coverage",
  "playwright-report",
  "test-results",
  "docs",
  "fixtures",
  "supabase",
  "tests",
]);
// Files allowed to name the forbidden patterns: the ESLint rule that bans them.
const ALLOWED = new Set(["eslint.config.mjs"]);
const FORBIDDEN = [/SUPABASE_SECRET_KEY/, /server\/supabase\/admin/, /SUPABASE_SERVICE_ROLE/];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const skip = SKIP_ANYWHERE.has(entry.name) || (dir === ROOT && SKIP_AT_ROOT.has(entry.name));
      if (!skip) walk(full, out);
    } else if (SOURCE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const files = walk(ROOT).map((file) => ({ file: rel(file), text: readFileSync(file, "utf8") }));
const isServer = (file: string) => file.startsWith("src/server/");
const isClient = (text: string) => /^\s*["']use client["']/m.test(text);

describe("secret key boundary", () => {
  it("scans the app source", () => {
    expect(files.some(({ file }) => file === "src/server/supabase/admin.ts")).toBe(true);
    expect(files.some(({ file }) => file.startsWith("src/app/"))).toBe(true);
  });

  it("keeps the secret key and admin client inside src/server/", () => {
    const offenders = files
      .filter(({ file }) => !isServer(file) && !ALLOWED.has(file))
      .filter(({ text }) => FORBIDDEN.some((pattern) => pattern.test(text)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("never marks a src/server/ file as a client module", () => {
    const offenders = files
      .filter(({ file, text }) => isServer(file) && isClient(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("reads the secret key in exactly one place", () => {
    const readers = files
      .filter(({ text }) => /process\.env\.SUPABASE_SECRET_KEY/.test(text))
      .map(({ file }) => file);
    expect(readers).toEqual(["src/server/supabase/admin.ts"]);
  });

  it("never exposes a secret through a NEXT_PUBLIC_ variable", () => {
    const offenders = files
      .filter(({ text }) => /NEXT_PUBLIC_[A-Z_]*(?:SECRET|SERVICE_ROLE)/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
