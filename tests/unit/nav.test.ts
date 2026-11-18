import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { activeNavHref, canAccessHref, NAV, NAV_ITEMS, navForRole } from "@/lib/nav";
import { MANAGER_ROLES, ROLES, type Role } from "@/lib/roles";

const labels = (role: Role) => navForRole(role).flatMap((g) => g.items.map((i) => i.label));

describe("nav config", () => {
  it("lists the sidebar groups in the agreed order", () => {
    expect(NAV.map((g) => g.label)).toEqual([
      null,
      "Workforce",
      "Payroll",
      "Business",
      "Revenue",
      "Settings",
    ]);
    expect(NAV.find((g) => g.label === "Workforce")?.items.map((i) => i.label)).toEqual([
      "Roster",
      "Live attendance",
      "Timesheets",
      "People",
      "My team",
      "Leave",
    ]);
  });

  it("has unique hrefs under /app", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(href === "/app" || href.startsWith("/app/")).toBe(true);
  });

  it("points every item at a page that exists", () => {
    for (const item of NAV_ITEMS) {
      const file = join(
        process.cwd(),
        "src",
        "app",
        ...item.href.split("/").filter(Boolean),
        "page.tsx",
      );
      expect(existsSync(file), `${item.href} → ${file}`).toBe(true);
    }
  });

  it("writes copy in sentence case with no exclamation marks", () => {
    for (const item of NAV_ITEMS) {
      for (const text of [item.description, item.empty]) {
        expect(text).not.toMatch(/!/);
        expect(text[0]).toBe(text[0]?.toUpperCase());
      }
    }
  });

  it("marks the deepest matching item as active", () => {
    expect(activeNavHref("/app")).toBe("/app");
    expect(activeNavHref("/app/roster")).toBe("/app/roster");
    expect(activeNavHref("/app/roster/2026-11")).toBe("/app/roster");
    expect(activeNavHref("/design-system")).toBeUndefined();
  });
});

