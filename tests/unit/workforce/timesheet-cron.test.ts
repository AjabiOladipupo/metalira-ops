/**
 * Slice 4.2: the daily timesheet refresh. The route opens only for Vercel Cron's bearer secret;
 * the runner pages through companies, refreshes each in its own call, carries on past one
 * company's failure and stops before the time limit. Slice 4.3 (must-do 7): failed workers come
 * back with their SQLSTATE codes only, and a run with failures or cut short answers 500.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() =>
  vi.fn(async () => ({
    companies: 2,
    failed: 0,
    inserted: 5,
    updated: 1,
    deleted: 0,
    failedWorkers: 0,
    failedCodes: [] as string[],
    complete: true,
  })),
);

vi.mock("@/server/workforce/timesheet-cron", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/workforce/timesheet-cron")>();
  return { ...actual, runTimesheetCron: run };
});

import { GET } from "@/app/api/cron/timesheets/route";
import { refreshAllTimesheets } from "@/server/workforce/timesheet-cron";

const SECRET = "a-cron-secret-of-enough-length";

afterEach(() => {
  vi.unstubAllEnvs();
  run.mockClear();
});

describe("GET /api/cron/timesheets", () => {
  const call = (authorization?: string) =>
    GET(
      new Request("http://localhost/api/cron/timesheets", {
        headers: authorization ? { authorization } : {},
      }),
    );

  it("runs the refresh for Vercel Cron", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ companies: 2, inserted: 5 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers 500 with counts and codes only when workers failed or the run stopped early", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    run.mockResolvedValueOnce({
      companies: 2,
      failed: 0,
      inserted: 5,
      updated: 1,
      deleted: 0,
      failedWorkers: 2,
      failedCodes: ["23514"],
      complete: true,
    });
    const failed = await call(`Bearer ${SECRET}`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ failedWorkers: 2, failedCodes: ["23514"] });
    expect(error).toHaveBeenCalledWith(
      "timesheets.cron_incomplete:",
      "failed=0",
      "workers=2",
      "complete=true",
      "codes=23514",
    );
    run.mockResolvedValueOnce({
      companies: 1,
      failed: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      failedWorkers: 0,
      failedCodes: [],
      complete: false,
    });
    expect((await call(`Bearer ${SECRET}`)).status).toBe(500);
    error.mockRestore();
  });

  it("answers an empty 404 to anyone else, and with no secret configured", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const authorization of [undefined, "Bearer wrong-secret-of-some-length"]) {
      const response = await call(authorization);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});

type Rpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { code: string } | null }>;

function fakeAdmin(orgs: string[], failing: Set<string> = new Set()) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "timesheet_cron_organisations") {
      const after = (args.p_after as string | undefined) ?? "";
      const limit = args.p_limit as number;
      return { data: orgs.filter((o) => o > after).slice(0, limit), error: null };
    }
    const id = args.p_organisation_id as string;
    if (failing.has(id)) return { data: null, error: { code: "XX000" } };
    return { data: { inserted: 2, updated: 1, deleted: 0 }, error: null };
  };
  return { admin: { rpc } as never, calls };
}

describe("refreshAllTimesheets", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);

  it("pages through every company, one refresh call each, and counts", async () => {
    const orgs = ids(120);
    const { admin, calls } = fakeAdmin(orgs);
    const result = await refreshAllTimesheets(admin);
    expect(result).toEqual({
      companies: 120,
      failed: 0,
      inserted: 240,
      updated: 120,
      deleted: 0,
      failedWorkers: 0,
      failedCodes: [],
      complete: true,
    });
    expect(calls.filter((c) => c.name === "timesheet_cron_organisations")).toHaveLength(3);
    expect(calls.filter((c) => c.name === "refresh_timesheets_recent")).toHaveLength(120);
  });

  it("carries on past a company that fails, logging only the code", async () => {
    const orgs = ids(3);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin(orgs, new Set([orgs[1]!]));
    const result = await refreshAllTimesheets(admin);
    expect(result).toMatchObject({ companies: 2, failed: 1, complete: true });
    expect(error).toHaveBeenCalledWith("timesheets.cron_company_failed:", "XX000");
    expect(JSON.stringify(error.mock.calls)).not.toContain(orgs[1]!);
    error.mockRestore();
  });

  it("collects the distinct SQLSTATE codes of failed workers and drops anything else", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = async (name: string) => {
      if (name === "timesheet_cron_organisations") {
        return { data: ["00000000-0000-0000-0000-000000000001"], error: null };
      }
      return {
        data: {
          inserted: 0,
          updated: 0,
          deleted: 0,
          failed: 3,
          failed_codes: ["23514", "23514", "P0001", "Musa Bello 08031234567"],
        },
        error: null,
      };
    };
    const result = await refreshAllTimesheets({ rpc } as never);
    expect(result.failedWorkers).toBe(3);
    expect(result.failedCodes).toEqual(["23514", "P0001"]);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("23514,P0001");
    expect(logged).not.toContain("Musa");
    expect(logged).not.toContain("0803");
    error.mockRestore();
  });

  it("stops before the time limit and says it did not finish", async () => {
    const orgs = ids(10);
    const { admin } = fakeAdmin(orgs);
    let t = 0;
    const result = await refreshAllTimesheets(admin, () => {
      t += 10_000;
      return t;
    });
    expect(result.complete).toBe(false);
    expect(result.companies).toBeLessThan(10);
  });
});
