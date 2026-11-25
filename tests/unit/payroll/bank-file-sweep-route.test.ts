/**
 * Slice 5.4 (security review M2): the daily /api/cron/contract-documents run also sweeps payroll
 * bank files through the Storage API, and a failing bank-file sweep doesn't stop the others.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const uploads = vi.hoisted(() => vi.fn(async () => ({ removed: 2 })));
const receipts = vi.hoisted(() => vi.fn(async () => ({ deleted: 0 })));
const bankFiles = vi.hoisted(() => vi.fn(async () => ({ removed: 1 })));
const proofs = vi.hoisted(() => vi.fn(async () => ({ deleted: 3 })));

vi.mock("@/server/business/contract-document-sweep", () => ({
  runContractDocumentSweep: uploads,
}));
vi.mock("@/server/payroll/receipt-sweep", () => ({ runReceiptSweep: receipts }));
vi.mock("@/server/payroll/payout-sweep", () => ({ runPayrollFileSweep: bankFiles }));
vi.mock("@/server/payroll/relief-proof-sweep", () => ({ runReliefProofSweep: proofs }));

import { GET } from "@/app/api/cron/contract-documents/route";

const SECRET = "a-cron-secret-of-enough-length";
const call = () =>
  GET(
    new Request("http://localhost/api/cron/contract-documents", {
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
  it("runs the bank-file sweep with the document and receipt sweeps", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removed: 2,
      bankFilesDeleted: 1,
      proofUploadsDeleted: 3,
    });
    expect(bankFiles).toHaveBeenCalledTimes(1);
    // Slice 5.9a (security review M1): relief-proof uploads that never became a proof.
    expect(proofs).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveBeenCalledTimes(1);
  });

  it("logs a failed bank-file sweep by name only and still answers", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    bankFiles.mockRejectedValueOnce(new Error("payroll-files/a/b/c.csv failed"));
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removed: 2, bankFilesDeleted: null });
    expect(logged).toHaveBeenCalledWith("payroll.bank_file_sweep_failed:", "Error");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("payroll-files/");
  });

  it("doesn't run for anyone else", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await GET(new Request("http://localhost/api/cron/contract-documents"));
    expect(bankFiles).not.toHaveBeenCalled();
  });
});
