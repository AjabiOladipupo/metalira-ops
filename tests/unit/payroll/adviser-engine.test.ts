/**
 * Slice 5.9a: the payroll tax engine per the tax adviser's answers of 24 Nov 2026 (NTA 2025,
 * NTAA 2025, PRA 2014, the NHF Act, ECA 2010, the ITF Act, the Labour Act), approved by the owner.
 *
 * - Cumulative year-to-date PAYE: tax due to date = band tax on (chargeable pay to date × 12 ÷
 *   months elapsed) × months elapsed ÷ 12; PAYE = that less PAYE already withheld, rounded once,
 *   never below ₦0. With nothing earlier in the year it is the month annualised (the golden
 *   fixture holds, under NTA 2025 v1 and v2).
 * - The minimum-wage exemption, daily workers (owner decision: no longer exempt), pension from 3
 *   employees, NHF conditions, NSITF on regular pay, NHIS and life assurance reliefs, the
 *   one-third deduction cap, and clawbacks before tax in the same tax year.
 *
 * Most examples use ₦300,000 a month (₦150,000 / ₦90,000 / ₦60,000), no rent: pension ₦24,000;
 * chargeable ₦276,000 a month, ₦3,312,000 a year; tax ₦330,000 + 18% of ₦312,000 = ₦386,160;
 * PAYE ₦32,180 a month. In the 18% band, tax on an annualised A is 0.18A − ₦210,000, so tax due
 * after m months on chargeable C is 0.18C − ₦17,500m.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, roundHalfUp, sumKobo, type Kobo } from "@/lib/money";
import type { EarningLine, PayslipResult, YearToDate } from "@/lib/payroll/contract";
import { computeEarnings, POLICY_DEFAULTS, type EarningsWorker } from "@/lib/payroll/earnings";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import type { LeaveArrearsInput } from "@/lib/payroll/inputs";
import { annualPaye, fraction } from "@/lib/payroll/paye";
import {
  NTA_2025_V1,
  NTA_2025_V2,
  parseRuleSet,
  ruleSetFigures,
  ruleSetPolicyJson,
  ruleSetRulesJson,
  taxRulesJsonSchema,
} from "@/lib/payroll/rule-set";
import {
  adjustmentLines,
  itfLiable,
  pensionAppliesFor,
  workerPayslip,
  type RunAdjustment,
} from "@/lib/payroll/run";
import {
  overpaymentTooOld,
  parseTaxContext,
  yearToDateFor,
  type YearSlip,
} from "@/lib/payroll/ytd";

const V2 = NTA_2025_V2;
const naira = (n: number): Kobo => parseNairaToKobo(String(n));

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

const overtime = (amount: Kobo): EarningLine => ({
  code: "overtime",
  label: "Overtime",
  amountKobo: amount,
  pensionable: false,
  nhfBase: false,
  taxable: true,
  sources: [],
});

const bonus = (amount: Kobo): EarningLine => ({
  code: "adjustment_earning",
  label: "Bonus",
  amountKobo: amount,
  pensionable: false,
  nhfBase: false,
  taxable: true,
  sources: [],
});

interface Opts {
  ytd?: YearToDate;
  rules?: typeof V2;
  rent?: Kobo;
  nhfOptIn?: boolean;
  nhfNumberOnFile?: boolean;
  pensionApplies?: boolean;
  deductions?: Kobo[];
  employmentType?: "permanent" | "daily";
  reliefs?: { nhisAnnualKobo: Kobo; lifeAssuranceAnnualKobo: Kobo };
}

function slip(earnings: EarningLine[], o: Opts = {}): PayslipResult {
  return grossToNet(
    {
      employmentType: o.employmentType ?? "permanent",
      earnings,
      nhfOptIn: o.nhfOptIn ?? false,
      annualRentKobo: o.rent ?? 0n,
      deductions: (o.deductions ?? []).map((amountKobo, i) => ({
        label: `Loan ${i + 1}`,
        amountKobo,
        sources: [{ kind: "adjustment", id: randomUUID() }],
      })),
      carriedDeductionKobo: 0n,
      ...(o.nhfNumberOnFile !== undefined ? { nhfNumberOnFile: o.nhfNumberOnFile } : {}),
      ...(o.reliefs ? { reliefs: o.reliefs } : {}),
    },
    o.rules ?? V2,
    {
      itfApplies: true,
      ...(o.ytd ? { yearToDate: o.ytd } : {}),
      ...(o.pensionApplies !== undefined ? { pensionApplies: o.pensionApplies } : {}),
    },
  );
}

const chargeable = (s: PayslipResult): Kobo =>
  sumKobo(s.lines.filter((l) => l.kind === "earning" && l.taxable).map((l) => l.amountKobo)) -
  s.pensionEmployeeKobo -
  s.nhfKobo;

/** The year so far after `slips` (all counted), `month` months elapsed from January. */
function ytdAfter(slips: readonly PayslipResult[], month: number): YearToDate {
  return {
    monthsElapsed: month,
    fromMonth: "2026-01",
    payslips: slips.length,
    grossKobo: sumKobo(slips.map((s) => s.grossKobo)),
    chargeableKobo: sumKobo(slips.map(chargeable)),
    payeKobo: sumKobo(slips.map((s) => s.payeKobo)),
    opening: null,
  };
}

