import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { LIRA, LIRA_FOR_ROLE } from "@/components/marketing/lira";
import { SECTION_LINKS } from "@/components/marketing/primitives";
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

/**
 * Copy in a source file that breaks the voice: an exclamation mark ending a word or standing
 * alone, or an emoji. Reads double-, single- and back-quoted strings (with any `${…}` taken out)
 * and JSX text, so `!` in code (`!ok`, `!==`) is not flagged.
 */
function copyProblems(text: string): string[] {
  const STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|>([^<>{}\n]+)</g;
  return [...text.matchAll(STRING)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").replace(/\$\{[^}]*\}/g, ""))
    .filter(
      (s) =>
        /[\p{L}\p{N}][\p{Pe}\p{Pf}"']?!(?!=)|(?:^|\s)!(?:\s|$)|,\s*!/u.test(s) ||
        /\p{Extended_Pictographic}/u.test(s),
    );
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
      expect(copyProblems(text)).toEqual([]);
    });
  });

  it("the copy scan reads every kind of string literal and JSX text", () => {
    expect(copyProblems('const a = "Done!";')).toEqual(["Done!"]);
    expect(copyProblems("const a = 'Saved!';")).toEqual(["Saved!"]);
    expect(copyProblems("const a = `Welcome, ${name}!`;")).toEqual(["Welcome, !"]);
    expect(copyProblems("const a = `All set\nfor today!`;")).toEqual(["All set\nfor today!"]);
    expect(copyProblems("<p>Great!</p>")).toEqual(["Great!"]);
    expect(copyProblems('const b = "Paid \u{1F389}";')).toEqual(["Paid \u{1F389}"]);
    // `!` in code is fine.
    expect(copyProblems('if (!ok && a !== "x") return <p>{!done ? "Saved" : "Not"}</p>;')).toEqual(
      [],
    );
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

describe("landing sections", () => {
  it("names the pilot section Pilot, at #pilot, and shows no Pricing link", () => {
    expect(SECTION_LINKS).toContainEqual({ href: "/#pilot", label: "Pilot" });
    expect(SECTION_LINKS.map((l) => l.label)).not.toContain("Pricing");
    const landing = FILES.find((f) => f.name === "src/app/(marketing)/page.tsx")!.text;
    expect(landing).toContain('id="pilot"');
    expect(landing).not.toContain('id="pricing"');
  });
});

describe("Lira (coming soon)", () => {
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];
  const COPY = [...strings(LIRA), ...strings(LIRA_FOR_ROLE)];
  const MONTHS =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

  it("has copy to check", () => {
    expect(COPY.length).toBeGreaterThan(10);
    expect(LIRA.capabilities).toHaveLength(4);
    expect(LIRA.safety).toHaveLength(4);
  });

  it("says Coming soon, on the landing section and the role pages", () => {
    expect(LIRA.status).toBe("Coming soon");
    const landing = FILES.find((f) => f.name === "src/app/(marketing)/page.tsx")!.text;
    expect(landing).toContain('id="lira"');
    expect(landing).toContain("<ComingSoonChip ");
    const rolePage = FILES.find((f) => f.name === "src/components/marketing/role-page.tsx")!.text;
    expect(rolePage).toContain("<ComingSoonChip ");
    expect(SECTION_LINKS).toContainEqual({ href: "/#lira", label: "Lira" });
  });

  it("is on every manager role page and not on the workers page", () => {
    expect(Object.keys(LIRA_FOR_ROLE).sort()).toEqual(["finance", "hr", "operations", "owners"]);
    expect(ROLES.map((r) => r.slug).filter((s) => !(s in LIRA_FOR_ROLE))).toEqual(["workers"]);
  });

  describe.each(COPY)("%s", (text) => {
    it("shows no price", () => {
      expect(text).not.toMatch(/₦|\bNGN\b|naira|\bprice|\bpric(e|ing)|\bfree\b|\bcost\b/i);
    });

    it("gives no launch date", () => {
      expect(text).not.toMatch(/\b20\d\d\b|\bQ[1-4]\b/);
      expect(text).not.toMatch(
        new RegExp(String.raw`\b\d{1,2}(st|nd|rd|th)?\s+(${MONTHS})\b`, "i"),
      );
      expect(text).not.toMatch(
        /\b(launch|launches|launching|release|beta|soon after|next month|next year)\b/i,
      );
    });

    it("names no AI vendor or model, and does not oversell", () => {
      expect(text).not.toMatch(
        /openai|chatgpt|\bgpt|anthropic|claude|gemini|google|llama|\bmeta ai|mistral|copilot|deepseek|grok|\bllm\b|model/i,
      );
      expect(text).not.toMatch(/\bAI\b|artificial intelligence|magic|revolution/i);
    });

    it("promises email and in-app only: no SMS or WhatsApp", () => {
      expect(text).not.toMatch(/\bsms\b|whatsapp|text message/i);
    });
  });

  it("states the four safety promises", () => {
    const safety = LIRA.safety.join(" ");
    expect(safety).toMatch(/only does what your role allows/);
    expect(safety).toMatch(/waits for you to confirm/);
    expect(safety).toMatch(/never approves its own work/);
    expect(safety).toMatch(/never moves money/);
  });
});
