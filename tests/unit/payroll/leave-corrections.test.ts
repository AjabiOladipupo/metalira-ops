/**
 * Slice 5.7c: leave decided after its period was posted (docs/PHASE_5.md 5.7, "As built in 5.7c").
 * - Leave approved after posting is deducted in the next run as arrears, by 5.1's leave rule on
 *   the posted period's own rostered days, at the pay rate in force on each leave day.
 * - Leave cancelled after posting is refunded in the next run: exactly what the posted deduction
 *   took, line by line, with its pension and NHF bases restored.
 * The worker is on ₦120,000 a month (₦60,000 / ₦36,000 / ₦24,000) from 20 Sep 2026; before that
 * ₦110,000 (basic ₦50,000). The October 2026 cycle (20 Sep to 19 Oct) has 21 Monday-to-Friday
 * days, September's (20 Aug to 19 Sep) 22.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { roundHalfUp, sumKobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/earning-lines";
import {
  computeEarnings,
  POLICY_DEFAULTS,
  type EarningsWorker,
  type PayPolicy,
} from "@/lib/payroll/earnings";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import {
  parseLeaveCorrections,
  type LeaveArrearsInput,
  type LeaveRefundInput,
  type PayRateInput,
} from "@/lib/payroll/inputs";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import { workerPayslip } from "@/lib/payroll/run";

const SEP = { start: "2026-08-20", end: "2026-09-19" };
const OCT = { start: "2026-09-20", end: "2026-10-19" };
const NOV = { start: "2026-10-20", end: "2026-11-19" };
const MON_FRI = [1, 2, 3, 4, 5];
const POLICY: PayPolicy = {
  standardShiftMinutes: 480,
  hourlyRateDivisorDays: 20,
  workDaysPerWeek: 5,
  ...POLICY_DEFAULTS,
};

function monthly(over: Partial<PayRateInput> = {}): PayRateInput {
  return {
    id: randomUUID(),
    payType: "monthly",
    basic: 6_000_000n,
    housing: 3_600_000n,
    transport: 2_400_000n,
    otherAllowances: 0n,
    dailyRate: 0n,
    hourlyRate: 0n,
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
    ...over,
  };
}

const OLD = monthly({ effectiveTo: "2026-09-19", basic: 5_000_000n });
const NOW = monthly({ effectiveFrom: "2026-09-20" });

function worker(over: Partial<EarningsWorker> = {}): EarningsWorker {
  return {
    workerId: randomUUID(),
    employmentType: "permanent",
    startDate: "2025-01-06",
    endDate: null,
    usualWorkDays: null,
    payRates: [OLD, NOW],
    shifts: [],
    lastRostered: null,
    lines: [],
    arrears: [],
    leave: [],
    noShowDates: [],
    openLineCount: 0,
    ...over,
  };
}

function arrears(over: Partial<LeaveArrearsInput> = {}): LeaveArrearsInput {
  return {
    requestId: randomUUID(),
    typeCode: "unpaid",
    counting: "working_days",
    payPercent: 0,
    payBelowService: false,
    periodStart: SEP.start,
    periodEnd: SEP.end,
    from: "2026-09-10",
    to: "2026-09-11",
    rosteredDays: 22,
    shifts: [],
    ...over,
  };
}

const run = (w: EarningsWorker, period = NOV, holidays: string[] = []) =>
  computeEarnings({ period, holidays, defaultWorkDays: MON_FRI, worker: w }, POLICY);

const total = (lines: EarningLine[]) => sumKobo(lines.map((l) => l.amountKobo));
const byCode = (lines: EarningLine[], code: EarningLine["code"]) =>
  lines.filter((l) => l.code === code);

describe("leave approved after posting: arrears in the next run, after tax", () => {
  const arrearsOf = (r: ReturnType<typeof run>) =>
    (r.deductions ?? []).filter((d) => d.code === "leave_arrears");

  it("works out Thu 10 and Fri 11 Sep at September's rate, on September's 22 rostered days", () => {
    const a = arrears();
    const r = run(worker({ leaveArrears: [a] }));
    // ₦110,000 (the rate in force on those days) x 2 ÷ 22, rounded once: ₦10,000.
    const expected = roundHalfUp(11_000_000n * 2n, 22n);
    expect(expected).toBe(1_000_000n);
    const [d] = arrearsOf(r);
    expect(d).toEqual({
      code: "leave_arrears",
      label: "Unpaid leave in 20 Aug to 19 Sep, approved after posting (10 to 11 Sep, 2 days)",
      amountKobo: expected,
      sources: [{ kind: "leave_request", id: a.requestId, from: "2026-09-10", to: "2026-09-11" }],
    });
    // Not an earning: November's gross, taxable pay and pension base are untouched.
    expect(byCode(r.lines, "leave_deduction")).toEqual([]);
    expect(total(r.lines)).toBe(12_000_000n);
    expect(r.payRateIds).toContain(OLD.id);
    expect(r.trace.find((t) => t.step === "leave_arrears")).toMatchObject({
      valueKobo: expected,
      inputs: { leave_days: 2, rostered_days: 22, pay_percent: 0 },
    });
  });

  it("comes off after tax and pension: PAYE and pension stay as November's own pay sets them", () => {
    const r = run(worker({ leaveArrears: [arrears()] }));
    const plain = run(worker());
    const net = (x: ReturnType<typeof run>) =>
      workerPayslip(
        {
          employmentType: "permanent",
          earnings: x,
          adjustments: [],
          nhfOptIn: false,
          annualRentKobo: 0n,
          carriedDeductionKobo: 0n,
        },
        NTA_2025_V1,
        { itfApplies: false, ruleSetId: "test" },
      );
    const a = net(r);
    const b = net(plain);
    expect(a.payeKobo).toBe(b.payeKobo);
    expect(a.pensionEmployeeKobo).toBe(b.pensionEmployeeKobo);
    expect(a.grossKobo).toBe(b.grossKobo);
    expect(b.netKobo - a.netKobo).toBe(1_000_000n);
    expect(a.lines.find((l) => l.code === "leave_arrears")).toMatchObject({
      kind: "deduction",
      amountKobo: 1_000_000n,
      taxable: false,
      pensionable: false,
    });
  });

  it("never takes net pay below ₦0: what doesn't fit is carried (open question 6)", () => {
    // A 15-day unpaid leave from September against a worker earning ₦20,000 now.
    const small = monthly({
      effectiveFrom: "2026-09-20",
      basic: 1_000_000n,
      housing: 600_000n,
      transport: 400_000n,
    });
    const r = run(
      worker({
        payRates: [OLD, small],
        leaveArrears: [arrears({ from: "2026-08-24", to: "2026-09-11" })],
      }),
    );
    const slip = workerPayslip(
      {
        employmentType: "permanent",
        earnings: r,
        adjustments: [],
        nhfOptIn: false,
        annualRentKobo: 0n,
        carriedDeductionKobo: 0n,
      },
      NTA_2025_V1,
      { itfApplies: false, ruleSetId: "test" },
    );
    const wanted = arrearsOf(r)[0]!.amountKobo;
    const taken = slip.lines.find((l) => l.code === "leave_arrears")!.amountKobo;
    expect(slip.netKobo).toBe(0n);
    expect(taken + slip.carriedForwardKobo).toBe(wanted);
    expect(slip.carriedForwardKobo > 0n).toBe(true);
    expect(slip.flags).toContain("deduction_cut");
  });

  it("works out exactly what the posted run would have deducted, had the leave been approved before it", () => {
    const requestId = randomUUID();
    const inOctober = run(
      worker({
        leave: [
          {
            requestId,
            typeCode: "unpaid",
            counting: "working_days",
            startDate: "2026-10-12",
            endDate: "2026-10-14",
            payPercent: 0,
            payBelowService: false,
          },
        ],
      }),
      OCT,
    );
    const late = run(
      worker({
        leaveArrears: [
          arrears({
            requestId,
            periodStart: OCT.start,
            periodEnd: OCT.end,
            from: "2026-10-12",
            to: "2026-10-14",
            rosteredDays: inOctober.days.rostered,
          }),
        ],
      }),
    );
    expect(arrearsOf(late)[0]!.amountKobo).toBe(-total(byCode(inOctober.lines, "leave_deduction")));
    expect(arrearsOf(late)[0]!.amountKobo).toBe(roundHalfUp(12_000_000n * 3n, 21n));
  });

  it("prices a day at the rate in force on it", () => {
    const r = run(worker({ leaveArrears: [arrears({ from: "2026-09-18", to: "2026-09-18" })] }));
    expect(arrearsOf(r)[0]!.amountKobo).toBe(roundHalfUp(11_000_000n, 22n));
  });

  it("leaves a public holiday out of a working-day leave's days", () => {
    const r = run(worker({ leaveArrears: [arrears()] }), NOV, ["2026-09-11"]);
    expect(arrearsOf(r)[0]!.amountKobo).toBe(roundHalfUp(11_000_000n, 22n));
  });

  it("follows the worker's shifts in the posted period: an unrostered Friday deducts nothing", () => {
    const shifts = [{ date: "2026-09-10", onLeave: true }];
    const r = run(worker({ lastRostered: "2026-11-30", leaveArrears: [arrears({ shifts })] }));
    expect(arrearsOf(r)[0]!.amountKobo).toBe(roundHalfUp(11_000_000n, 22n));
  });

  it("never counts more days than the posted payslip's base", () => {
    // A base of 1 day (a joiner's posted payslip) caps the two leave days at one: the whole month.
    const r = run(worker({ leaveArrears: [arrears({ rosteredDays: 1 })] }));
    expect(arrearsOf(r)[0]!.amountKobo).toBe(11_000_000n);
    expect(r.trace.find((t) => t.step === "leave_arrears")?.inputs).toMatchObject({
      leave_days: 1,
    });
  });

  it("records ₦0 with its days when no working day is left, so it isn't looked at again", () => {
    const shifts: { date: string; onLeave: boolean }[] = [];
    const r = run(worker({ lastRostered: "2026-11-30", leaveArrears: [arrears({ shifts })] }));
    const [d] = arrearsOf(r);
    expect(d!.amountKobo).toBe(0n);
    expect(d!.label).toContain("no working days to deduct");
    expect(d!.sources).toHaveLength(1);
  });

  it("deducts half for leave paid at 50%, all of it below the pay's service, nothing at 100%", () => {
    expect(
      arrearsOf(run(worker({ leaveArrears: [arrears({ payPercent: 50 })] })))[0]!.amountKobo,
    ).toBe(500_000n);
    expect(
      arrearsOf(
        run(worker({ leaveArrears: [arrears({ payPercent: 50, payBelowService: true })] })),
      )[0]!.amountKobo,
    ).toBe(1_000_000n);
    expect(arrearsOf(run(worker({ leaveArrears: [arrears({ payPercent: 100 })] })))).toEqual([]);
  });

  it("flags leave without its pay record and deducts nothing", () => {
    const r = run(worker({ leaveArrears: [arrears({ payPercent: null })] }));
    expect(arrearsOf(r)).toEqual([]);
    expect(r.flags).toContain("leave_pay_missing");
  });

  it("gives a daily worker no leave arrears to recover (₦0, recorded once)", () => {
    const daily = { ...monthly(), payType: "daily" as const, dailyRate: 800_000n };
    const r = run(
      worker({ employmentType: "daily", payRates: [daily], leaveArrears: [arrears()] }),
    );
    expect(arrearsOf(r).map((d) => d.amountKobo)).toEqual([0n]);
  });
});

describe("refunding after-tax leave arrears", () => {
  it("pays an after-tax arrears line back outside tax and pension", () => {
    const requestId = randomUUID();
    const r = run(
      worker({
        leaveRefunds: [
          {
            requestId,
            from: "2026-09-10",
            to: "2026-09-11",
            periodStart: SEP.start,
            periodEnd: SEP.end,
            lines: [
              {
                code: "leave_arrears",
                wantedKobo: null,
                label:
                  "Unpaid leave in 20 Aug to 19 Sep, approved after posting (10 to 11 Sep, 2 days)",
                amountKobo: 1_000_000n,
                pensionable: false,
                taxable: false,
              },
            ],
          },
        ],
      }),
    );
    expect(byCode(r.lines, "leave_refund")).toEqual([
      expect.objectContaining({
        amountKobo: 1_000_000n,
        pensionable: false,
        taxable: false,
        nhfBase: false,
        label:
          "Leave refund in 20 Aug to 19 Sep, cancelled after posting (10 to 11 Sep), taken after tax",
      }),
    ]);
  });
});

describe("leave cancelled after posting: a refund in the next run", () => {
  /** October deducts 12 to 14 Oct unpaid; the leave is then cancelled. */
  function octoberDeduction() {
    const requestId = randomUUID();
    const oct = run(
      worker({
        leave: [
          {
            requestId,
            typeCode: "unpaid",
            counting: "working_days",
            startDate: "2026-10-12",
            endDate: "2026-10-14",
            payPercent: 0,
            payBelowService: false,
          },
        ],
      }),
      OCT,
    );
    const lines = byCode(oct.lines, "leave_deduction");
    const refund: LeaveRefundInput = {
      requestId,
      from: "2026-10-12",
      to: "2026-10-14",
      periodStart: OCT.start,
      periodEnd: OCT.end,
      lines: lines.map((l) => ({
        code: "leave_deduction" as const,
        wantedKobo: null,
        label: l.label,
        amountKobo: l.amountKobo,
        pensionable: l.pensionable,
        taxable: l.taxable,
      })),
    };
    return { requestId, lines, refund };
  }

  it("refunds a pre-tax line's carried rest after tax, after the pre-tax lines (5.9a, case D)", () => {
    const { lines, refund } = octoberDeduction();
    const [first, ...rest] = refund.lines;
    const withCarry = {
      ...refund,
      lines: [{ ...first!, carriedKobo: 50_000n }, ...rest.map((l) => ({ ...l, carriedKobo: 0n }))],
    };
    const r = run(worker({ leaveRefunds: [withCarry] }));
    const back = byCode(r.lines, "leave_refund");
    expect(back.map((l) => l.amountKobo)).toEqual([...lines.map((l) => -l.amountKobo), 50_000n]);
    expect(back.at(-1)).toMatchObject({ taxable: false, pensionable: false, nhfBase: false });
    expect(back.slice(0, -1).every((l) => l.taxable)).toBe(true);
  });

  it("pays back each deduction line exactly, with its bases, naming the deduction's days", () => {
    const { requestId, lines, refund } = octoberDeduction();
    const r = run(worker({ leaveRefunds: [refund] }));
    const back = byCode(r.lines, "leave_refund");
    expect(back.map((l) => l.amountKobo)).toEqual(lines.map((l) => -l.amountKobo));
    expect(total(back)).toBe(roundHalfUp(12_000_000n * 3n, 21n));
    expect(back.map((l) => [l.pensionable, l.nhfBase])).toEqual([
      [true, true],
      [true, false],
      [true, false],
    ]);
    expect(back[0]!.label).toBe(
      "Leave refund in 20 Sep to 19 Oct, cancelled after posting (12 to 14 Oct), basic",
    );
    for (const l of back) {
      expect(l.sources).toEqual([
        { kind: "leave_refund", id: requestId, from: "2026-10-12", to: "2026-10-14" },
      ]);
    }
    expect(r.trace.find((t) => t.step === "leave_refund")?.valueKobo).toBe(total(back));
  });

  it("restores the pension and NHF bases the deduction lowered", () => {
    const { lines, refund } = octoberDeduction();
    const base = run(worker(), NOV);
    const withRefund = run(worker({ leaveRefunds: [refund] }));
    const opts = { itfApplies: false };
    const input = (earnings: EarningLine[]) => ({
      employmentType: "permanent" as const,
      earnings,
      nhfOptIn: true,
      annualRentKobo: 0n,
      deductions: [],
      carriedDeductionKobo: 0n,
    });
    const plain = grossToNet(input(base.lines), NTA_2025_V1, opts);
    const refunded = grossToNet(input(withRefund.lines), NTA_2025_V1, opts);
    const refundTotal = -total(lines);
    expect(refunded.grossKobo - plain.grossKobo).toBe(refundTotal);
    // 8% employee pension on the whole refund (basic + housing + transport), rounded once.
    expect(refunded.pensionEmployeeKobo).toBe(
      roundHalfUp((12_000_000n + refundTotal) * 800n, 10_000n),
    );
    // NHF on basic only: the basic line's refund.
    expect(refunded.nhfKobo).toBe(roundHalfUp((6_000_000n - lines[0]!.amountKobo) * 250n, 10_000n));
  });

  it("pays nothing back for a line that took nothing", () => {
    const { refund } = octoberDeduction();
    const r = run(
      worker({
        leaveRefunds: [
          {
            ...refund,
            lines: [
              {
                code: "leave_deduction",
                wantedKobo: null,
                label: "x, basic",
                amountKobo: 0n,
                pensionable: true,
                taxable: true,
              },
            ],
          },
        ],
      }),
    );
    expect(byCode(r.lines, "leave_refund")).toEqual([]);
    expect(r.trace.some((t) => t.step === "leave_refund")).toBe(false);
  });
});