/** Runs a year of monthly payslips from January; `earningsOf(month)` gives each month's lines. */
function year(earningsOf: (month: number) => EarningLine[], months = 12): PayslipResult[] {
  const out: PayslipResult[] = [];
  for (let m = 1; m <= months; m += 1) {
    out.push(slip(earningsOf(m), { ytd: ytdAfter(out, m) }));
  }
  return out;
}

/** Annual tax on a year's chargeable pay, rounded once (what a full year's PAYE must sum to). */
function annualTaxOn(chargeableKobo: Kobo, reliefKobo: Kobo = 0n): Kobo {
  const t = annualPaye(fraction(chargeableKobo - reliefKobo), V2.rules.payeBands).tax;
  return roundHalfUp(t.num, t.den);
}

const REGULAR = naira(300_000);

describe("NTA 2025 v2: the adviser's rule set", () => {
  it("keeps v1's bands and rates and adds the adviser's figures", () => {
    expect(V2.rules.payeBands).toEqual(NTA_2025_V1.rules.payeBands);
    expect(V2.rules.rentRelief).toEqual(NTA_2025_V1.rules.rentRelief);
    expect(V2.rules.dailyWorkersExempt).toBe(false);
    expect(V2.rules.adviser).toEqual({
      minimumWageMonthlyKobo: naira(70_000),
      pensionMinEmployees: 3,
      dailyPayPensionable: true,
      nhfNeedsNumberAndMinimumWage: true,
      nsitfRegularOnly: true,
      deductionCap: { numerator: 1, denominator: 3 },
      clawback: { preTaxSameTaxYear: true, maxAgeMonths: 3 },
      reliefs: { rentProofRequired: true, nhis: true, lifeAssurance: true },
    });
    expect(NTA_2025_V1.rules.adviser).toBeNull();
  });

  it("round-trips through the stored jsonb, and v1 still parses without the adviser's part", () => {
    const rules = ruleSetRulesJson(V2.rules);
    expect(parseRuleSet(V2.name, rules, ruleSetPolicyJson(V2.policy))).toEqual(V2);
    const v1 = ruleSetRulesJson(NTA_2025_V1.rules);
    expect("adviser" in v1).toBe(false);
    expect(parseRuleSet(NTA_2025_V1.name, v1, ruleSetPolicyJson(NTA_2025_V1.policy))).toEqual(
      NTA_2025_V1,
    );
  });

  it("refuses an adviser part with a missing or extra figure, or a cap above 1", () => {
    const rules = ruleSetRulesJson(V2.rules) as Record<string, unknown>;
    const adviser = rules.adviser as Record<string, unknown>;
    const without = { ...adviser };
    delete without.nsitf_regular_only;
    expect(taxRulesJsonSchema.safeParse({ ...rules, adviser: without }).success).toBe(false);
    expect(
      taxRulesJsonSchema.safeParse({ ...rules, adviser: { ...adviser, extra: 1 } }).success,
    ).toBe(false);
    expect(
      taxRulesJsonSchema.safeParse({
        ...rules,
        adviser: { ...adviser, deduction_cap: { numerator: 4, denominator: 3 } },
      }).success,
    ).toBe(false);
  });

  it("lists the adviser's figures on Settings > Payroll rules", () => {
    const keys = ruleSetFigures(V2).map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "paye_method",
        "minimum_wage",
        "pension_min_employees",
        "nhf_conditions",
        "nsitf_base",
        "deduction_cap",
        "clawback",
        "reliefs",
      ]),
    );
    expect(ruleSetFigures(V2).find((f) => f.key === "minimum_wage")?.value).toContain("₦70,000");
    expect(ruleSetFigures(NTA_2025_V1).some((f) => f.key === "paye_method")).toBe(false);
  });
});

