/**
 * Slice 6.11: the office vs client site rules the screens use before the database repeats them
 * (migration 20261127090000_head_office).
 */
import { describe, expect, it } from "vitest";

import {
  HEAD_OFFICE_NAME,
  OFFICE_NO_PROJECTS,
  compareSiteOptions,
  isOffice,
  isSiteKind,
  officeMappingProblem,
  siteKindProblem,
  siteLabel,
  siteTakesProjects,
} from "@/lib/office-sites";
import { createOfficeSchema, createSiteSchema } from "@/server/sites/schemas";

const CLIENT = "6f1c3b8e-2a4d-4e5f-9a1b-0c2d3e4f5a6b";

describe("office vs client sites", () => {
  it("knows the two kinds and nothing else", () => {
    expect(isSiteKind("client")).toBe(true);
    expect(isSiteKind("office")).toBe(true);
    expect(isSiteKind("branch")).toBe(false);
    expect(isSiteKind(null)).toBe(false);
    expect(isOffice("office")).toBe(true);
    expect(isOffice("client")).toBe(false);
    expect(isOffice(undefined)).toBe(false);
  });

  it("an office has no client, and a client's site has one", () => {
    expect(siteKindProblem({ kind: "office", clientId: null })).toBeNull();
    expect(siteKindProblem({ kind: "client", clientId: CLIENT })).toBeNull();
    expect(siteKindProblem({ kind: "office", clientId: CLIENT })).toBe(
      "An office belongs to your company, not to a client.",
    );
    expect(siteKindProblem({ kind: "client", clientId: null })).toBe(
      "Choose the client this site belongs to.",
    );
  });

  it("labels an office as overhead and a client's site with its client", () => {
    expect(siteLabel({ name: HEAD_OFFICE_NAME, kind: "office" })).toBe("Head office · overhead");
    expect(siteLabel({ name: "Ikeja branch", kind: "office", clientName: "Ignored" })).toBe(
      "Ikeja branch · overhead",
    );
    expect(siteLabel({ name: "Apapa Warehouse 3", kind: "client", clientName: "Coastline" })).toBe(
      "Apapa Warehouse 3 · Coastline",
    );
    expect(siteLabel({ name: "Gate A", kind: "client" })).toBe("Gate A");
  });

  it("an office takes no projects", () => {
    expect(siteTakesProjects("office")).toBe(false);
    expect(siteTakesProjects("client")).toBe(true);
    expect(officeMappingProblem("office", 0)).toBeNull();
    expect(officeMappingProblem("office", 1)).toBe(OFFICE_NO_PROJECTS);
    expect(officeMappingProblem("client", 3)).toBeNull();
  });

  it("lists offices first, Head office before branches, then sites by label", () => {
    const options = [
      { label: "Apapa Warehouse 3 · Coastline", office: false, name: "Apapa Warehouse 3" },
      { label: "Ikeja branch · overhead", office: true, name: "Ikeja branch" },
      { label: "Abuja branch · overhead", office: true, name: "Abuja branch" },
      { label: "Head office · overhead", office: true, name: HEAD_OFFICE_NAME },
      { label: "Ajah Estate · Greenfield", office: false, name: "Ajah Estate" },
    ];
    expect([...options].sort(compareSiteOptions).map((o) => o.name)).toEqual([
      HEAD_OFFICE_NAME,
      "Abuja branch",
      "Ikeja branch",
      "Ajah Estate",
      "Apapa Warehouse 3",
    ]);
  });

  it("adds an office without a client, and a client's site only with one", () => {
    expect(createOfficeSchema.safeParse({ name: "Ikeja branch" }).success).toBe(true);
    const office = createOfficeSchema.parse({ name: "Ikeja branch", clientId: CLIENT });
    expect(office).not.toHaveProperty("clientId");
    expect(createOfficeSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createSiteSchema.safeParse({ name: "Gate A" }).success).toBe(false);
    expect(createSiteSchema.safeParse({ name: "Gate A", clientId: CLIENT }).success).toBe(true);
  });
});
