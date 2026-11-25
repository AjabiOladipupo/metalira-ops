/**
 * Slice 5.10: the Phase 5 round-2 fix-up (money and security reviews, 25 Nov 2026; the owner's
 * decisions of the same day).
 *
 * - H1: a same-year clawback counts inside the one-third cap (Labour Act s.5(7)) with the
 *   carried deduction and other deductions; the cap is a third of gross before recoveries; what
 *   doesn't fit carries after tax. Late-approved leave arrears stay outside the cap.
 * - M2: without an opening balance, months elapsed count from the worker's first in-app payslip,
 *   not the company's go-live month, with a warning. The golden fixture stays exact (m = 1).
 * - M3: a leaver's carry raises "₦X can't be recovered through payroll: the worker is leaving".
 * - L4: only an adjustment HR marked a recurring allowance is regular pay (NSITF's base).
 * - L6: a correction or one-off run's carry blocks with why and what to do.
 * - M1: the leave-in-lieu pre-fill names days already on another final-pay run.
 * - Security L6: an NHF number in the reason is refused, however it is punctuated.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, type Kobo } from "@/lib/money";
import { describeAnomaly } from "@/lib/payroll/anomaly-text";
import type { EarningLine, PayslipResult } from "@/lib/payroll/contract";
import { leavePrefillText } from "@/lib/payroll/final-pay";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import { NTA_2025_V1, NTA_2025_V2 } from "@/lib/payroll/rule-set";
import {
  adjustmentLines,
  carryBlockDetail,
  workerAnomalies,
  type RunAdjustment,
} from "@/lib/payroll/run";
import { yearToDateFor } from "@/lib/payroll/ytd";
import { nhfNumberSchema, reasonHoldsNumber } from "@/server/payroll/tax-records";

const V2 = NTA_2025_V2;
const naira = (n: number): Kobo => parseNairaToKobo(String(n));
const REGULAR = naira(300_000);

function salary(grossKobo: Kobo, extra: EarningLine[] = []): EarningLine[] {
  const [basic, housing, transport] = allocateKobo(grossKobo, [5n, 3n, 2n]);
  const line = (code: "basic" | "housing" | "transport", amount: Kobo): EarningLine => ({
    code,
    label: code,
    amountKobo: amount,
    pensionable: true,
    nhfBase: code === "basic",
    taxable: true,
    sources: [],
  });
  return [
    line("basic", basic!),
    line("housing", housing!),
    line("transport", transport!),
    ...extra,
  ];
}

function slip(
  earnings: EarningLine[],
  o: { deductions?: Kobo[]; carried?: Kobo; rules?: typeof V2; rent?: Kobo } = {},
): PayslipResult {
  return grossToNet(
    {
      employmentType: "permanent",
      earnings,
      nhfOptIn: false,
      annualRentKobo: o.rent ?? 0n,
      deductions: (o.deductions ?? []).map((amountKobo, i) => ({
        label: `Loan ${i + 1}`,
        amountKobo,
        sources: [{ kind: "adjustment", id: randomUUID() }],
      })),
      carriedDeductionKobo: o.carried ?? 0n,
    },
    o.rules ?? V2,
    { itfApplies: true },
  );
}

const correction = (amount: Kobo, over: Partial<RunAdjustment> = {}): RunAdjustment => ({
  id: randomUUID(),
  workerId: randomUUID(),
  kind: "deduction",
  label: "Overpaid salary, September",
  amountKobo: amount,
  pensionable: false,
  taxable: false,
  instalmentNumber: 1,
  instalmentCount: 1,
  correctsPayslipId: randomUUID(),
  preTax: true,
  preTaxCapKobo: naira(300_000),
  ...over,
});

const clawbackOf = (s: PayslipResult) => s.lines.find((l) => l.code === "clawback")?.amountKobo;

describe("H1: a clawback counts inside the one-third cap (owner decision, 25 Nov 2026)", () => {
  it("recovers at most ₦100,000 of a ₦300,000 overpayment on a ₦300,000 salary and carries the rest", () => {
    const { earnings } = adjustmentLines([correction(naira(300_000))]);
    const s = slip(salary(REGULAR, earnings));
    expect(clawbackOf(s)).toBe(-naira(100_000));
    expect(s.grossKobo).toBe(naira(200_000));
    expect(s.carriedForwardKobo).toBe(naira(200_000));
    expect(s.flags).toEqual(expect.arrayContaining(["deduction_capped", "recovery_carried"]));
    // PAYE, pension and NHF still come off in full.
    expect(s.pensionEmployeeKobo).toBe(naira(24_000));
    expect(s.netKobo).toBe(s.grossKobo - s.payeKobo - s.pensionEmployeeKobo - s.nhfKobo);
    const cap = s.trace.find((t) => t.step === "deduction_cap")!;
    expect(cap.valueKobo).toBe(naira(100_000));
    expect(cap.inputs.gross_before_recoveries_kobo).toBe(naira(300_000).toString());
  });

  it("shares the cap with after-tax deductions: the clawback first, then a loan", () => {
    const { earnings } = adjustmentLines([correction(naira(60_000))]);
    const s = slip(salary(REGULAR, earnings), { deductions: [naira(60_000)] });
    expect(clawbackOf(s)).toBe(-naira(60_000));
    expect(s.otherDeductionsKobo).toBe(naira(40_000));
    expect(s.carriedForwardKobo).toBe(naira(20_000));
    expect(s.flags).toContain("deduction_capped");
    expect(s.flags).not.toContain("recovery_carried");
  });

  it("shares it with a carried deduction too", () => {
    const { earnings } = adjustmentLines([correction(naira(80_000))]);
    const s = slip(salary(REGULAR, earnings), { carried: naira(50_000) });
    expect(clawbackOf(s)).toBe(-naira(80_000));
    expect(s.otherDeductionsKobo).toBe(naira(20_000));
    expect(s.carriedForwardKobo).toBe(naira(30_000));
  });

  it("leaves late-approved leave arrears outside the cap (a reduction of earned wages)", () => {
    const arrears: EarningLine = {
      code: "leave_deduction",
      label: "Unpaid leave, September, approved after posting",
      amountKobo: -naira(150_000),
      pensionable: true,
      nhfBase: true,
      taxable: true,
      sources: [],
      recovery: true,
    };
    const s = slip(salary(REGULAR, [arrears]), { deductions: [naira(100_000)] });
    // The whole ₦150,000 comes off before tax, and the loan still has the full ₦100,000 cap
    // (a third of the ₦300,000 gross before recoveries).
    expect(s.lines.find((l) => l.code === "leave_deduction")?.amountKobo).toBe(-naira(150_000));
    expect(s.otherDeductionsKobo).toBe(naira(100_000));
    expect(s.carriedForwardKobo).toBe(0n);
    expect(s.flags).not.toContain("deduction_capped");
  });

  it("doesn't cap a clawback under NTA 2025 v1 (no adviser rules)", () => {
    const { earnings } = adjustmentLines([correction(naira(150_000))]);
    const s = slip(salary(REGULAR, earnings), { rules: NTA_2025_V1 });
    expect(clawbackOf(s)).toBe(-naira(150_000));
    expect(s.flags).not.toContain("deduction_capped");
  });

  it("takes nothing before tax once earlier corrections used the corrected payslip's taxable pay (L3)", () => {
    // The server passes what is left of the cap after earlier clawbacks of the same payslip.
    const { earnings } = adjustmentLines([correction(naira(20_000), { preTaxCapKobo: 0n })]);
    const s = slip(salary(REGULAR, earnings));
    expect(clawbackOf(s)).toBe(0n);
    expect(s.carriedForwardKobo).toBe(naira(20_000));
  });
});

describe("leave arrears and shared clawback caps (money review round 2)", () => {
  it("keeps prior-year leave arrears outside the cap: ₦90,000 arrears and a ₦50,000 loan both come off", () => {
    const s = grossToNet(
      {
        employmentType: "permanent",
        earnings: salary(REGULAR),
        nhfOptIn: false,
        annualRentKobo: 0n,
        deductions: [
          {
            code: "leave_arrears",
            label: "Unpaid leave, December 2025, recovered after tax",
            amountKobo: naira(90_000),
            sources: [],
          },
          { label: "Loan", amountKobo: naira(50_000), sources: [] },
        ],
        carriedDeductionKobo: 0n,
      },
      V2,
      { itfApplies: true },
    );
    expect(s.otherDeductionsKobo).toBe(naira(140_000));
    expect(s.carriedForwardKobo).toBe(0n);
    expect(s.flags).not.toContain("deduction_capped");
  });

  it("shares the corrected payslip's taxable pay between two clawbacks of it, by what each took (L3)", () => {
    const payslipId = "00000000-0000-4000-8000-0000000000aa";
    const { earnings } = adjustmentLines([
      correction(naira(30_000), { correctsPayslipId: payslipId, preTaxCapKobo: naira(40_000) }),
      correction(naira(30_000), { correctsPayslipId: payslipId, preTaxCapKobo: naira(40_000) }),
    ]);
    const s = slip(salary(REGULAR, earnings));
    const claws = s.lines.filter((l) => l.code === "clawback").map((l) => l.amountKobo);
    expect(claws).toEqual([-naira(30_000), -naira(10_000)]);
    expect(s.carriedForwardKobo).toBe(naira(20_000));
    const step = s.trace.find((t) => t.step === "recovery_carried")!;
    expect(step.inputs.limit).toBe("corrected_taxable");
  });
});

describe("M2: months elapsed from the worker's first payslip in Metalira", () => {
  it("counts a November first payslip as one month, though the worker started years before", () => {
    const nov = yearToDateFor({
      payDate: "2026-11-25",
      startDate: "2024-03-01",
      firstPayMonth: null,
      worker: null,
      slips: [],
    });
    expect(nov).toMatchObject({ monthsElapsed: 1, fromMonth: "2026-11", fromFirstPayslip: true });
    const dec = yearToDateFor({
      payDate: "2026-12-24",
      startDate: "2024-03-01",
      firstPayMonth: "2026-11-01",
      worker: null,
      slips: [
        {
          payslipId: "nov",
          payDate: "2026-11-25",
          grossKobo: REGULAR,
          chargeableKobo: naira(276_000),
          payeKobo: naira(32_180),
        },
      ],
    });
    expect(dec).toMatchObject({ monthsElapsed: 2, fromMonth: "2026-11", payslips: 1 });
    // Warned once, on the first payslip of the year.
    expect(dec.fromFirstPayslip).toBeUndefined();
  });

  it("doesn't warn for a joiner whose first payslip is their first month, nor with an opening balance", () => {
    const joiner = yearToDateFor({
      payDate: "2026-10-25",
      startDate: "2026-10-01",
      firstPayMonth: null,
      worker: null,
      slips: [],
    });
    expect(joiner).toMatchObject({ monthsElapsed: 1, fromMonth: "2026-10" });
    expect(joiner.fromFirstPayslip).toBeUndefined();
    const opened = yearToDateFor({
      payDate: "2026-10-25",
      startDate: "2024-03-01",
      firstPayMonth: null,
      worker: {
        hasNhfNumber: false,
        rentDeclaredKobo: 0n,
        firstPayMonth: null,
        opening: {
          id: randomUUID(),
          asOfMonth: "2026-09",
          grossKobo: 0n,
          chargeableKobo: 0n,
          payeKobo: 0n,
          pensionKobo: 0n,
        },
        reliefs: [],
      },
      slips: [],
    });
    expect(opened).toMatchObject({ monthsElapsed: 10, fromMonth: "2026-01" });
    expect(opened.fromFirstPayslip).toBeUndefined();
  });

  it("raises the no-opening-balance warning with the exact words", () => {
    expect(describeAnomaly("no_opening_balance", {}, "Musa Ibrahim").title).toBe(
      "No opening balance: year to date starts at this worker's first payslip in Metalira · Musa Ibrahim",
    );
  });

  it("keeps the golden fixture exact: October is the first payslip, so m = 1", () => {
    // The golden workers started on 6 Jan 2025 and October 2026 is their first payroll in the
    // app, with no opening balance: one month from October, the month annualised.
    const ytd = yearToDateFor({
      payDate: "2026-10-25",
      startDate: "2025-01-06",
      firstPayMonth: null,
      worker: null,
      slips: [],
    });
    expect(ytd).toMatchObject({ monthsElapsed: 1, fromMonth: "2026-10", payslips: 0 });
    for (const w of golden.workers) {
      const s = grossToNet(
        {
          employmentType: "permanent",
          earnings: salary(naira(w.gross)),
          nhfOptIn: false,
          annualRentKobo: naira(w.annual_rent),
          deductions: [],
          carriedDeductionKobo: 0n,
        },
        V2,
        { itfApplies: true, yearToDate: ytd },
      );
      expect(s.payeKobo).toBe(naira(w.paye));
      expect(s.pensionEmployeeKobo).toBe(naira(w.pension_employee));
      expect(s.netKobo).toBe(naira(w.net));
      expect(s.employerCostKobo).toBe(naira(w.employer_cost));
    }
  });
});

describe("M3: a leaver's carry can't be recovered through payroll", () => {
  const base = {
    workerId: randomUUID(),
    employmentType: "permanent" as const,
    startDate: "2025-01-06",
    period: { start: "2026-09-20", end: "2026-10-19" },
    taxState: "Lagos",
    pfaName: "Stanbic IBTC Pension",
    hasRsaPin: true,
    earningsFlags: [],
    noShowDates: [],
    bank: null,
    previousNetKobo: null,
    paidBefore: true,
    rules: V2,
  };

  it("warns with the amount on a leaver's payslip that carries", () => {
    const { earnings } = adjustmentLines([correction(naira(300_000))]);
    const payslip = slip(salary(REGULAR, earnings));
    const out = workerAnomalies({ ...base, endDate: "2026-10-10", payslip });
    const a = out.find((x) => x.code === "leaver_carry_unrecoverable")!;
    expect(a).toMatchObject({ severity: "warning", detail: { naira: "200,000", kobo: 0 } });
    const carried = out.find((x) => x.code === "recovery_carried")!;
    expect(carried.detail).toEqual({ capped: true });
    expect(describeAnomaly(carried.code, carried.detail, "Ada Obi").title).toBe(
      "Clawback over the one-third cap · Ada Obi",
    );
    expect(describeAnomaly(a.code, a.detail, "Ada Obi").title).toBe(
      "₦200,000.00 can't be recovered through payroll: the worker is leaving · Ada Obi",
    );
  });

  it("doesn't warn for a worker who stays", () => {
    const { earnings } = adjustmentLines([correction(naira(300_000))]);
    const payslip = slip(salary(REGULAR, earnings));
    const out = workerAnomalies({ ...base, endDate: null, payslip });
    expect(out.map((x) => x.code)).not.toContain("leaver_carry_unrecoverable");
  });
});

describe("L4: only a recurring allowance HR marked is regular pay", () => {
  const earning = (over: Partial<RunAdjustment>): RunAdjustment => ({
    id: randomUUID(),
    workerId: randomUUID(),
    kind: "earning",
    label: "Bonus",
    amountKobo: naira(30_000),
    pensionable: false,
    taxable: true,
    instalmentNumber: 1,
    instalmentCount: 3,
    ...over,
  });

  it("leaves a bonus paid in instalments out of NSITF's base", () => {
    const { earnings } = adjustmentLines([earning({})]);
    const s = slip(salary(REGULAR, earnings));
    expect(s.nsitfKobo).toBe(naira(3_000));
    expect(s.lines.find((l) => l.code === "adjustment_earning")?.regular).toBe(false);
  });

  it("counts an allowance marked regular", () => {
    const { earnings } = adjustmentLines([earning({ label: "Site allowance", regular: true })]);
    const s = slip(salary(REGULAR, earnings));
    expect(s.nsitfKobo).toBe(naira(3_300));
  });
});

describe("L6: a correction or one-off run's carry blocks with why and what to do", () => {
  it("names the cap", () => {
    const t = describeAnomaly("calculation_failed", { deduction_cut: true, capped: true }, "Ada");
    expect(t.title).toBe("Deduction can't carry from this run · Ada");
    expect(t.body).toContain("Labour Act s.5(7)");
    expect(t.body).toContain("next regular run");
  });

  it("says why from the payslip: the corrected payslip's taxable pay", () => {
    const { earnings } = adjustmentLines([correction(naira(20_000), { preTaxCapKobo: 0n })]);
    const detail = carryBlockDetail(slip(salary(REGULAR, earnings)));
    expect(detail).toMatchObject({ deduction_cut: true, clawback: true, taxable_limit: true });
    expect(describeAnomaly("calculation_failed", detail, "Ada").body).toContain(
      "corrected payslip's taxable pay",
    );
  });

  it("says to move it to the next regular run when the cap base is ₦0", () => {
    const t = describeAnomaly(
      "calculation_failed",
      { deduction_cut: true, capped: true, no_cap_base: true },
      "Ada",
    );
    expect(t.body).toContain("move it to the next regular run");
  });

  it("names the clawback", () => {
    const t = describeAnomaly("calculation_failed", { deduction_cut: true, clawback: true }, "Ada");
    expect(t.body).toContain("clawback is more than this run's pay");
  });
});

describe("M1: the leave-in-lieu pre-fill shows days already on another final-pay run", () => {
  it("says what came off", () => {
    expect(
      leavePrefillText({
        entitlementDays: 15,
        monthsInYear: 9,
        takenDays: 3,
        serviceMonths: 30,
        paidElsewhereDays: 4,
        days: 4,
        year: 2026,
      }),
    ).toBe(
      "15 days a year × 9 of 12 months, rounded down, less 3 taken in 2026 and 4 already on another final-pay run = 4 days.",
    );
  });
});

describe("security L6: the NHF number never goes into the reason", () => {
  it("finds the number however it is punctuated", () => {
    expect(reasonHoldsNumber("New number NHF-12/345, from the fund", "NHF12345")).toBe(true);
    expect(reasonHoldsNumber("Number nhf 12 345 given by the worker", "NHF/12345")).toBe(true);
    expect(reasonHoldsNumber("Worker joined the scheme", "NHF12345")).toBe(false);
  });

  it("refuses it at the boundary", () => {
    const workerId = randomUUID();
    const bad = nhfNumberSchema.safeParse({
      workerId,
      nhfNumber: "NHF12345",
      reason: "Saved NHF 12345 from the card",
    });
    expect(bad.success).toBe(false);
    const ok = nhfNumberSchema.safeParse({
      workerId,
      nhfNumber: "NHF12345",
      reason: "From the worker's NHF card",
    });
    expect(ok.success).toBe(true);
  });
});
