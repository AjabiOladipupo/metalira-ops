/**
 * Slice 5.8 (Phase 5 review fix-up): the pure parts.
 * - A carried deduction is taken once: a full-pay off-cycle run for an earlier period than a
 *   posted run that already carried the worker on takes none (money review), with the scenario
 *   August carries X, September misses the worker, October takes X, then a September
 *   missed-worker run is created.
 * - A leave refund that pays back arrears still in the carried balance is flagged ("Refund
 *   includes ₦X not yet recovered from carried deductions"; owner decision), acknowledgeable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeAnomaly } from "@/lib/payroll/anomaly-text";
import {
  ANOMALY_SEVERITY,
  carrySettledLater,
  carrySettledLaterAnomalies,
  offCycleCarriedKobo,
  refundUncollectedAnomalies,
  refundUncollectedKobo,
  workerHistory,
  type CarryRun,
} from "@/lib/payroll/run";

const W = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AUG = "2026-07-20";
const SEP = "2026-08-20";
const OCT = "2026-09-20";
const X = 2_500_000n; // ₦25,000 carried from August

const run = (id: string, periodStart: string, over: Partial<CarryRun> = {}): CarryRun => ({
  id,
  kind: "regular",
  status: "approved",
  periodStart,
  offCycleReason: null,
  ...over,
});

describe("a carried deduction is taken once (slice 5.8)", () => {
  // August carries X for W; September's regular run misses W; October's regular run takes X (W's
  // latest posted payslip is August's). Then HR creates a September missed-worker run for W.
  const runs = [run("aug", AUG), run("sep", SEP), run("oct", OCT)];
  const slips = [
    { runId: "aug", workerId: W },
    { runId: "sep", workerId: OTHER },
    { runId: "oct", workerId: W },
  ];

  it("would take X again from August's payslip without the check", () => {
    // What the September run's history reads: the regular run before September is August's.
    const h = workerHistory(
      W,
      {
        periodStart: AUG,
        posted: true,
        slips: new Map([[W, { netKobo: 0n, carriedForwardKobo: X }]]),
      },
      new Map([[W, { netKobo: 0n, carriedForwardKobo: X }]]),
    );
    expect(h.carriedKobo).toBe(X);
  });

  it("finds October settled W's carry, so the September missed-worker run takes none", () => {
    const settled = carrySettledLater(SEP, runs, slips);
    expect([...settled]).toEqual([[W, OCT]]);
    expect(offCycleCarriedKobo(X, false, settled.get(W))).toBe(0n);
    // A worker no later run holds keeps their carry.
    expect(offCycleCarriedKobo(X, false, settled.get(OTHER))).toBe(X);
    // A correction or one-off run never takes one (5.7b).
    expect(offCycleCarriedKobo(X, true, undefined)).toBe(0n);
  });

  it("counts only posted carrying runs of a later period", () => {
    const list = [
      run("oct-draft", OCT, { status: "review" }),
      run("oct-reversed", OCT, { status: "reversed" }),
      run("oct-reversal", OCT, { kind: "reversal" }),
      run("oct-one-off", OCT, { kind: "off_cycle", offCycleReason: "one_off" }),
      run("oct-correction", OCT, { kind: "off_cycle", offCycleReason: "correction" }),
      run("sep-same", SEP),
    ];
    const held = list.map((r) => ({ runId: r.id, workerId: W }));
    expect(carrySettledLater(SEP, list, held).size).toBe(0);
    const finalPay = run("oct-final", OCT, { kind: "off_cycle", offCycleReason: "final_pay" });
    const nov = run("nov", "2026-10-20");
    expect([
      ...carrySettledLater(
        SEP,
        [finalPay, nov],
        [
          { runId: "nov", workerId: W },
          { runId: "oct-final", workerId: W },
        ],
      ),
    ]).toEqual([[W, OCT]]);
  });

  it("shows the skipped carry and blocks a new carry nobody would take", () => {
    expect(carrySettledLaterAnomalies(W, OCT, X, 0n)).toEqual([
      {
        workerId: W,
        code: "carry_settled_later",
        severity: "warning",
        detail: { period_start: OCT },
      },
    ]);
    expect(carrySettledLaterAnomalies(W, OCT, 0n, 0n)).toEqual([]);
    const blocked = carrySettledLaterAnomalies(W, OCT, 0n, 1_000n);
    expect(blocked).toEqual([
      {
        workerId: W,
        code: "calculation_failed",
        severity: "blocking",
        detail: { deduction_cut: true, carry_settled_later: true, period_start: OCT },
      },
    ]);
    expect(ANOMALY_SEVERITY.carry_settled_later).toBe("warning");
    expect(describeAnomaly("carry_settled_later", { period_start: OCT }, "Musa Ibrahim")).toEqual({
      title: "Carried deduction already taken · Musa Ibrahim",
      body: expect.stringContaining("already took this worker's carried deductions"),
    });
    expect(
      describeAnomaly("calculation_failed", blocked[0]!.detail, "Musa Ibrahim").body,
    ).toContain("already settled this worker's carried deductions");
  });
});

describe("a refund paying back arrears still carried is flagged (owner decision)", () => {
  // October's arrears wanted ₦30,000 and took ₦10,000 (net cut to ₦0); ₦20,000 was carried.
  const refunds = [
    {
      lines: [
        { code: "leave_arrears", amountKobo: 1_000_000n, wantedKobo: 3_000_000n },
        { code: "leave_deduction", amountKobo: -500_000n, wantedKobo: null },
      ],
    },
  ];

  it("is the arrears' carried rest, at most the carried balance brought in", () => {
    expect(refundUncollectedKobo(refunds, 5_000_000n)).toBe(2_000_000n);
    expect(refundUncollectedKobo(refunds, 1_234_567n)).toBe(1_234_567n);
    expect(refundUncollectedKobo(refunds, 0n)).toBe(0n);
    // Fully taken at posting, or no wanted figure on the trace: nothing carried.
    expect(
      refundUncollectedKobo(
        [{ lines: [{ code: "leave_arrears", amountKobo: 3_000_000n, wantedKobo: 3_000_000n }] }],
        5_000_000n,
      ),
    ).toBe(0n);
    expect(
      refundUncollectedKobo(
        [{ lines: [{ code: "leave_arrears", amountKobo: 1_000_000n, wantedKobo: null }] }],
        5_000_000n,
      ),
    ).toBe(0n);
  });

  it("raises an acknowledgeable warning naming the amount", () => {
    expect(refundUncollectedAnomalies(W, 0n)).toEqual([]);
    const [a] = refundUncollectedAnomalies(W, 2_000_050n);
    expect(a).toEqual({
      workerId: W,
      code: "refund_uncollected_carry",
      severity: "warning",
      detail: { naira: "20,000", kobo: 50 },
    });
    expect(ANOMALY_SEVERITY.refund_uncollected_carry).toBe("warning");
    expect(describeAnomaly(a!.code, a!.detail, "Grace Edet").title).toBe(
      "Refund includes ₦20,000.50 not yet recovered from carried deductions · Grace Edet",
    );
  });

  it("never stores a run of 10 digits, even for ₦1,000,000,000 (money review L2)", () => {
    const [a] = refundUncollectedAnomalies(W, 100_000_000_000n);
    expect(a!.detail).toEqual({ naira: "1,000,000,000", kobo: 0 });
    // The database's anomaly detail check: no run of 10 digits outside ids.
    expect(JSON.stringify(a!.detail)).not.toMatch(/[0-9]{10}/);
    expect(describeAnomaly(a!.code, a!.detail, "Grace Edet").title).toContain("₦1,000,000,000.00");
  });
});

describe("the tax adviser line stays off the worker's payslip (owner decision)", () => {
  /** Every source file under a folder. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : /\.(ts|tsx)$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  }

  it("is in no worker-app screen, nor the payslip PDF or its view", () => {
    const files = [
      ...sources(join(process.cwd(), "src/app/m")),
      join(process.cwd(), "src/server/payroll/payslip-pdf.tsx"),
      join(process.cwd(), "src/lib/payroll/payslip-view.ts"),
    ];
    expect(files.some((f) => f.includes("payslips"))).toBe(true);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/TAX_ADVISER_LINE|tax adviser/i);
    }
  });
});