describe("parseLeaveCorrections", () => {
  it("reads the database's shape into arrears and refunds by worker", () => {
    const w = randomUUID();
    const q = randomUUID();
    const parsed = parseLeaveCorrections({
      version: 1,
      period: { start: NOV.start, end: NOV.end },
      workers: [
        {
          worker_id: w,
          leave_arrears: [
            {
              request_id: q,
              type_code: "unpaid",
              counting: "working_days",
              pay_percent: 0,
              pay_below_service: false,
              period_start: OCT.start,
              period_end: OCT.end,
              from: "2026-10-15",
              to: "2026-10-16",
              rostered_days: 21,
              shifts: [{ date: "2026-10-15", on_leave: true }],
            },
          ],
          leave_refunds: [
            {
              request_id: q,
              from: "2026-10-12",
              to: "2026-10-13",
              period_start: OCT.start,
              period_end: OCT.end,
              lines: [
                {
                  label: "Unpaid leave, basic",
                  amount_kobo: "-285714",
                  pensionable: true,
                  taxable: true,
                },
              ],
            },
          ],
        },
      ],
    });
    const mine = parsed.byWorker.get(w)!;
    expect(mine.leaveArrears[0]).toMatchObject({
      requestId: q,
      rosteredDays: 21,
      shifts: [{ date: "2026-10-15", onLeave: true }],
    });
    expect(mine.leaveRefunds[0]!.lines[0]!.amountKobo).toBe(-285_714n);
  });

  it("refuses a shape it doesn't know", () => {
    expect(() => parseLeaveCorrections({ version: 2, workers: [] })).toThrow();
  });
});

