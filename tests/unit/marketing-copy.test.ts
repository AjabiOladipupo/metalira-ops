import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { ROLES } from "@/components/marketing/roles";
import { MARKETING_PATHS, siteUrl, SITE_URL_FALLBACK } from "@/lib/site";

const ROOT = process.cwd();

/** Every source file behind the public pages: routes, shared pieces, SEO files. */
function marketingFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.(tsx?|mdx?)$/.test(name) ? [path] : [];
    });
  return [
    ...walk(join(ROOT, "src", "app", "(marketing)")),
    ...walk(join(ROOT, "src", "components", "marketing")),
    join(ROOT, "src", "app", "opengraph-image.tsx"),
    join(ROOT, "src", "app", "sitemap.ts"),
    join(ROOT, "src", "app", "robots.ts"),
    join(ROOT, "src", "lib", "site.ts"),
  ];
}

const FILES = marketingFiles().map((path) => ({
  name: relative(ROOT, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

describe("marketing copy", () => {
  it("scans the landing page, the role pages and the shared pieces", () => {
    const names = FILES.map((f) => f.name);
    expect(names).toContain("src/app/(marketing)/page.tsx");
    for (const role of ROLES) expect(names).toContain(`src/app/(marketing)${role.href}/page.tsx`);
    expect(names).toContain("src/components/marketing/site-footer.tsx");
  });

  describe.each(FILES)("$name", ({ text }) => {
    it("never names a payment provider", () => {
      expect(text).not.toMatch(/paystack|flutterwave|monnify/i);
    });

    it("shows no prices", () => {
      expect(text).not.toMatch(/₦\s?\d/);
      expect(text).not.toMatch(/\bNGN\s?\d/);
    });

    it("has no Privacy or Terms links", () => {
      expect(text).not.toMatch(/href=["'{`][^"'}`]*\/(privacy|terms)/i);
      expect(text).not.toMatch(/\b(Privacy|Terms)\b/);
    });

    it("has no exclamation marks or emoji in copy", () => {
      // Only string literals and JSX text: `!` is fine in code.
      const strings = [...text.matchAll(/"([^"\n]*)"|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2]);
      for (const s of strings) {
        expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
        if (s && /\s/.test(s)) expect(s, s).not.toMatch(/!/);
      }
    });
  });

  it("gives every role three problem-to-outcome blocks and a task list", () => {
    expect(ROLES.map((r) => [r.slug, r.illustration])).toEqual([
      ["owners", "role-owner"],
      ["hr", "role-hr"],
      ["finance", "role-finance"],
      ["operations", "role-operations"],
      ["workers", "role-worker"],
    ]);
    for (const role of ROLES) {
      expect(role.blocks).toHaveLength(3);
      expect(role.tasks.length).toBeGreaterThanOrEqual(3);
      expect(MARKETING_PATHS).toContain(role.href);
    }
  });
});

describe("site URL", () => {
  it("uses NEXT_PUBLIC_APP_URL without a trailing slash", () => {
    expect(siteUrl({ NEXT_PUBLIC_APP_URL: "https://preview.example.com/" })).toBe(
      "https://preview.example.com",
    );
  });

  it("falls back to the production domain", () => {
    expect(siteUrl({})).toBe(SITE_URL_FALLBACK);
    expect(siteUrl({ NEXT_PUBLIC_APP_URL: "not a url" })).toBe("https://ops.metaliratech.com");
  });
});