describe("the golden fixture under NTA 2025 v2 (October is the first payroll)", () => {
  // October is these workers' first payroll in the app, with no opening balance: months elapsed
  // count from go-live (October), one month, which is the month annualised. Their rent proof is
  // verified, so the server passes the declared rent.
  const ytdFirst: YearToDate = {
    monthsElapsed: 1,
    fromMonth: "2026-10",
    payslips: 0,
    grossKobo: 0n,
    chargeableKobo: 0n,
    payeKobo: 0n,
    opening: null,
    reliefIds: [],
  };
  const results = golden.workers.map((w) => ({
    expected: w,
    result: slip(salary(naira(w.gross)), { ytd: ytdFirst, rent: naira(w.annual_rent) }),
  }));

  it.each(results.map((r) => [r.expected.name, r] as const))(
    "%s",
    (_name, { expected, result }) => {
      expect(result.payeKobo).toBe(naira(expected.paye));
      expect(result.pensionEmployeeKobo).toBe(naira(expected.pension_employee));
      expect(result.netKobo).toBe(naira(expected.net));
      expect(result.employerCostKobo).toBe(naira(expected.employer_cost));
    },
  );

  it("reproduces the totals and the statutory figures", () => {
    const sum = (pick: (r: PayslipResult) => Kobo) => sumKobo(results.map((r) => pick(r.result)));
    expect(sum((r) => r.grossKobo)).toBe(naira(golden.totals.gross));
    expect(sum((r) => r.payeKobo)).toBe(naira(golden.totals.paye));
    expect(sum((r) => r.netKobo)).toBe(naira(golden.totals.net));
    expect(sum((r) => r.employerCostKobo)).toBe(naira(golden.totals.employer_cost));
    expect(sum((r) => r.pensionEmployeeKobo + r.pensionEmployerKobo)).toBe(
      naira(golden.statutory.pension_total),
    );
    expect(sum((r) => r.nsitfKobo)).toBe(naira(golden.statutory.nsitf));
    expect(sum((r) => r.itfKobo)).toBe(naira(golden.statutory.itf));
  });

  it("gives Grace Edet ₦0 by the minimum-wage exemption (₦70,000 a month, at the limit)", () => {
    const grace = results.find((r) => r.expected.name === "Grace Edet")!.result;
    expect(grace.payeKobo).toBe(0n);
    expect(grace.trace.find((t) => t.step === "minimum_wage")?.inputs.exempt).toBe("true");
  });

  it("is the month annualised: the same as with no year-to-date at all", () => {
    for (const w of golden.workers) {
      const a = slip(salary(naira(w.gross)), { ytd: ytdFirst, rent: naira(w.annual_rent) });
      const b = slip(salary(naira(w.gross)), { rent: naira(w.annual_rent) });
      expect(a.payeKobo).toBe(b.payeKobo);
    }
  });
});

