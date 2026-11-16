/**
 * Every JS/TS source file in the repo with its text, for the boundary tests that grep the code
 * base (secret key, personal data key). Skips build output and the folders that are not app
 * code; tests/ is skipped too, because tests deliberately use secrets against the local stack.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Skipped anywhere in the tree.
const SKIP_ANYWHERE = new Set(["node_modules", ".next", ".git", ".vercel"]);
// Skipped at the repo root only.
const SKIP_AT_ROOT = new Set([
  "coverage",
  "playwright-report",
  "test-results",
  "docs",
  "fixtures",
  "supabase",
  "tests",
]);

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

export interface SourceFile {
  /** Repo-relative path with forward slashes, for example `src/server/crypto/pii.ts`. */
  file: string;
  text: string;
}

export function sourceFiles(): SourceFile[] {
  return walk(ROOT).map((file) => ({ file: rel(file), text: readFileSync(file, "utf8") }));
}

export const isServerFile = (file: string) => file.startsWith("src/server/");

/** True for a `"use client"` module. */
export const isClientModule = (text: string) => /^\s*["']use client["']/m.test(text);
