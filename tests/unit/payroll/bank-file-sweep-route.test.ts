/**
 * Slice 5.4 (security review M2): the daily /api/cron/import-uploads run also sweeps payroll bank
 * files, and a failing bank-file sweep doesn't stop the import sweep's answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const uploads = vi.hoisted(() => vi.fn(async () => ({ removed: 2 })));
const bankFiles = vi.hoisted(() => vi.fn(async () => ({ removed: 1 })));

vi.mock("@/server/people/imports/sweep", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/people/imports/sweep")>();
  return { ...actual, runImportUploadSweep: uploads };
});
vi.mock("@/server/payroll/payout-sweep", () => ({ runPayrollFileSweep: bankFiles }));

import { GET } from "@/app/api/cron/import-uploads/route";

const SECRET = "a-cron-secret-of-enough-length";
const call = () =>
  GET(
    new Request("http://localhost/api/cron/import-uploads", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  uploads.mockClear();
  bankFiles.mockClear();
});

describe("the daily sweep removes bank files too", () => {
  it("runs the bank-file sweep with the upload sweep", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = await call();
    expect(response.status).toBe(200);
    expect(bankFiles).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveBeenCalledTimes(1);
  });

  it("logs a failed bank-file sweep by name only and still answers", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    bankFiles.mockRejectedValueOnce(new Error("payroll-files/a/b/c.csv failed"));
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: 2 });
    expect(logged).toHaveBeenCalledWith("payroll.bank_file_sweep_failed:", "Error");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("payroll-files/");
  });

  it("doesn't run for anyone else", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await GET(new Request("http://localhost/api/cron/import-uploads"));
    expect(bankFiles).not.toHaveBeenCalled();
  });
});