describe("partly recovered arrears, then cancelled (net ₦0 for the days)", () => {
  it("refunds the full amount owed, so the carried rest still collected nets to ₦0", () => {
    // November: the ₦100,000 arrears (10 working days of September at ₦220,000 ÷ 22) against a
    // ₦20,000 salary: some is taken, the rest carried.
    const small = monthly({
      effectiveFrom: "2026-09-20",
      basic: 1_000_000n,
      housing: 600_000n,
      transport: 400_000n,
    });
    const big = monthly({
      effectiveTo: "2026-09-19",
      basic: 11_000_000n,
      housing: 6_600_000n,
      transport: 4_400_000n,
    });
    const slipOf = (earnings: ReturnType<typeof run>, carried: bigint) =>
      workerPayslip(
        {
          employmentType: "daily",
          earnings,
          adjustments: [],
          nhfOptIn: false,
          annualRentKobo: 0n,
          carriedDeductionKobo: carried,
        },
        NTA_2025_V1,
        { itfApplies: false, ruleSetId: "test" },
      );
    const leave = arrears({ from: "2026-08-31", to: "2026-09-11" });
    const nov = run(worker({ payRates: [big, small], leaveArrears: [leave] }));
    const novSlip = slipOf(nov, 0n);
    const wanted = nov.deductions![0]!.amountKobo;
    const taken = novSlip.lines.find((l) => l.code === "leave_arrears")!.amountKobo;
    expect(taken + novSlip.carriedForwardKobo).toBe(wanted);
    expect(novSlip.carriedForwardKobo > 0n).toBe(true);
    // The trace keeps the full amount the line wanted (what the database reads for the refund).
    const step = novSlip.trace.find(
      (t) => t.step === "leave_arrears" && t.label === `Less ${nov.deductions![0]!.label}`,
    );
    expect(step?.inputs.wanted_kobo).toBe(wanted.toString());

    // December: the leave was cancelled. The refund is the full amount; the carried rest is taken.
    const dec = run(
      worker({
        payRates: [big, small],
        leaveRefunds: [
          {
            requestId: leave.requestId,
            from: leave.from,
            to: leave.to,
            periodStart: SEP.start,
            periodEnd: SEP.end,
            lines: [
              {
                code: "leave_arrears",
                label: nov.deductions![0]!.label,
                amountKobo: taken,
                wantedKobo: wanted,
                pensionable: false,
                taxable: false,
              },
            ],
          },
        ],
      }),
      { start: "2026-11-20", end: "2026-12-19" },
    );
    const decSlip = slipOf(dec, novSlip.carriedForwardKobo);
    const refunded = sumKobo(
      decSlip.lines.filter((l) => l.code === "leave_refund").map((l) => l.amountKobo),
    );
    const carriedTaken = sumKobo(
      decSlip.lines.filter((l) => l.code === "carried_deduction").map((l) => l.amountKobo),
    );
    expect(refunded).toBe(wanted);
    expect(carriedTaken).toBe(novSlip.carriedForwardKobo);
    // Over the two runs: taken + carried taken − refunded = ₦0 for the cancelled days.
    expect(taken + carriedTaken - refunded).toBe(0n);
    expect(decSlip.carriedForwardKobo).toBe(0n);
  });
});
