import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/debug/sentry/route";
import { isSentryTestTokenValid, SENTRY_TEST_HEADER } from "@/server/observability/sentry-test";

const TOKEN = "a-long-random-test-token-0123456789";

function post(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/debug/sentry", { method: "POST", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isSentryTestTokenValid", () => {
  it("accepts only the exact configured token", () => {
    expect(isSentryTestTokenValid(TOKEN, TOKEN)).toBe(true);
    expect(isSentryTestTokenValid(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(isSentryTestTokenValid(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(isSentryTestTokenValid(TOKEN.toUpperCase(), TOKEN)).toBe(false);
  });

  it("rejects everything when no token is configured", () => {
    expect(isSentryTestTokenValid("", undefined)).toBe(false);
    expect(isSentryTestTokenValid(undefined, undefined)).toBe(false);
    expect(isSentryTestTokenValid("anything", "")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isSentryTestTokenValid(null, TOKEN)).toBe(false);
    expect(isSentryTestTokenValid("", TOKEN)).toBe(false);
  });

  it("treats a short configured token as unset", () => {
    expect(isSentryTestTokenValid("short", "short")).toBe(false);
  });
});

describe("POST /api/debug/sentry", () => {
  it("returns an empty 404 when SENTRY_TEST_TOKEN is unset", async () => {
    vi.stubEnv("SENTRY_TEST_TOKEN", "");
    const res = await POST(post({ [SENTRY_TEST_HEADER]: TOKEN }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("returns 404 without the header", async () => {
    vi.stubEnv("SENTRY_TEST_TOKEN", TOKEN);
    const res = await POST(post());
    expect(res.status).toBe(404);
  });

  it("returns 404 with a wrong token", async () => {
    vi.stubEnv("SENTRY_TEST_TOKEN", TOKEN);
    const res = await POST(post({ [SENTRY_TEST_HEADER]: "wrong-token-wrong-token" }));
    expect(res.status).toBe(404);
  });

  it("throws the test error with the right token", async () => {
    vi.stubEnv("SENTRY_TEST_TOKEN", TOKEN);
    await expect(POST(post({ [SENTRY_TEST_HEADER]: TOKEN }))).rejects.toThrow(
      /^Sentry test error /,
    );
  });
});

describe("GET /api/debug/sentry", () => {
  it("always returns 404", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
  });
});
