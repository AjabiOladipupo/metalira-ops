/**
 * PAYE through the Nigeria Tax Act 2025 bands (docs/RULES_NIGERIA.md; confirm with a tax adviser
 * before the first live payroll): every band edge, the open top band, the exact fraction kept
 * until the monthly figure, and monotonic tax.
 */
import { describe, expect, it } from "vitest";

import { annualPaye, fraction, monthlyPaye, monthlyPayeOnAnnual } from "@/lib/payroll/paye";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";

const bands = NTA_2025_V1.rules.payeBands;
const N = (naira: bigint) => naira * 100n;

/** Annual tax in kobo, exact (asserting it is whole). */
function annualTaxKobo(taxableNaira: bigint): bigint {
  const { tax } = annualPaye(fraction(N(taxableNaira)), bands);
  expect(tax.num % tax.den).toBe(0n);
  return tax.num / tax.den;
}

describe("annual tax through the bands", () => {
  it.each([
    // [taxable naira, annual tax naira]
    [0n, 0n],
    [800_000n, 0n],
    [3_000_000n, 330_000n], // 2.2m × 15%
    [12_000_000n, 330_000n + 1_620_000n], // + 9m × 18%
    [25_000_000n, 330_000n + 1_620_000n + 2_730_000n], // + 13m × 21%
    [50_000_000n, 330_000n + 1_620_000n + 2_730_000n + 5_750_000n], // + 25m × 23%
    [60_000_000n, 10_430_000n + 2_500_000n], // + 10m × 25%
  ])("₦%s taxable gives ₦%s a year", (taxable, tax) => {
    expect(annualTaxKobo(taxable)).toBe(N(tax));
  });

  it("taxes ₦1 above ₦800,000 at 15% and rounds once, at the month", () => {
    const { tax, portions } = annualPaye(fraction(N(800_001n)), bands);
    // 15 kobo a year exactly.
    expect(tax.num * 1n).toBe(15n * tax.den);
    expect(portions.map((p) => p.rateBps)).toEqual([0, 1500]);
    // 15 ÷ 12 = 1.25 kobo, half up to 1.
    expect(monthlyPaye(tax)).toBe(1n);
  });

  it("gives the monthly figure at each edge", () => {
    expect(monthlyPayeOnAnnual(N(800_000n), bands)).toBe(0n);
    expect(monthlyPayeOnAnnual(N(800_001n), bands)).toBe(1n);
    expect(monthlyPayeOnAnnual(N(3_000_000n), bands)).toBe(N(27_500n));
    // 10,430,000 ÷ 12 = 869,166.666… → ₦869,166.67
    expect(monthlyPayeOnAnnual(N(50_000_000n), bands)).toBe(86_916_667n);
    // 1 kobo above ₦50m is taxed at 25%: 0.25 kobo more a year changes nothing at the month.
    expect(monthlyPayeOnAnnual(N(50_000_000n) + 1n, bands)).toBe(86_916_667n);
  });

  it("puts each part of income in its band", () => {
    const { portions } = annualPaye(fraction(N(60_000_000n)), bands);
    expect(portions.map((p) => [p.rateBps, p.portion.num / p.portion.den])).toEqual([
      [0, N(800_000n)],
      [1500, N(2_200_000n)],
      [1800, N(9_000_000n)],
      [2100, N(13_000_000n)],
      [2300, N(25_000_000n)],
      [2500, N(10_000_000n)],
    ]);
    expect(portions[5]!.widthKobo).toBeNull();
    expect(portions[5]!.lowerKobo).toBe(N(50_000_000n));
  });

  it("keeps a fractional taxable income exact", () => {
    // ₦800,000 + 0.5 kobo: 0.5 × 15% = 0.075 kobo a year.
    const { tax } = annualPaye(fraction(N(800_000n) * 2n + 1n, 2n), bands);
    expect(tax).toEqual({ num: 1n * 1500n, den: 2n * 10_000n });
  });

  it("is monotonic in taxable income", () => {
    let last = -1n;
    for (let naira = 0n; naira <= 60_000_000n; naira += 137_777n) {
      const m = monthlyPayeOnAnnual(N(naira), bands);
      expect(m >= last).toBe(true);
      last = m;
    }
  });

  it("treats a negative taxable income as nothing", () => {
    expect(annualPaye(fraction(-5n), bands).tax.num).toBe(0n);
  });
});