// The owner's role-to-nav decision, docs/PHASE_0.md "Roles and access".
describe("nav by role", () => {
  it("shows owner and admin every item", () => {
    const all = NAV_ITEMS.map((i) => i.label);
    expect(labels("owner")).toEqual(all);
    expect(labels("admin")).toEqual(all);
    expect(all).toHaveLength(13);
  });

  it("matches the decision for hr, finance, ops_manager and line_manager", () => {
    expect(labels("hr")).toEqual([
      "Home",
      "Timesheets",
      "People",
      "My team",
      "Leave",
      "Payroll run",
      "Settings",
    ]);
    expect(labels("finance")).toEqual([
      "Home",
      "Timesheets",
      "Payroll run",
      "Unbilled work",
      "Collections",
      "Revenue",
      "Settings",
    ]);
    expect(labels("ops_manager")).toEqual([
      "Home",
      "Roster",
      "Live attendance",
      "Timesheets",
      "People",
      "My team",
      "Leave",
      "Projects",
      "Unbilled work",
    ]);
    expect(labels("line_manager")).toEqual([
      "Home",
      "Live attendance",
      "Timesheets",
      "My team",
      "Leave",
    ]);
  });

  it("gives workers and client approvers no manager nav", () => {
    expect(navForRole("worker")).toEqual([]);
    expect(navForRole("client_approver")).toEqual([]);
  });

  it("drops groups with no items for the role", () => {
    expect(navForRole("line_manager").map((g) => g.label)).toEqual([null, "Workforce"]);
    expect(navForRole("hr").map((g) => g.label)).toEqual([
      null,
      "Workforce",
      "Payroll",
      "Settings",
    ]);
  });

  it("lists every item for owner and admin, and only real roles", () => {
    for (const item of NAV_ITEMS) {
      expect(item.roles).toContain("owner");
      expect(item.roles).toContain("admin");
      for (const role of item.roles) expect(ROLES).toContain(role);
      expect(item.roles).not.toContain("worker");
      expect(item.roles).not.toContain("client_approver");
    }
  });

  it("enforces the same rules for direct URLs", () => {
    expect(canAccessHref("line_manager", "/app/payroll")).toBe(false);
    expect(canAccessHref("line_manager", "/app/timesheets")).toBe(true);
    expect(canAccessHref("finance", "/app/roster")).toBe(false);
    expect(canAccessHref("finance", "/app/collections/inv-0001")).toBe(true);
    expect(canAccessHref("hr", "/app/revenue")).toBe(false);
    for (const role of MANAGER_ROLES) expect(canAccessHref(role, "/app")).toBe(true);
    expect(canAccessHref("worker", "/app")).toBe(false);
    expect(canAccessHref("client_approver", "/app")).toBe(false);
  });

  it("opens the setup wizard and company settings to owner and admin only", () => {
    for (const path of ["/app/setup", "/app/setup/business", "/app/settings/company"]) {
      expect(canAccessHref("owner", path)).toBe(true);
      expect(canAccessHref("admin", path)).toBe(true);
      for (const role of ["hr", "finance", "ops_manager", "line_manager", "worker"] as const) {
        expect(canAccessHref(role, path), `${role} ${path}`).toBe(false);
      }
    }
    // Settings itself stays open to hr and finance.
    expect(canAccessHref("hr", "/app/settings")).toBe(true);
    expect(canAccessHref("finance", "/app/settings")).toBe(true);
    // A prefix that only looks like an extra page is not one.
    expect(canAccessHref("owner", "/app/setup-elsewhere")).toBe(false);
  });

  it("opens the people import to owner, admin and hr only", () => {
    for (const path of ["/app/people/import", "/app/people/import/template"]) {
      for (const role of ["owner", "admin", "hr"] as const) {
        expect(canAccessHref(role, path), `${role} ${path}`).toBe(true);
      }
      for (const role of ["finance", "ops_manager", "line_manager", "worker"] as const) {
        expect(canAccessHref(role, path), `${role} ${path}`).toBe(false);
      }
    }
    // The People list itself stays open to ops managers.
    expect(canAccessHref("ops_manager", "/app/people")).toBe(true);
  });

  it("lets only owner, admin and hr open the People pages that change data", () => {
    const id = "b0000000-0000-4000-8000-000000000002";
    for (const path of ["/app/people/new", `/app/people/${id}/edit`, "/app/settings/departments"]) {
      for (const role of ["owner", "admin", "hr"] as const) {
        expect(canAccessHref(role, path), `${role} ${path}`).toBe(true);
      }
      for (const role of ["finance", "ops_manager", "line_manager", "worker"] as const) {
        expect(canAccessHref(role, path), `${role} ${path}`).toBe(false);
      }
    }
    // Viewing a profile: ops_manager reads; line managers open their own reportees (slice 1.11,
    // RLS shows them no one else); finance doesn't.
    expect(canAccessHref("ops_manager", `/app/people/${id}`)).toBe(true);
    expect(canAccessHref("line_manager", `/app/people/${id}`)).toBe(true);
    expect(canAccessHref("line_manager", "/app/people")).toBe(false);
    expect(canAccessHref("line_manager", "/app/people/approvals")).toBe(false);
    expect(canAccessHref("line_manager", "/app/people/invites")).toBe(false);
    expect(canAccessHref("finance", `/app/people/${id}`)).toBe(false);
    // Anything below the edit page is gated like the edit page.
    expect(canAccessHref("ops_manager", `/app/people/${id}/edit/more`)).toBe(false);
    // A segment that only starts like an extra page is not one.
    expect(canAccessHref("ops_manager", "/app/settings/departments-old")).toBe(false);
    expect(canAccessHref("ops_manager", "/app/people/new-hires")).toBe(true);
  });

  it("lets owner, admin, hr and finance open bank-detail approvals", () => {
    for (const role of ["owner", "admin", "hr", "finance"] as const) {
      expect(canAccessHref(role, "/app/people/approvals"), role).toBe(true);
    }
    for (const role of ["ops_manager", "line_manager", "worker", "client_approver"] as const) {
      expect(canAccessHref(role, "/app/people/approvals"), role).toBe(false);
    }
  });

  it("opens worker invites to owner, admin and hr only (slice 1.9)", () => {
    for (const role of ["owner", "admin", "hr"] as const) {
      expect(canAccessHref(role, "/app/people/invites"), role).toBe(true);
    }
    for (const role of ["finance", "ops_manager", "line_manager", "worker"] as const) {
      expect(canAccessHref(role, "/app/people/invites"), role).toBe(false);
    }
    // People itself stays open to ops_manager.
    expect(canAccessHref("ops_manager", "/app/people")).toBe(true);
  });

  it("refuses paths that sit under no nav item", () => {
    expect(canAccessHref("owner", "/app/secret-admin")).toBe(false);
    expect(canAccessHref("owner", "/design-system")).toBe(false);
  });
});