describe("cumulative year-to-date PAYE", () => {
  it("takes ₦32,180 every month on a steady ₦300,000, and the year sums to the annual tax", () => {
    const months = year(() => salary(REGULAR));
    expect(months.map((s) => s.payeKobo)).toEqual(Array(12).fill(naira(32_180)));
    expect(sumKobo(months.map((s) => s.payeKobo))).toBe(naira(386_160));
  });

  it("a joiner counts months from their start date, so a June joiner isn't under-taxed", () => {
    const ytd = yearToDateFor({
      payDate: "2026-06-25",
      startDate: "2026-06-08",
      goLiveMonth: "2026-01-01",
      worker: null,
      slips: [],
    });
    expect(ytd).toMatchObject({ monthsElapsed: 1, fromMonth: "2026-06", payslips: 0 });
    // A full June on ₦300,000: ₦32,180, not spread over six months.
    expect(slip(salary(REGULAR), { ytd }).payeKobo).toBe(naira(32_180));
    // Their second month: two months from June.
    expect(
      yearToDateFor({
        payDate: "2026-07-25",
        startDate: "2026-06-08",
        goLiveMonth: "2026-01-01",
        worker: null,
        slips: [],
      }),
    ).toMatchObject({ monthsElapsed: 2, fromMonth: "2026-06" });
  });

  it("counts from go-live for a worker who started before it, with no opening balance", () => {
    expect(
      yearToDateFor({
        payDate: "2026-10-25",
        startDate: "2024-03-01",
        goLiveMonth: null,
        worker: null,
        slips: [],
      }),
    ).toMatchObject({ monthsElapsed: 1, fromMonth: "2026-10" });
    expect(
      yearToDateFor({
        payDate: "2026-12-25",
        startDate: "2024-03-01",
        goLiveMonth: "2026-10-01",
        worker: null,
        slips: [],
      }),
    ).toMatchObject({ monthsElapsed: 3, fromMonth: "2026-10" });
    // Go-live in an earlier year: from 1 January.
    expect(
      yearToDateFor({
        payDate: "2027-03-25",
        startDate: "2024-03-01",
        goLiveMonth: "2026-10-01",
        worker: null,
        slips: [],
      }),
    ).toMatchObject({ monthsElapsed: 3, fromMonth: "2027-01" });
  });

  it("evens out an overtime spike over the year: the year still sums to the annual tax", () => {
    const spike = naira(200_000);
    const months = year((m) => salary(REGULAR, m === 4 ? [overtime(spike)] : []));
    // The spike month carries 18% of the overtime, and the months after go back to ₦32,180.
    expect(months[3]!.payeKobo).toBe(naira(32_180) + roundHalfUp(spike * 18n, 100n));
    expect(months[4]!.payeKobo).toBe(naira(32_180));
    const yearChargeable = sumKobo(months.map(chargeable));
    expect(sumKobo(months.map((s) => s.payeKobo))).toBe(annualTaxOn(yearChargeable));
  });

  it("taxes arrears paid in a later month through the year's total, not as a twelve-times spike", () => {
    const arrears: EarningLine = { ...overtime(naira(90_000)), code: "arrears", label: "Arrears" };
    const months = year((m) => salary(REGULAR, m === 7 ? [arrears] : []));
    expect(months[6]!.payeKobo).toBe(naira(32_180) + naira(16_200));
    const yearChargeable = sumKobo(months.map(chargeable));
    expect(sumKobo(months.map((s) => s.payeKobo))).toBe(annualTaxOn(yearChargeable));
    // Annualising the month alone would have charged the arrears month more.
    const annualised = slip(salary(REGULAR, [arrears]));
    expect(annualised.payeKobo).toBeGreaterThanOrEqual(months[6]!.payeKobo);
  });

  it("gives ₦10,800 on a ₦60,000 bonus over ₦300,000, where the year-to-date maths agrees", () => {
    const months = year((m) => salary(REGULAR, m === 6 ? [bonus(naira(60_000))] : []), 7);
    expect(months[5]!.payeKobo).toBe(naira(42_980));
    expect(months[5]!.payeKobo - months[4]!.payeKobo).toBe(naira(10_800));
    expect(months[6]!.payeKobo).toBe(naira(32_180));
  });

  it("takes the opening balance's months and PAYE into the year", () => {
    // Nine months to September before go-live on ₦300,000: gross ₦2,700,000, chargeable
    // ₦2,484,000, PAYE ₦289,620, pension ₦216,000.
    const opening = {
      id: randomUUID(),
      asOfMonth: "2026-09",
      grossKobo: naira(2_700_000),
      chargeableKobo: naira(2_484_000),
      payeKobo: naira(289_620),
      pensionKobo: naira(216_000),
    };
    const ytd = yearToDateFor({
      payDate: "2026-10-25",
      startDate: "2024-03-01",
      goLiveMonth: null,
      worker: { hasNhfNumber: false, rentDeclaredKobo: 0n, opening, reliefs: [] },
      slips: [],
    });
    expect(ytd).toMatchObject({ monthsElapsed: 10, fromMonth: "2026-01", opening });
    const oct = slip(salary(REGULAR), { ytd });
    expect(oct.payeKobo).toBe(naira(32_180));
    expect(oct.trace.find((t) => t.step === "year_to_date")?.inputs.opening_balance_id).toBe(
      opening.id,
    );
    // Under-withheld before go-live (₦200,000 instead of ₦289,620): October catches it up.
    const caught = slip(salary(REGULAR), {
      ytd: { ...ytd, opening: { ...opening, payeKobo: naira(200_000) } },
    });
    expect(caught.payeKobo).toBe(naira(32_180) + naira(89_620));
  });

  it("counts only payslips paid after the opening balance's month", () => {
    const slips: YearSlip[] = [
      { payslipId: "a", payDate: "2026-09-25", grossKobo: 1n, chargeableKobo: 1n, payeKobo: 1n },
      { payslipId: "b", payDate: "2026-10-16", grossKobo: 2n, chargeableKobo: 2n, payeKobo: 2n },
    ];
    const ytd = yearToDateFor({
      payDate: "2026-10-25",
      startDate: "2024-03-01",
      goLiveMonth: "2026-09-01",
      worker: {
        hasNhfNumber: false,
        rentDeclaredKobo: 0n,
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
      slips,
    });
    expect(ytd.payslips).toBe(1);
    expect(ytd.grossKobo).toBe(2n);
  });

  it("aggregates two payslips in one month: the second takes the month's PAYE less the first's", () => {
    const first = slip(salary(REGULAR), { ytd: ytdAfter([], 1) });
    const second = slip([bonus(naira(60_000))], { ytd: ytdAfter([first], 1) });
    expect(first.payeKobo + second.payeKobo).toBe(naira(42_980));
  });

  it("excludes a reversed payslip mid-year: the next payslip catches the year up", () => {
    const months = year(() => salary(REGULAR), 5);
    // March is reversed, so June counts four standing payslips (₦128,720 withheld) over six
    // months: chargeable ₦1,380,000 with June's, annualised ₦2,760,000, tax 15% of ₦1,960,000 =
    // ₦294,000 a year, ₦147,000 due to date; June withholds ₦18,280.
    const standing = months.filter((_, i) => i !== 2);
    const june = slip(salary(REGULAR), { ytd: ytdAfter(standing, 6) });
    expect(june.payeKobo).toBe(naira(18_280));
    // Paid again in June (March's ₦300,000 as arrears), the year is whole: two months' PAYE.
    const repaid: EarningLine = { ...overtime(REGULAR), code: "arrears", label: "March, again" };
    const withArrears = slip(salary(REGULAR, [repaid]), { ytd: ytdAfter(standing, 6) });
    // Arrears aren't pensionable here, so ₦24,000 more is chargeable: 18% of it, ₦4,320, on top.
    expect(withArrears.payeKobo).toBe(naira(32_180) * 2n + naira(4_320));
  });

  it("never withholds below ₦0, carries the over-withholding on the trace and flags it", () => {
    const months = year(() => salary(REGULAR), 3);
    // PAYE withheld above the tax due to date (the year's chargeable pay corrected to ₦0).
    const ytd = { ...ytdAfter(months, 4), chargeableKobo: 0n };
    const april = slip(salary(naira(10_000)), { ytd });
    expect(april.payeKobo).toBe(0n);
    expect(april.flags).toContain("paye_overwithheld");
    const step = april.trace.find((t) => t.step === "paye_overwithheld");
    expect(step?.valueKobo).toBeGreaterThan(0n);
  });

  it("rounds once: the exact tax due less whole kobo withheld, half up", () => {
    // ₦250,001 a month leaves fractions of a kobo in the monthly tax.
    const months = year(() => salary(naira(250_001)));
    const yearChargeable = sumKobo(months.map(chargeable));
    expect(sumKobo(months.map((s) => s.payeKobo))).toBe(annualTaxOn(yearChargeable));
  });
});

describe("the minimum-wage exemption", () => {
  it("gives ₦0 at or below ₦70,000 a month even where the bands would tax", () => {
    // No pension (a company under 3 employees), so ₦840,000 a year would owe 15% of ₦40,000.
    const at = slip(salary(naira(70_000)), { pensionApplies: false });
    expect(at.payeKobo).toBe(0n);
    const v1 = slip(salary(naira(70_000)), { pensionApplies: false, rules: NTA_2025_V1 });
    expect(v1.payeKobo).toBe(naira(500));
  });

  it("applies the normal bands to all chargeable income above it", () => {
    const above = slip(salary(naira(70_001)), { pensionApplies: false });
    // ₦840,012 a year: 15% of ₦40,012 = ₦6,001.80, ÷ 12 = ₦500.15.
    expect(above.payeKobo).toBe(50_015n);
  });

  it("works on the year-to-date basis: a low month in a well-paid year still pays", () => {
    const months = year(() => salary(REGULAR), 2);
    const march = slip(salary(naira(60_000)), { ytd: ytdAfter(months, 3) });
    expect(march.trace.find((t) => t.step === "minimum_wage")?.inputs.exempt).toBe("false");
  });
});

describe("daily workers (owner decision: no longer exempt from NTA 2025 v2)", () => {
  const daily = (amount: Kobo): EarningLine => ({
    code: "daily_pay",
    label: "Daily pay",
    amountKobo: amount,
    pensionable: false,
    nhfBase: false,
    taxable: true,
    sources: [],
  });

  it("pays pension on the consolidated daily pay, PAYE, NSITF and ITF", () => {
    const s = slip([daily(naira(150_000))], { employmentType: "daily" });
    expect(s.pensionEmployeeKobo).toBe(naira(12_000));
    expect(s.pensionEmployerKobo).toBe(naira(15_000));
    expect(s.nsitfKobo).toBe(naira(1_500));
    expect(s.itfKobo).toBe(naira(1_500));
    expect(s.payeKobo).toBeGreaterThan(0n);
    expect(s.trace.some((t) => t.step === "daily_worker")).toBe(false);
  });

  it("keeps the minimum-wage exemption", () => {
    expect(slip([daily(naira(60_000))], { employmentType: "daily" }).payeKobo).toBe(0n);
  });

  it("stays exempt under NTA 2025 v1 (a dated rule)", () => {
    const s = slip([daily(naira(150_000))], { employmentType: "daily", rules: NTA_2025_V1 });
    expect(s.payeKobo + s.pensionEmployeeKobo + s.nsitfKobo + s.itfKobo).toBe(0n);
  });
});

describe("pension from 3 employees, NHF conditions, NSITF on regular pay, ITF", () => {
  it("takes no pension when the company has fewer than 3 employees on the pay date", () => {
    expect(pensionAppliesFor(2, V2)).toBe(false);
    expect(pensionAppliesFor(3, V2)).toBe(true);
    expect(pensionAppliesFor(1, NTA_2025_V1)).toBe(true);
    const s = slip(salary(REGULAR), { pensionApplies: false });
    expect(s.pensionEmployeeKobo + s.pensionEmployerKobo).toBe(0n);
    expect(s.trace.some((t) => t.step === "pension_threshold")).toBe(true);
  });

  it("takes NHF only when opted in, with a number on file and pay at or above the minimum wage", () => {
    const yes = slip(salary(REGULAR), { nhfOptIn: true, nhfNumberOnFile: true });
    expect(yes.nhfKobo).toBe(naira(3_750));
    const noNumber = slip(salary(REGULAR), { nhfOptIn: true, nhfNumberOnFile: false });
    expect(noNumber.nhfKobo).toBe(0n);
    expect(noNumber.flags).toContain("nhf_not_deducted");
    const low = slip(salary(naira(60_000)), { nhfOptIn: true, nhfNumberOnFile: true });
    expect(low.nhfKobo).toBe(0n);
    expect(low.flags).toContain("nhf_not_deducted");
    const v1 = slip(salary(REGULAR), {
      nhfOptIn: true,
      nhfNumberOnFile: false,
      rules: NTA_2025_V1,
    });
    expect(v1.nhfKobo).toBe(naira(3_750));
  });

  it("leaves overtime, bonuses and arrears out of the NSITF base", () => {
    const s = slip(salary(REGULAR, [overtime(naira(50_000)), bonus(naira(20_000))]));
    expect(s.nsitfKobo).toBe(naira(3_000));
    expect(s.itfKobo).toBe(naira(3_700));
    const v1 = slip(salary(REGULAR, [overtime(naira(50_000))]), { rules: NTA_2025_V1 });
    expect(v1.nsitfKobo).toBe(naira(3_500));
  });

  it("makes ITF due at 5 employees OR with the company's ₦50m turnover switch", () => {
    expect(itfLiable(5, false, V2)).toBe(true);
    expect(itfLiable(4, false, V2)).toBe(false);
    expect(itfLiable(1, true, V2)).toBe(true);
  });
});

describe("reliefs on verified proof", () => {
  it("takes NHIS and life assurance off the year's chargeable income", () => {
    const plain = slip(salary(REGULAR));
    const relieved = slip(salary(REGULAR), {
      reliefs: { nhisAnnualKobo: naira(60_000), lifeAssuranceAnnualKobo: naira(120_000) },
    });
    // ₦180,000 less taxable income in the 18% band: ₦32,400 a year, ₦2,700 a month.
    expect(plain.payeKobo - relieved.payeKobo).toBe(naira(2_700));
    expect(relieved.trace.map((t) => t.step)).toEqual(
      expect.arrayContaining(["nhis_relief", "life_assurance_relief"]),
    );
  });

  it("spreads an annual relief over the months elapsed, like rent relief", () => {
    const months = year(() => salary(REGULAR), 5);
    const june = slip(salary(REGULAR), {
      ytd: ytdAfter(months, 6),
      reliefs: { nhisAnnualKobo: naira(120_000), lifeAssuranceAnnualKobo: 0n },
    });
    // Verified in June: six months of the relief at 18% (₦10,800) come off June's PAYE.
    expect(june.payeKobo).toBe(naira(32_180) - naira(10_800));
  });

  it("ignores reliefs under NTA 2025 v1", () => {
    const s = slip(salary(REGULAR), {
      rules: NTA_2025_V1,
      reliefs: { nhisAnnualKobo: naira(60_000), lifeAssuranceAnnualKobo: 0n },
    });
    expect(s.payeKobo).toBe(naira(32_180));
  });
});

describe("the one-third deduction cap (Labour Act s.5(7))", () => {
  it("caps other deductions at a third of gross; PAYE, pension and NHF come off in full", () => {
    const s = slip(salary(naira(90_000)), { deductions: [naira(50_000)] });
    expect(s.otherDeductionsKobo).toBe(naira(30_000));
    expect(s.carriedForwardKobo).toBe(naira(20_000));
    expect(s.flags).toContain("deduction_capped");
    expect(s.pensionEmployeeKobo).toBe(naira(7_200));
  });

  it("caps across several deductions in the order added, and rounds the cap down", () => {
    const s = slip(salary(naira(100_000)), { deductions: [naira(20_000), naira(20_000)] });
    // A third of ₦100,000 is ₦33,333.33⅓, rounded down to ₦33,333.33.
    expect(s.otherDeductionsKobo).toBe(3_333_333n);
    expect(s.carriedForwardKobo).toBe(naira(40_000) - 3_333_333n);
  });

  it("doesn't cap under NTA 2025 v1", () => {
    const s = slip(salary(naira(90_000)), { deductions: [naira(50_000)], rules: NTA_2025_V1 });
    expect(s.otherDeductionsKobo).toBe(naira(50_000));
  });
});

describe("clawbacks before tax in the same tax year", () => {
  const correction = (over: Partial<RunAdjustment> = {}): RunAdjustment => ({
    id: randomUUID(),
    workerId: randomUUID(),
    kind: "deduction",
    label: "Overpaid overtime, September",
    amountKobo: naira(20_000),
    pensionable: false,
    taxable: false,
    instalmentNumber: 1,
    instalmentCount: 1,
    correctsPayslipId: randomUUID(),
    ...over,
  });

  it("makes a same-year deduction correction a negative clawback line that reduces taxable pay", () => {
    const { earnings, deductions } = adjustmentLines([correction({ preTax: true })]);
    expect(deductions).toEqual([]);
    expect(earnings[0]).toMatchObject({
      code: "clawback",
      amountKobo: -naira(20_000),
      taxable: true,
      pensionable: false,
    });
    const s = slip(salary(REGULAR, earnings));
    expect(s.grossKobo).toBe(naira(280_000));
    expect(s.payeKobo).toBe(naira(32_180) - naira(3_600));
    expect(s.pensionEmployeeKobo).toBe(naira(24_000));
  });

  it("reduces the pension base when the clawed-back earning was pensionable", () => {
    const { earnings } = adjustmentLines([correction({ preTax: true, pensionable: true })]);
    const s = slip(salary(REGULAR, earnings));
    expect(s.pensionEmployeeKobo).toBe(naira(22_400));
  });

  it("recovers an earlier year's overpayment after tax, with a note", () => {
    const { earnings, deductions } = adjustmentLines([correction({ priorTaxYear: 2025 })]);
    expect(earnings).toEqual([]);
    expect(deductions[0]?.label).toBe(
      "Overpaid overtime, September, recovered after tax (overpaid in 2025)",
    );
  });

  it("refuses an overpayment older than 3 months at discovery (Labour Act s.5(5))", () => {
    expect(overpaymentTooOld("2026-08-24", "2026-11-25", 3)).toBe(true);
    expect(overpaymentTooOld("2026-08-25", "2026-11-25", 3)).toBe(false);
    expect(overpaymentTooOld("2026-11-30", "2027-02-28", 3)).toBe(false);
    expect(overpaymentTooOld("2026-11-27", "2027-02-28", 3)).toBe(true);
  });

  it("recovers late unpaid leave of the same tax year before tax, as leave deduction lines", () => {
    const arrears: LeaveArrearsInput = {
      requestId: randomUUID(),
      typeCode: "unpaid",
      counting: "working_days",
      payPercent: 0,
      payBelowService: false,
      periodStart: "2026-08-20",
      periodEnd: "2026-09-19",
      from: "2026-09-10",
      to: "2026-09-11",
      rosteredDays: 22,
      shifts: [],
    };
    const worker: EarningsWorker = {
      workerId: randomUUID(),
      employmentType: "permanent",
      startDate: "2025-01-06",
      endDate: null,
      usualWorkDays: null,
      payRates: [
        {
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
        },
      ],
      shifts: [],
      lastRostered: null,
      lines: [],
      arrears: [],
      leave: [],
      noShowDates: [],
      openLineCount: 0,
      leaveArrears: [arrears],
    };
    const policy = {
      standardShiftMinutes: 480,
      hourlyRateDivisorDays: 20,
      workDaysPerWeek: 5,
      ...POLICY_DEFAULTS,
    };
    const run = (year: number | null) =>
      computeEarnings(
        {
          period: { start: "2026-10-20", end: "2026-11-19" },
          holidays: [],
          defaultWorkDays: [1, 2, 3, 4, 5],
          worker,
          preTaxArrearsYear: year,
        },
        policy,
      );
    const same = run(2026);
    const late = same.lines.filter((l) => l.code === "leave_deduction");
    // ₦120,000 × 2 ÷ 22 = ₦10,909.09, split across basic, housing and transport.
    expect(sumKobo(late.map((l) => l.amountKobo))).toBe(-roundHalfUp(12_000_000n * 2n, 22n));
    expect(late.every((l) => l.sources[0]?.kind === "leave_request")).toBe(true);
    expect(same.deductions ?? []).toEqual([]);
    const pay = (e: ReturnType<typeof run>) =>
      workerPayslip(
        {
          employmentType: "permanent",
          earnings: e,
          adjustments: [],
          nhfOptIn: false,
          annualRentKobo: 0n,
          carriedDeductionKobo: 0n,
        },
        V2,
        { itfApplies: false, ruleSetId: "test" },
      );
    const before = pay(same);
    const after = pay(run(2027));
    // Before tax: lower gross, PAYE and pension; after tax (an earlier year): gross untouched.
    expect(before.grossKobo).toBeLessThan(after.grossKobo);
    expect(before.payeKobo).toBeLessThan(after.payeKobo);
    expect(before.pensionEmployeeKobo).toBeLessThan(after.pensionEmployeeKobo);
    expect(run(2027).deductions?.[0]?.label).toContain("recovered after tax (2026)");
  });
});

describe("the tax context read", () => {
  it("parses payroll_tax_context's jsonb", () => {
    const id = randomUUID();
    const relief = randomUUID();
    const ctx = parseTaxContext({
      version: 1,
      headcount: 6,
      itf_turnover_over_50m: false,
      go_live_month: "2026-10-01",
      workers: [
        {
          worker_id: id,
          has_nhf_number: true,
          rent_declared_kobo: "36000000",
          opening: null,
          reliefs: [{ id: relief, kind: "rent", annual_kobo: "36000000" }],
        },
      ],
    });
    expect(ctx.headcount).toBe(6);
    expect(ctx.workers.get(id)).toEqual({
      hasNhfNumber: true,
      rentDeclaredKobo: 36_000_000n,
      opening: null,
      reliefs: [{ id: relief, kind: "rent", annualKobo: 36_000_000n }],
    });
  });
});
