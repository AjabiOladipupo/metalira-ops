/**
 * Slice 5.9c: leavers' final-pay items (adviser answer 19) and the company's public-holiday pay
 * multiplier (adviser answer 24, owner decision).
 * - Pay in lieu of untaken leave is untaken days × the basic daily rate (basic ÷ 20), basic only.
 * - Redundancy (loss of office) is exempt up to ₦50,000,000 a worker, across payments; only the
 *   excess is taxed; nothing is pensionable.
 * - Holiday work is paid at the overtime rate × the multiplier: 1.0× is today's rule, 1.5× pays
 *   half as much again; the golden fixture is unchanged at the default.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, sumKobo, type Kobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/contract";
import {
  computeEarnings,
  holidayMultiplierOn,
  POLICY_DEFAULTS,
  type EarningsWorker,
  type PayPolicy,
} from "@/lib/payroll/earnings";
import {
  basicDaysAmount,
  finalPayLabel,
  FINAL_PAY_ITEMS,
  LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO,
  lossOfOfficeSplit,
  planFinalPayItem,
  serviceMonths,
  type FinalPayPrefill,
} from "@/lib/payroll/final-pay";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import type { PayRateInput } from "@/lib/payroll/inputs";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";

const naira = (n: string): Kobo => parseNairaToKobo(n);

const PREFILL: FinalPayPrefill = {
  workerId: randomUUID(),
  startDate: "2025-01-06",
  endDate: "2026-10-05",
  basicMonthlyKobo: naira("60,000"),
  divisorDays: 20,
  annualBalanceDays: 6,
  exemptCapKobo: LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO,
  exemptUsedKobo: 0n,
};

describe("pay in lieu of untaken leave", () => {
  it("is untaken days × basic ÷ 20, on basic only", () => {
    // Musa Ibrahim: ₦60,000 basic of ₦120,000 gross; 6 days × ₦3,000 = ₦18,000.
    expect(basicDaysAmount(6, naira("60,000"), 20)).toBe(naira("18,000"));
    const plan = planFinalPayItem(PREFILL, {
      type: "leave_in_lieu",
      days: 6,
      amountKobo: naira("18,000"),
      partOfSettlement: false,
    });
    expect(plan.computedKobo).toBe(naira("18,000"));
    expect(plan.needsChangeReason).toBe(false);
    expect(plan.lines).toEqual([
      {
        label: "Pay in lieu of untaken leave, 6 days",
        amountKobo: naira("18,000"),
        taxable: true,
        pensionable: false,
      },
    ]);
    expect(plan.belowLeaveService).toBe(false);
  });

  it("rounds half up once", () => {
    // 7 × ₦60,000.10 ÷ 20 = ₦21,000.035 → ₦21,000.04.
    expect(basicDaysAmount(7, 6_000_010n, 20)).toBe(2_100_004n);
    expect(basicDaysAmount(1, 30n, 20)).toBe(2n); // 1.5 kobo → 2
  });

  it("needs a reason when the days or amount differ from the pre-fill", () => {
    const fewer = planFinalPayItem(PREFILL, {
      type: "leave_in_lieu",
      days: 4,
      amountKobo: naira("12,000"),
      partOfSettlement: false,
    });
    expect(fewer.computedKobo).toBe(naira("12,000"));
    expect(fewer.needsChangeReason).toBe(true);
    const more = planFinalPayItem(PREFILL, {
      type: "leave_in_lieu",
      days: 6,
      amountKobo: naira("20,000"),
      partOfSettlement: false,
    });
    expect(more.needsChangeReason).toBe(true);
  });

  it("isn't owed by law below 6 months' continuous service", () => {
    expect(serviceMonths("2026-05-06", "2026-11-05")).toBe(6);
    expect(serviceMonths("2026-05-06", "2026-11-04")).toBe(5);
    expect(serviceMonths("2025-01-06", "2026-10-05")).toBe(21);
    const plan = planFinalPayItem(
      { ...PREFILL, startDate: "2026-06-01", endDate: "2026-10-05" },
      { type: "leave_in_lieu", days: 6, amountKobo: naira("18,000"), partOfSettlement: false },
    );
    expect(plan.belowLeaveService).toBe(true);
  });

  it("has no pre-fill for a daily or hourly pay rate", () => {
    const plan = planFinalPayItem(
      { ...PREFILL, basicMonthlyKobo: null },
      { type: "notice_in_lieu", days: 5, amountKobo: naira("10,000"), partOfSettlement: false },
    );
    expect(plan.computedKobo).toBeNull();
    expect(plan.needsChangeReason).toBe(true);
  });
});

describe("redundancy and loss-of-office pay", () => {
  it("splits at ₦50,000,000: only the excess is taxable", () => {
    expect(lossOfOfficeSplit(naira("60,000,000"), LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO, 0n)).toEqual({
      exemptKobo: naira("50,000,000"),
      taxableKobo: naira("10,000,000"),
      roomKobo: naira("50,000,000"),
    });
    expect(
      lossOfOfficeSplit(naira("50,000,000"), LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO, 0n).taxableKobo,
    ).toBe(0n);
    expect(
      lossOfOfficeSplit(naira("50,000,000.01"), LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO, 0n).taxableKobo,
    ).toBe(1n);
  });

  it("counts the worker's earlier payments against the cap (the conservative reading)", () => {
    const split = lossOfOfficeSplit(
      naira("30,000,000"),
      LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO,
      naira("30,000,000"),
    );
    expect(split).toMatchObject({
      exemptKobo: naira("20,000,000"),
      taxableKobo: naira("10,000,000"),
    });
    const spent = lossOfOfficeSplit(
      naira("1,000"),
      LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO,
      naira("60,000,000"),
    );
    expect(spent).toMatchObject({ exemptKobo: 0n, taxableKobo: naira("1,000"), roomKobo: 0n });
  });

  it("becomes an exempt line and a taxable line, neither pensionable", () => {
    const plan = planFinalPayItem(PREFILL, {
      type: "loss_of_office",
      days: null,
      amountKobo: naira("60,000,000"),
      partOfSettlement: false,
    });
    expect(plan.lines).toEqual([
      {
        label: "Redundancy or loss-of-office compensation, exempt part",
        amountKobo: naira("50,000,000"),
        taxable: false,
        pensionable: false,
      },
      {
        label: "Redundancy or loss-of-office compensation, taxable part",
        amountKobo: naira("10,000,000"),
        taxable: true,
        pensionable: false,
      },
    ]);
    expect(plan.needsChangeReason).toBe(false);
  });

  it("lets notice pay that is part of the settlement share the exemption", () => {
    const plan = planFinalPayItem(
      { ...PREFILL, exemptUsedKobo: naira("49,990,000") },
      { type: "notice_in_lieu", days: 20, amountKobo: naira("60,000"), partOfSettlement: true },
    );
    expect(plan.computedKobo).toBe(naira("60,000"));
    expect(plan.exemptKobo).toBe(naira("10,000"));
    expect(plan.taxableKobo).toBe(naira("50,000"));
    const plain = planFinalPayItem(PREFILL, {
      type: "notice_in_lieu",
      days: 20,
      amountKobo: naira("60,000"),
      partOfSettlement: false,
    });
    expect(plain.exemptKobo).toBe(0n);
    expect(plain.lines.map((l) => l.taxable)).toEqual([true]);
  });

  it("is taxed only on the excess by the engine, and adds nothing to pension", () => {
    const salary: EarningLine[] = (["basic", "housing", "transport"] as const).map((code, i) => ({
      code,
      label: code,
      amountKobo: [6_000_000n, 3_600_000n, 2_400_000n][i]!,
      pensionable: true,
      nhfBase: code === "basic",
      taxable: true,
      sources: [],
    }));
    const plan = planFinalPayItem(PREFILL, {
      type: "loss_of_office",
      days: null,
      amountKobo: naira("60,000,000"),
      partOfSettlement: false,
    });
    const asLines = (lines: typeof plan.lines): EarningLine[] =>
      lines.map((l) => ({
        code: "adjustment_earning",
        label: l.label,
        amountKobo: l.amountKobo,
        pensionable: l.pensionable,
        nhfBase: false,
        taxable: l.taxable,
        sources: [],
      }));
    const input = (earnings: EarningLine[]) => ({
      employmentType: "permanent" as const,
      earnings,
      nhfOptIn: false,
      annualRentKobo: 0n,
      deductions: [],
      carriedDeductionKobo: 0n,
    });
    const withSplit = grossToNet(input([...salary, ...asLines(plan.lines)]), NTA_2025_V1, {
      itfApplies: false,
    });
    const taxablePartOnly = grossToNet(
      input([...salary, ...asLines(plan.lines.filter((l) => l.taxable))]),
      NTA_2025_V1,
      { itfApplies: false },
    );
    expect(withSplit.grossKobo).toBe(12_000_000n + naira("60,000,000"));
    expect(withSplit.payeKobo).toBe(taxablePartOnly.payeKobo);
    expect(withSplit.pensionEmployeeKobo).toBe(960_000n);
  });

  it("names every item's tax and pension rule", () => {
    for (const rule of Object.values(FINAL_PAY_ITEMS)) expect(rule.pensionable).toBe(false);
    expect(finalPayLabel("notice_in_lieu", 1, "whole")).toBe("Pay in lieu of notice, 1 day");
    expect(finalPayLabel("gratuity", null, "whole")).toBe("Gratuity");
  });
});

// ---------------------------------------------------------------------------
// Public-holiday pay multiplier
// ---------------------------------------------------------------------------

const OCT = { start: "2026-09-20", end: "2026-10-19" };
const POLICY: PayPolicy = {
  standardShiftMinutes: 480,
  hourlyRateDivisorDays: 20,
  workDaysPerWeek: 5,
  ...POLICY_DEFAULTS,
};

function monthly(grossKobo: Kobo = 12_000_000n): PayRateInput {
  const [basic, housing, transport] = allocateKobo(grossKobo, [5n, 3n, 2n]);
  return {
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
  };
}

function worker(over: Partial<EarningsWorker> = {}): EarningsWorker {
  return {
    workerId: randomUUID(),
    employmentType: "permanent",
    startDate: "2025-01-06",
    endDate: null,
    usualWorkDays: null,
    payRates: [monthly()],
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

const line = (workDate: string, workedMinutes: number, otMinutes = 0, hasShift = true) => ({
  id: randomUUID(),
  workDate,
  workedMinutes,
  otMinutes,
  hasShift,
  projectId: null,
});

const holidayPay = (lines: EarningLine[]) =>
  sumKobo(lines.filter((l) => l.code === "public_holiday").map((l) => l.amountKobo));

describe("the public-holiday pay multiplier", () => {
  const w = worker({ lines: [line("2026-10-01", 480, 60)] });
  const earn = (bps?: number) =>
    computeEarnings(
      {
        period: OCT,
        holidays: ["2026-10-01"],
        defaultWorkDays: [1, 2, 3, 4, 5],
        worker: w,
        ...(bps === undefined ? {} : { policyOn: () => ({ holidayMultiplierBps: bps }) }),
      },
      POLICY,
    );

  it("at 1.0× pays every minute worked at the overtime rate, as before", () => {
    // ₦750 an hour = 1,250 kobo a minute; 540 minutes.
    const none = earn();
    const one = earn(10_000);
    expect(holidayPay(none.lines)).toBe(540n * 1_250n);
    expect(one.lines).toEqual(none.lines);
    expect(one.trace).toEqual(none.trace);
  });

  it("at 1.5× pays half as much again, on top of normal pay", () => {
    const r = earn(15_000);
    expect(holidayPay(r.lines)).toBe(540n * 1_875n);
    expect(r.lines.find((l) => l.code === "public_holiday")!.label).toBe(
      "Public holiday work, 9 h at ₦1,125.00 an hour",
    );
    expect(r.trace.find((t) => t.step === "public_holiday")!.inputs).toMatchObject({
      holiday_multiplier_bps: 15_000,
    });
    const salary = sumKobo(
      r.lines
        .filter((l) => ["basic", "housing", "transport"].includes(l.code))
        .map((l) => l.amountKobo),
    );
    expect(salary).toBe(12_000_000n);
  });

  it("uses the multiplier in force on the day worked", () => {
    const versions = [
      { effectiveFrom: "2026-10-02", multiplierBps: 15_000 },
      { effectiveFrom: "2026-12-01", multiplierBps: 20_000 },
    ];
    expect(holidayMultiplierOn(versions, "2026-10-01")).toBe(10_000);
    expect(holidayMultiplierOn(versions, "2026-10-02")).toBe(15_000);
    expect(holidayMultiplierOn(versions, "2026-12-25")).toBe(20_000);
    const r = computeEarnings(
      {
        period: OCT,
        holidays: ["2026-10-01", "2026-10-02"],
        defaultWorkDays: [1, 2, 3, 4, 5],
        worker: worker({ lines: [line("2026-10-01", 480), line("2026-10-02", 480)] }),
        policyOn: (date) => ({ holidayMultiplierBps: holidayMultiplierOn(versions, date) }),
      },
      POLICY,
    );
    expect(
      r.lines
        .filter((l) => l.code === "public_holiday")
        .map((l) => l.amountKobo)
        .sort(),
    ).toEqual([480n * 1_250n, 480n * 1_875n]);
  });

  it("compares values, not minutes, for a holiday on an off day", () => {
    // A no-shift Saturday holiday, 400 minutes: at 1.0× the 8-hour off-day shift is larger; at
    // 1.5× the holiday's 400 × 1.5 = 600 minutes' worth is larger.
    const sat = worker({ lines: [line("2026-10-03", 400, 0, false)] });
    const at = (bps: number) =>
      computeEarnings(
        {
          period: OCT,
          holidays: ["2026-10-03"],
          defaultWorkDays: [1, 2, 3, 4, 5],
          worker: sat,
          policyOn: () => ({ holidayMultiplierBps: bps }),
        },
        POLICY,
      );
    expect(at(10_000).lines.some((l) => l.code === "off_day")).toBe(true);
    expect(holidayPay(at(10_000).lines)).toBe(0n);
    expect(holidayPay(at(15_000).lines)).toBe(400n * 1_875n);
    expect(at(15_000).lines.some((l) => l.code === "off_day")).toBe(false);
  });

  it("leaves the golden fixture unchanged at the default", () => {
    for (const g of golden.workers) {
      const gross = parseNairaToKobo(String(g.gross));
      const w = worker({ payRates: [monthly(gross)] });
      const input = { period: OCT, holidays: [], defaultWorkDays: [1, 2, 3, 4, 5], worker: w };
      const plain = computeEarnings(input, POLICY);
      const atDefault = computeEarnings(
        { ...input, policyOn: () => ({ holidayMultiplierBps: 10_000 }) },
        POLICY,
      );
      expect(atDefault.lines).toEqual(plain.lines);
      const slip = grossToNet(
        {
          employmentType: "permanent",
          earnings: atDefault.lines,
          nhfOptIn: false,
          annualRentKobo: parseNairaToKobo(String(g.annual_rent)),
          deductions: [],
          carriedDeductionKobo: 0n,
        },
        NTA_2025_V1,
        { itfApplies: true },
      );
      expect(slip.grossKobo).toBe(gross);
      expect(slip.netKobo).toBe(parseNairaToKobo(String(g.net)));
    }
  });
});
