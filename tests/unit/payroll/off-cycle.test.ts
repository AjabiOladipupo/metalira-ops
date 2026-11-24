/**
 * Slice 5.7b: off-cycle runs (docs/PHASE_5.md "As built in 5.7b"). An off-cycle run uses the same
 * engine as a regular run: a leaver's final pay is the earnings stage with the worker's end date
 * (the pay policy's proration) and gross to net with the run's one rule set. A correction or
 * one-off run empties the earnings stage and pays only HR's one-off items. ITF follows the
 * period's regular run.
 *
 * The worker is Musa Ibrahim from fixtures/october-2026-golden.json (₦120,000 a month, split
 * ₦60,000 / ₦36,000 / ₦24,000, rent ₦360,000 a year) in the October 2026 cycle (Sunday 20 Sep
 * to Monday 19 Oct, 21 Monday-to-Friday days).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, sumKobo, type Kobo } from "@/lib/money";
import { computeEarnings, POLICY_DEFAULTS, type EarningsWorker } from "@/lib/payroll/earnings";
import type { MonthToDate } from "@/lib/payroll/contract";
import { adjustmentsOnlyEarnings, correctionEarnings, offCycleItf } from "@/lib/payroll/off-cycle";
import { hasPersonalNumber } from "@/lib/personal-number";
import { salaryNarration } from "@/server/payroll/bank-formats";
import { workerPayslip, type RunAdjustment } from "@/lib/payroll/run";
import {
  OFF_CYCLE_REASONS,
  isOffCycleReason,
  offCyclePaysFullPeriod,
  runTitle,
} from "@/lib/payroll/run-format";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import { payslipNotice } from "@/server/payroll/payslip-documents";

const OCT = { start: "2026-09-20", end: "2026-10-19" };
const kobo = (naira: number): Kobo => parseNairaToKobo(String(naira));
const musa = golden.workers.find((w) => w.name === "Musa Ibrahim")!;

function worker(over: Partial<EarningsWorker> = {}): EarningsWorker {
  const [basic, housing, transport] = allocateKobo(kobo(musa.gross), [5n, 3n, 2n]);
  return {
    workerId: randomUUID(),
    employmentType: "permanent",
    startDate: "2025-01-06",
    endDate: null,
    usualWorkDays: null,
    payRates: [
      {
        id: randomUUID(),
        payType: "monthly",
        basic: basic!,
        housing: housing!,
        transport: transport!,
        otherAllowances: 0n,
        dailyRate: 0n,
        hourlyRate: 0n,
        effectiveFrom: "2025-01-01",
        effectiveTo: null,
      },
    ],
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

function earnings(w: EarningsWorker) {
  return computeEarnings(
    { period: OCT, holidays: [], defaultWorkDays: [1, 2, 3, 4, 5], worker: w },
    {
      standardShiftMinutes: 480,
      hourlyRateDivisorDays: 20,
      workDaysPerWeek: 5,
      ...POLICY_DEFAULTS,
    },
  );
}

function payslip(
  e: ReturnType<typeof earnings>,
  adjustments: RunAdjustment[] = [],
  itfApplies = true,
) {
  return workerPayslip(
    {
      employmentType: "permanent",
      earnings: e,
      adjustments,
      nhfOptIn: false,
      annualRentKobo: kobo(musa.annual_rent),
      carriedDeductionKobo: 0n,
    },
    NTA_2025_V1,
    { itfApplies, ruleSetId: "rule-set" },
  );
}

function oneOff(workerId: string, amountKobo: Kobo, kind: "earning" | "deduction" = "earning") {
  return {
    id: randomUUID(),
    workerId,
    kind,
    label: kind === "earning" ? "Leave encashment" : "Salary advance",
    amountKobo,
    pensionable: false,
    taxable: kind === "earning",
    instalmentNumber: 1,
    instalmentCount: 1,
  } satisfies RunAdjustment;
}

describe("off-cycle final pay (the same engine as a regular run)", () => {
  it("reproduces the golden figures for the full cycle, so the off-cycle path changes nothing", () => {
    const slip = payslip(earnings(worker()));
    expect(slip.grossKobo).toBe(kobo(musa.gross));
    expect(slip.payeKobo).toBe(kobo(musa.paye));
    expect(slip.pensionEmployeeKobo).toBe(kobo(musa.pension_employee));
    expect(slip.netKobo).toBe(kobo(musa.net));
  });

  it("prorates a leaver on Monday 5 Oct to 11 of 21 rostered days, rounded once", () => {
    const e = earnings(worker({ endDate: "2026-10-05" }));
    expect(e.days).toMatchObject({ rostered: 21, employedRostered: 11 });
    // ₦120,000 × 11 ÷ 21 = ₦62,857.142857…, rounded half up once to ₦62,857.14.
    expect(sumKobo(e.lines.map((l) => l.amountKobo))).toBe(6_285_714n);

    const slip = payslip(e);
    expect(slip.grossKobo).toBe(6_285_714n);
    // Pension 8% of ₦62,857.14 = ₦5,028.5712, rounded once to ₦5,028.57.
    expect(slip.pensionEmployeeKobo).toBe(502_857n);
    // Annualised taxable (12 × (₦62,857.14 − ₦5,028.57) − ₦72,000 rent relief) is under the
    // ₦800,000 nil band, so PAYE is ₦0 (the engine's annualised method, RULES_NIGERIA PAYE).
    expect(slip.payeKobo).toBe(0n);
    expect(slip.netKobo).toBe(6_285_714n - 502_857n);
    // Employer pension 10%, NSITF 1% and ITF 1%, each rounded once.
    expect(slip.pensionEmployerKobo).toBe(628_571n);
    expect(slip.nsitfKobo).toBe(62_857n);
    expect(slip.itfKobo).toBe(62_857n);
    expect(slip.employerCostKobo).toBe(6_285_714n + 628_571n + 62_857n + 62_857n);
  });

  it("adds a manual one-off earning (leave encashment) to the final pay, taxed and not pensionable", () => {
    const w = worker({ endDate: "2026-10-05" });
    const e = earnings(w);
    const slip = payslip(e, [oneOff(w.workerId, 4_000_000n)]);
    expect(slip.grossKobo).toBe(6_285_714n + 4_000_000n);
    // Not pensionable: pension stays on the prorated salary.
    expect(slip.pensionEmployeeKobo).toBe(502_857n);
    const line = slip.lines.find((l) => l.code === "adjustment_earning");
    expect(line?.amountKobo).toBe(4_000_000n);
    expect(slip.netKobo).toBe(
      slip.grossKobo - slip.payeKobo - slip.pensionEmployeeKobo - slip.nhfKobo,
    );
  });
});

describe("correction and one-off runs (adjustments only)", () => {
  it("empties the earnings stage: no salary, timesheet or leave line and no pay version", () => {
    const e = adjustmentsOnlyEarnings(earnings(worker()));
    expect(e.lines).toEqual([]);
    expect(e.payRateIds).toEqual([]);
    expect(e.flags).toEqual([]);
    expect(e.days).toMatchObject({ cycle: 30, rostered: 21, leaveDeducted: 0 });
    expect(e.trace.map((t) => t.step)).toEqual(["off_cycle"]);
  });

  it("pays only the one-off item, every source an adjustment", () => {
    const w = worker();
    const bonus = oneOff(w.workerId, 5_000_000n);
    const slip = payslip(adjustmentsOnlyEarnings(earnings(w)), [bonus], false);
    expect(slip.grossKobo).toBe(5_000_000n);
    expect(slip.pensionEmployeeKobo).toBe(0n);
    const sources = slip.lines.flatMap((l) => l.sources);
    expect(sources.every((s) => s.kind === "adjustment" && s.id === bonus.id)).toBe(true);
    expect(slip.itfKobo).toBe(0n);
    expect(slip.nsitfKobo).toBe(50_000n);
  });

  it("carries a deduction larger than the payment forward, which the run then blocks", () => {
    const w = worker();
    const slip = payslip(
      adjustmentsOnlyEarnings(earnings(w)),
      [oneOff(w.workerId, 1_000_000n), oneOff(w.workerId, 3_000_000n, "deduction")],
      false,
    );
    expect(slip.netKobo).toBe(0n);
    expect(slip.carriedForwardKobo).toBeGreaterThan(0n);
  });
});

describe("ITF on an off-cycle run", () => {
  const runs = [
    { periodStart: "2026-08-20", itfApplies: false, calculated: true },
    { periodStart: "2026-09-20", itfApplies: true, calculated: true },
    { periodStart: "2026-10-20", itfApplies: false, calculated: false },
  ];

  it("follows the regular run of the same period once it is worked out", () => {
    expect(offCycleItf(runs, "2026-09-20", false)).toEqual({
      itfApplies: true,
      fromPeriod: "2026-09-20",
    });
  });

  it("falls back to the latest regular run worked out before it", () => {
    expect(offCycleItf(runs, "2026-10-20", false)).toEqual({
      itfApplies: true,
      fromPeriod: "2026-09-20",
    });
  });

  it("uses the run's own count when no regular run is worked out", () => {
    expect(offCycleItf([], "2026-10-20", true)).toEqual({ itfApplies: true, fromPeriod: null });
  });
});

describe("off-cycle reasons and names", () => {
  it("pays the full period only for a final pay or a missed worker", () => {
    expect(offCyclePaysFullPeriod("final_pay")).toBe(true);
    expect(offCyclePaysFullPeriod("missed_worker")).toBe(true);
    expect(offCyclePaysFullPeriod("correction")).toBe(false);
    expect(offCyclePaysFullPeriod("one_off")).toBe(false);
    expect(offCyclePaysFullPeriod(null)).toBe(false);
    expect(isOffCycleReason("bonus")).toBe(false);
    expect(Object.keys(OFF_CYCLE_REASONS).sort()).toEqual(
      ["correction", "final_pay", "missed_worker", "one_off"].sort(),
    );
  });

  it("names the run by its month and reason", () => {
    expect(
      runTitle({ kind: "off_cycle", periodEnd: "2026-10-19", offCycleReason: "final_pay" }),
    ).toBe("October 2026 off-cycle: Final pay for a leaver");
    expect(runTitle({ kind: "regular", periodEnd: "2026-10-19", offCycleReason: null })).toBe(
      "October 2026",
    );
  });
});

describe("the worker's notice", () => {
  it("names an off-cycle payslip, with no amounts", () => {
    const notice = payslipNotice("October 2026", "2026-10-16", true);
    expect(notice.title).toBe("Your October 2026 off-cycle payslip is ready");
    expect(notice.body).toContain("off-cycle payslip for October 2026 (pay date 16 Oct 2026)");
    expect(`${notice.title} ${notice.body}`).not.toMatch(/₦|NGN|kobo/);
  });
});

describe("month-aggregate PAYE (owner decision, 24 Nov 2026)", () => {
  // ₦300,000 a month (₦150,000 / ₦90,000 / ₦60,000), no rent declared: pension ₦24,000; annual
  // taxable ₦3,312,000; tax ₦330,000 + 18% of ₦312,000 = ₦386,160; PAYE ₦32,180 a month.
  const regularGross = 30_000_000n;

  function regularSlip(monthToDate?: MonthToDate) {
    const w = worker({
      payRates: [
        {
          id: randomUUID(),
          payType: "monthly",
          ...(() => {
            const [basic, housing, transport] = allocateKobo(regularGross, [5n, 3n, 2n]);
            return { basic: basic!, housing: housing!, transport: transport! };
          })(),
          otherAllowances: 0n,
          dailyRate: 0n,
          hourlyRate: 0n,
          effectiveFrom: "2025-01-01",
          effectiveTo: null,
        },
      ],
    });
    return slipWith(earnings(w), [], monthToDate);
  }

  function oneOffSlip(amountKobo: Kobo, monthToDate?: MonthToDate) {
    const w = worker();
    return slipWith(
      adjustmentsOnlyEarnings(earnings(w)),
      [oneOff(w.workerId, amountKobo)],
      monthToDate,
    );
  }

  function slipWith(
    e: ReturnType<typeof earnings>,
    adj: RunAdjustment[],
    monthToDate?: MonthToDate,
  ) {
    return workerPayslip(
      {
        employmentType: "permanent",
        earnings: e,
        adjustments: adj,
        nhfOptIn: false,
        annualRentKobo: 0n,
        carriedDeductionKobo: 0n,
        ...(monthToDate ? { monthToDate } : {}),
      },
      NTA_2025_V1,
      { itfApplies: false, ruleSetId: "rule-set" },
    );
  }

  const asEarlier = (slip: ReturnType<typeof regularSlip>): MonthToDate => ({
    payslips: 1,
    taxableKobo:
      sumKobo(
        slip.lines.filter((l) => l.kind === "earning" && l.taxable).map((l) => l.amountKobo),
      ) -
      slip.pensionEmployeeKobo -
      slip.nhfKobo,
    payeKobo: slip.payeKobo,
  });

  it("withholds the marginal band on a ₦60,000 one-off paid after ₦300,000 of salary", () => {
    const regular = regularSlip();
    expect(regular.payeKobo).toBe(3_218_000n);
    // Alone it would be ₦720,000 a year, under the nil band: ₦0.
    expect(oneOffSlip(6_000_000n).payeKobo).toBe(0n);
    // On the month's total (₦336,000 a month, ₦4,032,000 a year): ₦42,980 for the month, of
    // which ₦32,180 is already withheld: ₦10,800, 18% of ₦60,000.
    const bonus = oneOffSlip(6_000_000n, asEarlier(regular));
    expect(bonus.payeKobo).toBe(1_080_000n);
    const steps = bonus.trace.map((t) => t.step);
    expect(steps).toEqual(expect.arrayContaining(["month_to_date", "paye_month", "paye_earlier"]));
    expect(bonus.trace.find((t) => t.step === "paye_month")?.valueKobo).toBe(4_298_000n);
    expect(bonus.trace.find((t) => t.step === "paye_earlier")?.valueKobo).toBe(3_218_000n);
  });

  it("taxes a ₦2,000,000 gratuity on the month's total", () => {
    // ₦2,276,000 a month, ₦27,312,000 a year: ₦330,000 + ₦1,620,000 + ₦2,730,000 + 23% of
    // ₦2,312,000 (₦531,760) = ₦5,211,760; ÷ 12 = ₦434,313.33; less ₦32,180 withheld.
    const gratuity = oneOffSlip(200_000_000n, asEarlier(regularSlip()));
    expect(gratuity.payeKobo).toBe(43_431_333n - 3_218_000n);
  });

  it("gives the month the same PAYE whichever payslip posts first", () => {
    const regularFirst = regularSlip();
    const bonusSecond = oneOffSlip(6_000_000n, asEarlier(regularFirst));
    const bonusFirst = oneOffSlip(6_000_000n);
    const regularSecond = regularSlip(asEarlier(bonusFirst));
    expect(regularFirst.payeKobo + bonusSecond.payeKobo).toBe(4_298_000n);
    expect(bonusFirst.payeKobo + regularSecond.payeKobo).toBe(4_298_000n);
  });

  it("never withholds below ₦0", () => {
    const slip = oneOffSlip(100_000n, { payslips: 1, taxableKobo: 0n, payeKobo: 5_000_000n });
    expect(slip.payeKobo).toBe(0n);
  });
});

describe("correction runs and narration", () => {
  it("keeps timesheet and leave lines and drops salary", () => {
    const w = worker({
      lines: [
        {
          id: randomUUID(),
          workDate: "2026-10-01",
          workedMinutes: 480,
          otMinutes: 60,
          hasShift: true,
          projectId: null,
        },
      ],
    });
    const e = correctionEarnings(earnings(w));
    expect(e.lines.map((l) => l.code)).toEqual(["overtime"]);
    expect(e.lines.every((l) => l.sources.every((s) => s.kind === "timesheet_line"))).toBe(true);
  });

  it("names an off-cycle bank payment", () => {
    expect(salaryNarration("2026-10-19", "MLS-0001", true)).toBe("Off-cycle Oct 2026 MLS-0001");
    expect(salaryNarration("2026-10-19", "MLS-0001")).toBe("Salary Oct 2026 MLS-0001");
  });
});

describe("personal numbers in free text (security review M1)", () => {
  it.each([
    ["1234567890", true],
    ["12345-67890", true],
    ["0123 456 789", true],
    ["PEN123456789012", true],
    ["pen 1234 5678 9012", true],
    ["123456789", false],
    ["Award for 10 years, 2026", false],
    ["Acting supervisor at Lekki, October", false],
  ])("%s → %s", (text, expected) => {
    expect(hasPersonalNumber(text)).toBe(expected);
  });
});
