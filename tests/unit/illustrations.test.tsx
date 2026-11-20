import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Illustration, ILLUSTRATION_NAMES, SCENES } from "@/components/illustration";
import { GRIN_MAX_LINE, Person, sketch } from "@/components/illustrations/ink";
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
        "inbox-empty",
        "no-clients",
        "roster-empty",
        "all-covered",
        "offline",
        "leave-empty",
        "leave-approved",
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
        "role-freelancer",
        "lira-chat",
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
      expect(markup).not.toMatch(/NaN|Infinity/);
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

  it("sets the landing hero lines for the height it shows at on phones and desktops", () => {
    // The hero is 480 x 320 at full size and shrinks with max-w-full to about 358 x 239 at a
    // 390px viewport. lineAt={280} keeps lines between about 1.9px and 2.6px across that range.
    const units = Number(
      /stroke-width="([\d.]+)"/.exec(render(<Illustration name="hero-crew" lineAt={280} />))![1],
    );
    const px = (shownHeight: number) => (units * shownHeight) / 320;
    expect(px(320)).toBeGreaterThanOrEqual(2.25);
    expect(px(320)).toBeLessThanOrEqual(2.6);
    expect(px(239)).toBeGreaterThanOrEqual(1.9);
  });

  describe("hand-drawn kit", () => {
    const same = (x: number, y: number) => [x, y] as const;

    it("redraws a path the same way for the same seed and differently for another", () => {
      const d = "M0 0 L40 0 H60 V30 C60 40 50 50 40 50 Z";
      expect(sketch(d, same, 7)).toBe(sketch(d, same, 7));
      expect(sketch(d, same, 7)).not.toBe(sketch(d, same, 8));
      expect(sketch(d, same, 7)).toMatch(/^M[-\d.]+ [-\d.]+ C.* Z$/);
      expect(sketch(d, same, 7, 0)).toContain("M0.00 0.00");
    });

    it("gives people in a group different outlines", () => {
      const person = (props: Partial<React.ComponentProps<typeof Person>>) =>
        render(
          <svg>
            <Person x={0} y={0} lw={2} hair="short" top="shirt" {...props} />
          </svg>,
        );
      const a = person({ seed: 1 });
      expect(person({ seed: 1 })).toBe(a);
      expect(person({ seed: 2 })).not.toBe(a);
      expect(person({ seed: 1, build: "wide" })).not.toBe(a);
      expect(person({ seed: 1, stance: "lean-left" })).not.toBe(a);
      expect(person({ seed: 1, turn: 1 })).not.toBe(a);
    });

    const GRIN = 'd="M-5 9 C-2 13.8 2 13.8 5 9 Z" fill="var(--bg)"';
    const SMILE = 'd="M-4.5 9.5 C-2 12.5 2 12.5 4.5 9.5"';
    const face = (lw: number, s = 1) =>
      render(
        <svg>
          <Person x={0} y={0} s={s} lw={lw} hair="short" top="shirt" face="grin" seed={1} />
        </svg>,
      );

    it("never fills a mouth with ink", () => {
      expect(face(1.5)).toContain(GRIN);
    });

    it("draws a grin as an open smile once the line is too heavy for it", () => {
      // A person drawn at s=0.93 in a 160px role scene: lw 2.25 becomes 2.42 in head units.
      expect(2.25 / 0.93).toBeGreaterThan(GRIN_MAX_LINE);
      const small = face(2.25, 0.93);
      expect(small).not.toContain(GRIN);
      expect(small).toContain(SMILE);
      // The hero crew (s=1.66) keeps its grin.
      expect(face(2.57, 1.66)).toContain(GRIN);
    });
  });
});
