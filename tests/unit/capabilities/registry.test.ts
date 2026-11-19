/**
 * The capability registry (src/server/capabilities, slice 2.1) must list every Server Action:
 * a `"use server"` module's exports are all callable from the browser, so each one needs a
 * stable name, a description, its roles and its kind before it ships. The registry may not point
 * at an action that doesn't exist, and writes that change several rows or money need a preview
 * before the ops agent may offer them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MANAGER_ROLES } from "@/lib/roles";
import { CAPABILITIES, findCapability } from "@/server/capabilities/registry";

import { sourceFiles } from "../helpers/source-files";

const isServerActionModule = (text: string) => /^\s*["']use server["']/m.test(text);

/** Every exported name of a module, by the forms the code base uses. */
function exportedNames(text: string): { functions: string[]; other: string[] } {
  const functions = [...text.matchAll(/^export\s+async\s+function\s+(\w+)/gm)].map((m) => m[1]!);
  const other = [
    ...text.matchAll(/^export\s+(?:const|let|var|class|function(?!\s*\*)|default)\s*(\w*)/gm),
    ...text.matchAll(/^export\s*\{([^}]*)\}/gm),
  ].map((m) => (m[1] ?? "").trim());
  return { functions, other };
}

const actionModules = sourceFiles().filter(
  ({ file, text }) => file.startsWith("src/") && isServerActionModule(text),
);

const exported = actionModules.flatMap(({ file, text }) =>
  exportedNames(text).functions.map((name) => `${file}#${name}`),
);

const registered = CAPABILITIES.flatMap((c) =>
  c.action ? [`${c.action.module}#${c.action.export}`] : [],
);

describe("capability registry", () => {
  it("finds the Server Action modules", () => {
    expect(actionModules.length).toBeGreaterThan(5);
    expect(exported).toContain("src/server/business/actions.ts#createClientAction");
  });

  it("exports only async functions from Server Action modules", () => {
    const offenders = actionModules.flatMap(({ file, text }) =>
      exportedNames(text).other.map((name) => `${file}: ${name || "(unnamed)"}`),
    );
    expect(offenders).toEqual([]);
  });

  it("registers every exported Server Action", () => {
    const missing = exported.filter((ref) => !registered.includes(ref));
    expect(missing).toEqual([]);
  });

  it("points only at Server Actions that exist, once each", () => {
    const stale = registered.filter((ref) => !exported.includes(ref));
    expect(stale).toEqual([]);
    // createInvitesSpec backs two actions, but each action has one capability.
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("gives every capability a unique, stable-looking name and a one-line description", () => {
    const names = CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of CAPABILITIES) {
      expect(c.name).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
      expect(c.description).toMatch(/^[A-Z].{9,119}\.$/);
      expect(c.description).not.toContain("\n");
    }
    expect(findCapability("clients.create")?.action?.export).toBe("createClientAction");
  });

  it("uses Zod schemas and known roles", () => {
    for (const c of CAPABILITIES) {
      if (c.input !== null) expect(c.input, c.name).toBeInstanceOf(z.ZodType);
      for (const role of c.roles) expect(MANAGER_ROLES, c.name).toContain(role);
      if (c.audience === "manager") expect(c.roles.length, c.name).toBeGreaterThan(0);
      else expect(c.roles, c.name).toEqual([]);
    }
  });

  it("backs every read with a function and every write with an action", () => {
    for (const c of CAPABILITIES) {
      if (c.action === null) {
        expect(c.kind, c.name).toBe("read");
        expect(typeof c.read, c.name).toBe("function");
      }
      if (c.kind !== "read") expect(c.action, c.name).not.toBeNull();
    }
  });

  it("needs a preview before the agent may offer a multi-row or money write", () => {
    const offenders = CAPABILITIES.filter(
      (c) => (c.changes === "many" || c.kind === "money") && c.agent && !c.preview,
    ).map((c) => c.name);
    expect(offenders).toEqual([]);
  });

  it("explains every capability the agent may not offer", () => {
    const offenders = CAPABILITIES.filter((c) => !c.agent && !c.agentNote).map((c) => c.name);
    expect(offenders).toEqual([]);
  });

  it("never lets the agent sign in, reveal personal data, approve as second person or pay", () => {
    for (const c of CAPABILITIES) {
      if (c.audience !== "manager") expect(c.agent, c.name).toBe(false);
      if (/reveal|decide|^auth\.|^account\./.test(c.name)) expect(c.agent, c.name).toBe(false);
      if (c.kind === "money") expect(c.agent, c.name).toBe(false);
    }
  });

  it("never reaches the secret-key client", () => {
    const offenders = sourceFiles()
      .filter(({ file }) => file.startsWith("src/server/capabilities/"))
      .filter(({ text }) => /supabase\/admin|createAdminSupabase/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("takes the roles of the client actions from their specs", () => {
    expect(findCapability("clients.create")?.roles).toEqual(["owner", "admin", "ops_manager"]);
    expect(findCapability("contacts.add")?.roles).toEqual([
      "owner",
      "admin",
      "finance",
      "ops_manager",
    ]);
  });
});
