import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { activeNavHref, NAV, NAV_ITEMS } from "@/lib/nav";

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
