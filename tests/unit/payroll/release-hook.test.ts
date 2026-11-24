/**
 * Slice 5.4 with 5.5: a release publishes the payslips. `onPayrollReleased` (run by the release
 * Server Action in `after()`, once release_payroll_run returned, on a retry too) calls
 * publishPayslips with who released, and a failure is logged by error name only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const publish = vi.hoisted(() => vi.fn(async () => ({ made: 2, notified: 2 })));
vi.mock("@/server/payroll/payslip-documents", () => ({ publishPayslips: publish }));

const { onPayrollReleased, RELEASE_FOLLOW_UPS } = await import("@/server/payroll/release");

const ORG = "a0000000-0000-4000-8000-000000000001";
const RUN = "c0000000-0000-4000-8000-000000000003";
const FIN = "b0000000-0000-4000-8000-000000000002";

afterEach(() => {
  publish.mockClear();
  vi.restoreAllMocks();
});

describe("what follows a release", () => {
  it("publishes the payslips (PDFs and notices) with who released, every time it runs", async () => {
    expect(RELEASE_FOLLOW_UPS).toHaveLength(1);
    await onPayrollReleased(ORG, RUN, { actorId: FIN });
    // A retried release runs it again; publication is idempotent.
    await onPayrollReleased(ORG, RUN, { actorId: FIN });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(ORG, RUN, { actorId: FIN });
  });

  it("never throws: a failed publication is logged by name only", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    publish.mockRejectedValueOnce(new TypeError(`no PDF for ${RUN}`));
    await expect(onPayrollReleased(ORG, RUN, { actorId: null })).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith("payroll.release_followup_failed:", "TypeError");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(RUN);
  });
});
