import { describe, expect, it } from "vitest";

import {
  emailLinkNextPath,
  isWorkerAppMetadata,
  proxyDecision,
  safeNextPath,
} from "@/lib/auth/routes";

describe("safeNextPath", () => {
  it("keeps paths inside the manager app, with query and hash", () => {
    expect(safeNextPath("/app")).toBe("/app");
    expect(safeNextPath("/app/people")).toBe("/app/people");
    expect(safeNextPath("/app/people?site=2#top")).toBe("/app/people?site=2#top");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["absolute URL", "https://evil.example/app"],
    ["protocol-relative", "//evil.example/app"],
    ["backslash host", "/\\evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["relative path", "app/people"],
    ["outside the app", "/sign-in"],
    ["lookalike prefix", "/application"],
    ["dot segments out of the app", "/app/../sign-in"],
    ["encoded newline", "/app\n/people"],
    ["tab", "/app/\tpeople"],
    ["too long", `/app/${"a".repeat(600)}`],
  ])("falls back for %s", (_label, value) => {
    expect(safeNextPath(value)).toBe("/app");
  });

  it("uses the given fallback", () => {
    expect(safeNextPath("https://evil.example", "/app/payroll")).toBe("/app/payroll");
  });
});

describe("emailLinkNextPath", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("uses the link's own next when it has one", () => {
    expect(emailLinkNextPath(params("token_hash=t&type=email&next=/app"))).toBe("/app");
    expect(emailLinkNextPath(params("next=%2Fapp%2Fpayroll"))).toBe("/app/payroll");
    expect(emailLinkNextPath(params("next=https://evil.example/app"))).toBe("/app");
  });

  it("takes next from the magic link's redirect_to, escaped or not, ignoring its origin", () => {
    const redirect = "http://localhost:3350/auth/callback?next=%2Fapp%2Fpayroll";
    expect(emailLinkNextPath(params(`redirect_to=${encodeURIComponent(redirect)}`))).toBe(
      "/app/payroll",
    );
    expect(emailLinkNextPath(params(`type=magiclink&redirect_to=${redirect}`))).toBe(
      "/app/payroll",
    );
    expect(
      emailLinkNextPath(
        params(`redirect_to=${encodeURIComponent("https://evil.example/x?next=/app/people")}`),
      ),
    ).toBe("/app/people");
  });

  it.each([
    ["no redirect", ""],
    ["Site URL fallback", "redirect_to=https%3A%2F%2Fops.example"],
    ["not a URL", "redirect_to=%2Fapp%2Fpayroll"],
    [
      "unsafe next inside",
      `redirect_to=${encodeURIComponent("https://ops.example/?next=//evil.example")}`,
    ],
    [
      "too long",
      `redirect_to=${encodeURIComponent(`https://ops.example/?next=/app/${"a".repeat(1100)}`)}`,
    ],
  ])("falls back to /app: %s", (_label, query) => {
    expect(emailLinkNextPath(params(query))).toBe("/app");
  });
});

describe("proxyDecision", () => {
  it("sends signed-out visitors of /app to sign-in, keeping where they were going", () => {
    expect(proxyDecision("/app", "", false)).toEqual({ type: "redirect", location: "/sign-in" });
    expect(proxyDecision("/app/people", "", false)).toEqual({
      type: "redirect",
      location: "/sign-in?next=%2Fapp%2Fpeople",
    });
    expect(proxyDecision("/app/people", "?site=2", false)).toEqual({
      type: "redirect",
      location: "/sign-in?next=%2Fapp%2Fpeople%3Fsite%3D2",
    });
  });

  it("sends signed-in visitors of sign-in and sign-up on to the app", () => {
    expect(proxyDecision("/sign-in", "", true)).toEqual({ type: "redirect", location: "/app" });
    expect(proxyDecision("/sign-up", "", true)).toEqual({ type: "redirect", location: "/app" });
    expect(proxyDecision("/sign-in", "?next=%2Fapp%2Fleave", true)).toEqual({
      type: "redirect",
      location: "/app/leave",
    });
    expect(proxyDecision("/sign-in", "?next=https%3A%2F%2Fevil.example", true)).toEqual({
      type: "redirect",
      location: "/app",
    });
  });

  it.each([
    ["/app", true],
    ["/app/payroll", true],
    ["/sign-in", false],
    ["/sign-up", false],
    ["/no-access", true],
    ["/no-access", false],
    ["/m/sign-in", false],
    ["/design-system", false],
    ["/", false],
    ["/auth/callback", false],
    ["/application", false],
  ])("lets %s through (signed in: %s)", (path, hasUser) => {
    expect(proxyDecision(path, "", hasUser)).toEqual({ type: "next" });
  });
});

describe("proxyDecision for the worker app (slice 1.9)", () => {
  it("sends signed-out visitors of worker pages to the worker sign-in", () => {
    for (const path of ["/m", "/m/clock", "/m/me"]) {
      expect(proxyDecision(path, "", false)).toEqual({ type: "redirect", location: "/m/sign-in" });
    }
  });

  it("lets anyone open the worker sign-in and invite links", () => {
    expect(proxyDecision("/m/sign-in", "", false)).toEqual({ type: "next" });
    expect(proxyDecision(`/m/invite/${"a".repeat(64)}`, "", false)).toEqual({ type: "next" });
    expect(proxyDecision(`/m/invite/${"a".repeat(64)}`, "", true, true)).toEqual({ type: "next" });
  });

  it("sends a worker session away from the manager app and its sign-in pages", () => {
    for (const path of ["/app", "/app/people", "/sign-in", "/sign-up"]) {
      expect(proxyDecision(path, "", true, true)).toEqual({ type: "redirect", location: "/m" });
    }
  });

  it("skips the worker sign-in for a worker who is signed in", () => {
    expect(proxyDecision("/m/sign-in", "", true, true)).toEqual({
      type: "redirect",
      location: "/m",
    });
    expect(proxyDecision("/m", "", true, true)).toEqual({ type: "next" });
  });

  it("leaves a manager session on worker pages to the page's own check", () => {
    expect(proxyDecision("/m", "", true, false)).toEqual({ type: "next" });
    expect(proxyDecision("/m/sign-in", "", true, false)).toEqual({ type: "next" });
  });

  it("does not treat lookalike paths as the worker app", () => {
    expect(proxyDecision("/media", "", false)).toEqual({ type: "next" });
    expect(proxyDecision("/m-sign-in", "", false)).toEqual({ type: "next" });
  });
});

describe("isWorkerAppMetadata", () => {
  it("is true only for the server-set worker mark", () => {
    expect(isWorkerAppMetadata({ login: "worker", provider: "email" })).toBe(true);
    expect(isWorkerAppMetadata({ login: "manager" })).toBe(false);
    expect(isWorkerAppMetadata({})).toBe(false);
    expect(isWorkerAppMetadata(null)).toBe(false);
    expect(isWorkerAppMetadata("worker")).toBe(false);
  });
});
