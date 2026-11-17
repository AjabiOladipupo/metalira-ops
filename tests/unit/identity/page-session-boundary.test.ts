/**
 * Page sessions read the user from getClaims (a local JWT check), which a session revoked on the
 * server still passes until the token expires. They are for rendering only: no Server Action
 * module ("use server") or Route Handler may use them. Writes verify with getUser through
 * getSession / lookupWorkerSession / requireWorkerSession / ownContext.
 *
 * Three checks keep that true:
 * 1. No Server Action module or Route Handler names a page-only lookup.
 * 2. Outside src/app, only the render-only modules listed in PAGE_MODULES may name one, so a new
 *    helper under src/server that reaches getPageSession fails here until someone decides it is
 *    render only (and adds its export to PAGE_ONLY).
 * 3. No Server Action module or Route Handler imports a module (one level) that names a
 *    page-only lookup, other than the PAGE_MODULES themselves (whose other exports are
 *    verified). That catches a src/app helper sitting between an action and getPageSession.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sourceFiles } from "../helpers/source-files";

const PAGE_ONLY =
  /\b(getPageSession|lookupWorkerPageSession|requireWorkerPageSession|getActiveCompany|getActiveCompanyLogoUrl|pendingSetupHref|requireAppAccess|peoplePageContext|getImportBatchView)\b/;

/** The modules that define (or wrap) the page-only lookups. Each is render only for those exports. */
const PAGE_MODULES = new Set([
  "src/server/identity/session.ts",
  "src/server/identity/worker-session.ts",
  "src/server/identity/company-data.ts",
  "src/server/people/page-context.ts",
  "src/server/people/imports/data.ts",
]);

const isServerActionModule = (text: string) => /^\s*["']use server["']/m.test(text);
const isRouteHandler = (file: string) => /\/route\.[cm]?[jt]sx?$/.test(file);

const files = sourceFiles();
const byPath = new Map(files.map((f) => [f.file, f]));
const writers = files.filter(({ file, text }) => isServerActionModule(text) || isRouteHandler(file));

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

/** Repo-relative paths of the local modules `file` imports (relative and `@/` specifiers). */
function localImports(file: string, text: string): string[] {
  const specifiers = [
    ...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ].map((m) => m[1] ?? "");
  const out: string[] = [];
  for (const spec of specifiers) {
    let base: string;
    if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith("./") || spec.startsWith("../"))
      base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    else continue;
    const hit = [base, ...EXTENSIONS.map((ext) => base + ext)].find((p) => byPath.has(p));
    if (hit) out.push(hit);
  }
  return out;
}

describe("page session boundary", () => {
  it("finds the server action modules and resolves their imports", () => {
    expect(writers.some(({ text }) => isServerActionModule(text))).toBe(true);
    expect(writers.some(({ file, text }) => localImports(file, text).length > 0)).toBe(true);
  });

  it("keeps page-only session lookups out of Server Actions and Route Handlers", () => {
    const offenders = writers.filter(({ text }) => PAGE_ONLY.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("allows page-only lookups outside src/app only in the render-only modules", () => {
    const offenders = files
      .filter(({ file }) => !file.startsWith("src/app/") && !PAGE_MODULES.has(file))
      .filter(({ text }) => PAGE_ONLY.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps Server Actions and Route Handlers from importing a helper that uses them", () => {
    const offenders = writers.flatMap(({ file, text }) =>
      localImports(file, text)
        .filter((dep) => !PAGE_MODULES.has(dep) && PAGE_ONLY.test(byPath.get(dep)?.text ?? ""))
        .map((dep) => `${file} -> ${dep}`),
    );
    expect(offenders).toEqual([]);
  });
});
