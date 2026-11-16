/**
 * Slice 1.8: the daily upload sweep's route opens only for Vercel Cron's bearer secret, and
 * stays shut when no strong secret is configured.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const sweep = vi.hoisted(() => vi.fn(async () => ({ removed: 2 })));

vi.mock("@/server/people/imports/sweep", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/people/imports/sweep")>();
  return { ...actual, runImportUploadSweep: sweep };
});

import { GET } from "@/app/api/cron/import-uploads/route";
import { isCronRequest } from "@/server/people/imports/sweep";

const SECRET = "a-cron-secret-of-enough-length";

afterEach(() => {
  vi.unstubAllEnvs();
  sweep.mockClear();
});

describe("isCronRequest", () => {
  it("accepts only the configured bearer secret", () => {
    expect(isCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isCronRequest(SECRET, SECRET)).toBe(false);
    expect(isCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isCronRequest(null, SECRET)).toBe(false);
  });

  it("stays shut without a strong secret", () => {
    expect(isCronRequest("Bearer ", "")).toBe(false);
    expect(isCronRequest("Bearer undefined", undefined)).toBe(false);
    expect(isCronRequest("Bearer short", "short")).toBe(false);
  });
});

describe("GET /api/cron/import-uploads", () => {
  const call = (authorization?: string) =>
    GET(
      new Request("http://localhost/api/cron/import-uploads", {
        headers: authorization ? { authorization } : {},
      }),
    );

  it("runs the sweep for Vercel Cron", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: 2 });
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("answers an empty 404 to anyone else", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const authorization of [undefined, "Bearer wrong-secret-of-some-length"]) {
      const response = await call(authorization);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(404);
    expect(sweep).not.toHaveBeenCalled();
  });
});
