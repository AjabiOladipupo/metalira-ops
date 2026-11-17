import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Illustration, ILLUSTRATION_NAMES, SCENES } from "@/components/illustration";
import { ILLUSTRATION_SIZES } from "@/components/illustrations/types";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

/** Every value of an attribute (`fill="..."`) or CSS property (`color:...`) in the markup. */
function values(markup: string, name: string): string[] {
  const attr = [...markup.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]!);
  const css = [...markup.matchAll(new RegExp(`[";]${name}:([^;"]*)`, "g"))].map((m) =>
    m[1]!.trim(),
  );
  return [...attr, ...css];
}

describe("illustrations", () => {
  it("has the slots named in DESIGN_SYSTEM.md", () => {
    expect(ILLUSTRATION_NAMES).toEqual(
      expect.arrayContaining([
        "welcome",
        "import-people",
        "no-approvals",
        "clock-in",
        "worker-profile",
        "no-clients",
        "roster-empty",
        "all-covered",
        "offline",
        "leave-empty",
        "payroll-ready",
        "payslip-empty",
        "no-invoices",
        "all-collected",
        "no-projects",
        "hero-crew",
        "role-owner",
        "role-hr",
        "role-finance",
        "role-operations",
        "role-worker",
      ]),
    );
  });

  describe.each(ILLUSTRATION_NAMES)("%s", (name) => {
    const markup = render(<Illustration name={name} />);

    it("renders an inline SVG at its slot size", () => {
      const scene = SCENES[name];
      const height = ILLUSTRATION_SIZES[scene.size];
      expect(markup).toMatch(/^<svg /);
      expect(markup).toContain(`viewBox="0 0 ${scene.viewBox[0]} ${scene.viewBox[1]}"`);
      expect(markup).toContain(`height="${height}"`);
      expect((markup.match(/<path /g) ?? []).length).toBeGreaterThan(5);
    });

    it("uses only currentColor, var(--bg) and one var(--signal) group", () => {
      expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(markup).not.toMatch(/rgba?\(|hsla?\(|oklch\(|gr[ae]y|gradient|opacity/i);
      for (const prop of ["fill", "stroke"]) {
        for (const value of values(markup, prop)) {
          expect(["none", "currentColor", "var(--bg)"], `${prop}="${value}"`).toContain(value);
        }
      }
      for (const value of values(markup, "color")) expect(value).toBe("var(--signal)");
      expect(markup.split("var(--signal)").length - 1).toBeLessThanOrEqual(1);
      expect(markup.split("data-accent").length - 1).toBeLessThanOrEqual(1);
    });

    it("has an accessible name, or is hidden when decorative", () => {
      expect(markup).toMatch(/role="img"/);
      const label = /aria-label="([^"]+)"/.exec(markup)?.[1];
      expect(label?.length).toBeGreaterThan(10);
      expect(label).not.toMatch(/!|\p{Extended_Pictographic}/u);

      const hidden = render(<Illustration name={name} decorative />);
      expect(hidden).toContain('aria-hidden="true"');
      expect(hidden).not.toContain("role=");
      expect(hidden).not.toContain("aria-label");
    });
  });

  it("keeps lines about 2.25px at display size whatever the slot", () => {
    const at = (size: "worker" | "empty" | "onboarding") =>
      Number(
        /stroke-width="([\d.]+)"/.exec(render(<Illustration name="welcome" size={size} />))![1],
      );
    // 160-unit viewBox: thicker in user units when shown smaller.
    expect(at("empty")).toBeCloseTo(2.25);
    expect(at("onboarding")).toBeCloseTo(1.5);
    expect(at("worker")).toBeCloseTo(3.75);
  });
});
