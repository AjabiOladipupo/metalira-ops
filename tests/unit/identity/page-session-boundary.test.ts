/**
 * Page sessions read the user from getClaims (a local JWT check), which a session revoked on the
 * server still passes until the token expires. They are for rendering only: no Server Action
 * module ("use server") or Route Handler may use them. Writes verify with getUser through
 * getSession / lookupWorkerSession / requireWorkerSession / ownContext.
 */
import { describe, expect, it } from "vitest";

import { sourceFiles } from "../helpers/source-files";

const PAGE_ONLY =
  /\b(getPageSession|lookupWorkerPageSession|requireWorkerPageSession|getActiveCompany|pendingSetupHref|requireAppAccess|peoplePageContext)\b/;
const isServerActionModule = (text: string) => /^\s*["']use server["']/m.test(text);
const isRouteHandler = (file: string) => /\/route\.[cm]?[jt]sx?$/.test(file);

const files = sourceFiles();

describe("page session boundary", () => {
  it("finds the server action modules", () => {
    expect(files.some(({ text }) => isServerActionModule(text))).toBe(true);
  });

  it("keeps page-only session lookups out of Server Actions and Route Handlers", () => {
    const offenders = files
      .filter(({ file, text }) => isServerActionModule(text) || isRouteHandler(file))
      .filter(({ text }) => PAGE_ONLY.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
