/**
 * Slice 3.4: what the worker app's service worker caches. Personal data (pages, RSC payloads,
 * Server Actions, API, Supabase) must never be classed as cacheable.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WORKER_OFFLINE_PATH } from "@/lib/auth/routes";
import { isIosSafari } from "@/lib/offline/install";
import { classifyRequest, isWorkerAppPath, staticAssetsIn } from "@/lib/offline/sw-routes";

const ORIGIN = "https://ops.metalira.example";

function facts(
  path: string,
  { method = "GET", mode = "cors" as RequestMode, headers = {} as Record<string, string> } = {},
) {
  const url = new URL(path, ORIGIN);
  return { method, url, origin: ORIGIN, mode, headers: new Headers(headers) };
}

describe("classifyRequest", () => {
  it("caches hashed static assets", () => {
    expect(classifyRequest(facts("/_next/static/chunks/abc123.js"))).toBe("static");
    expect(classifyRequest(facts("/_next/static/media/inter.woff2"))).toBe("static");
  });

  it("serves the worker icons and manifest from the precache", () => {
    expect(classifyRequest(facts("/icons/worker-192.png"))).toBe("public");
    expect(classifyRequest(facts("/worker.webmanifest"))).toBe("public");
    expect(classifyRequest(facts("/brand/ops-logo.png"))).toBe("passthrough");
  });

  it("sends worker page loads to the network (offline page fallback), never the cache", () => {
    for (const path of ["/m", "/m/clock", "/m/me/change", "/m/offline"]) {
      expect(classifyRequest(facts(path, { mode: "navigate" }))).toBe("navigation");
    }
  });

  it("never touches the manager app or other pages", () => {
    for (const path of ["/app", "/app/people", "/", "/sign-in", "/me", "/manager"]) {
      expect(classifyRequest(facts(path, { mode: "navigate" }))).toBe("passthrough");
    }
  });

  it("never caches RSC payloads, Server Actions, API or other origins", () => {
    expect(classifyRequest(facts("/m/clock", { headers: { RSC: "1" } }))).toBe("passthrough");
    expect(classifyRequest(facts("/m/clock?_rsc=x1y2"))).toBe("passthrough");
    expect(
      classifyRequest(
        facts("/m/me", { method: "POST", mode: "navigate", headers: { "Next-Action": "a" } }),
      ),
    ).toBe("passthrough");
    expect(classifyRequest(facts("/api/health"))).toBe("passthrough");
    expect(classifyRequest(facts("/auth/callback", { mode: "navigate" }))).toBe("passthrough");
    expect(classifyRequest(facts("/sw.js"))).toBe("passthrough");
    expect(
      classifyRequest({
        ...facts("/"),
        url: new URL("https://abc.supabase.co/rest/v1/workers?select=*"),
      }),
    ).toBe("passthrough");
    expect(
      classifyRequest({ ...facts("/"), url: new URL("https://cdn.example/_next/static/x.js") }),
    ).toBe("passthrough");
  });
});

describe("isWorkerAppPath", () => {
  it("matches /m and /m/* only", () => {
    expect(isWorkerAppPath("/m")).toBe(true);
    expect(isWorkerAppPath("/m/")).toBe(true);
    expect(isWorkerAppPath("/m/clock")).toBe(true);
    expect(isWorkerAppPath("/me")).toBe(false);
    expect(isWorkerAppPath("/marketing")).toBe(false);
    expect(isWorkerAppPath("/app")).toBe(false);
  });
});

describe("staticAssetsIn", () => {
  it("finds each /_next/static URL in a page once", () => {
    const html = `<link rel="stylesheet" href="/_next/static/css/a1.css"/><script src="/_next/static/chunks/b2.js" async></script><script src="/_next/static/chunks/b2.js"></script>"/_next/static/media/f.woff2"`;
    expect(staticAssetsIn(html)).toEqual([
      "/_next/static/css/a1.css",
      "/_next/static/chunks/b2.js",
      "/_next/static/media/f.woff2",
    ]);
  });
});

describe("isIosSafari", () => {
  it("spots iPhone and iPad Safari, not Android or iOS Chrome", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const ipad =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    const iosChrome =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
    const android =
      "Mozilla/5.0 (Linux; Android 14; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
    expect(isIosSafari(iphone)).toBe(true);
    expect(isIosSafari(ipad, 5)).toBe(true);
    expect(isIosSafari(ipad, 0)).toBe(false);
    expect(isIosSafari(iosChrome)).toBe(false);
    expect(isIosSafari(android)).toBe(false);
  });
});

describe("service worker build", () => {
  it("precaches the offline page the proxy lets through, and the worker icons", async () => {
    const { OFFLINE_URL, precacheEntries } = await import("../../../scripts/build-sw.mjs");
    expect(OFFLINE_URL).toBe(WORKER_OFFLINE_PATH);
    const urls = (precacheEntries() as { url: string }[]).map((e) => e.url);
    expect(urls).toContain("/m/offline");
    expect(urls).toContain("/worker.webmanifest");
    expect(urls).toContain("/icons/worker-192.png");
    expect(urls.every((u) => u === "/m/offline" || !u.startsWith("/m"))).toBe(true);
  });
});

describe("service worker scope", () => {
  /**
   * The service worker's scope "/m" is a prefix match: it would also control /manager or
   * /marketing. Fail if any top-level URL segment other than `m` starts with "m"
   * (route groups like (marketing) are not URL segments; their children are).
   */
  it("no top-level route other than /m starts with m", () => {
    const appDir = path.join(process.cwd(), "src", "app");
    const segments = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .flatMap((e) =>
          e.name.startsWith("(") && e.name.endsWith(")")
            ? segments(path.join(dir, e.name))
            : [e.name],
        );
    const clashes = segments(appDir).filter(
      (name) => name !== "m" && !name.startsWith("_") && !name.startsWith("@") && /^m/i.test(name),
    );
    expect(clashes).toEqual([]);
    expect(segments(appDir)).toContain("m");
  });
});
