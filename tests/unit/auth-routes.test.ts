import { describe, expect, it } from "vitest";

import { proxyDecision, safeNextPath } from "@/lib/auth/routes";

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
