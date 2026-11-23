/**
 * The gate for Phase 5 (docs/PHASE_5.md decision 6 and "Tests that gate the engine"): the
 * gross-to-net engine alone reproduces fixtures/october-2026-golden.json exactly, in kobo, for
 * every worker's PAYE, employee pension, net and employer cost, the totals and the statutory
 * figures (pension total, NSITF, ITF).
 *
 * Inputs as the plan sets them: monthly gross split 50% basic, 30% housing, 20% transport (the
 * WkPayslip board's ₦60,000 / ₦36,000 / ₦24,000), the full cycle, no overtime, no NHF, ITF on
 * (6 workers), the rule set NTA 2025 v1. Naira in the fixture go through the string parser,
 * never `n * 100`. The `invoices` part is Phase 6.
 */
import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, sumKobo, type Kobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/contract";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import { storedTrace } from "@/lib/payroll/trace";

const kobo = (naira: number): Kobo => parseNairaToKobo(String(naira));

function salary(grossKobo: Kobo): EarningLine[] {
  const [basic, housing, transport] = allocateKobo(grossKobo, [5n, 3n, 2n]);
  const line = (
    code: "basic" | "housing" | "transport",
    amount: Kobo | undefined,
  ): EarningLine => ({
    code,
    label: code,
    amountKobo: amount!,
    pensionable: true,
    nhfBase: code === "basic",
    taxable: true,
    sources: [],
  });
  return [line("basic", basic), line("housing", housing), line("transport", transport)];
}

const results = golden.workers.map((w) => ({
  expected: w,
  result: grossToNet(
    {
      employmentType: "permanent",
      earnings: salary(kobo(w.gross)),
      nhfOptIn: false,
      annualRentKobo: kobo(w.annual_rent),
      deductions: [],
      carriedDeductionKobo: 0n,
    },
    NTA_2025_V1,
    { itfApplies: golden.workers.length >= NTA_2025_V1.rules.itf.minStaff },
  ),
}));

describe("october 2026 golden fixture, from the engine alone", () => {
  it("splits Musa Ibrahim's ₦120,000 as ₦60,000 / ₦36,000 / ₦24,000", () => {
    expect(salary(kobo(120000)).map((l) => l.amountKobo)).toEqual([
      6_000_000n,
      3_600_000n,
      2_400_000n,
    ]);
  });

  it.each(results.map((r) => [r.expected.name, r] as const))(
    "%s matches to the kobo",
    (_name, { expected, result }) => {
      expect(result.grossKobo).toBe(kobo(expected.gross));
      expect(result.payeKobo).toBe(kobo(expected.paye));
      expect(result.pensionEmployeeKobo).toBe(kobo(expected.pension_employee));
      expect(result.netKobo).toBe(kobo(expected.net));
      expect(result.employerCostKobo).toBe(kobo(expected.employer_cost));
      expect(result.nhfKobo).toBe(0n);
      expect(result.otherDeductionsKobo).toBe(0n);
      expect(result.carriedForwardKobo).toBe(0n);
      expect(result.flags).toEqual([]);
    },
  );

  it("matches the totals", () => {
    const sum = (pick: (r: (typeof results)[number]["result"]) => Kobo) =>
      sumKobo(results.map((r) => pick(r.result)));
    expect(sum((r) => r.grossKobo)).toBe(kobo(golden.totals.gross));
    expect(sum((r) => r.payeKobo)).toBe(kobo(golden.totals.paye));
    expect(sum((r) => r.pensionEmployeeKobo)).toBe(kobo(golden.totals.pension_employee));
    expect(sum((r) => r.netKobo)).toBe(kobo(golden.totals.net));
    expect(sum((r) => r.employerCostKobo)).toBe(kobo(golden.totals.employer_cost));
  });

  it("matches the statutory figures", () => {
    const sum = (pick: (r: (typeof results)[number]["result"]) => Kobo) =>
      sumKobo(results.map((r) => pick(r.result)));
    expect(sum((r) => r.pensionEmployeeKobo + r.pensionEmployerKobo)).toBe(
      kobo(golden.statutory.pension_total),
    );
    expect(sum((r) => r.nsitfKobo)).toBe(kobo(golden.statutory.nsitf));
    expect(sum((r) => r.itfKobo)).toBe(kobo(golden.statutory.itf));
  });

  it("explains Musa Ibrahim's PAYE as the plan's worked check", () => {
    const musa = results.find((r) => r.expected.name === "Musa Ibrahim")!.result;
    const step = (id: string) => musa.trace.filter((s) => s.step === id);
    expect(step("annual_gross")[0]).toMatchObject({
      label: "Gross pay (₦120,000 × 12)",
      valueKobo: 144000000n,
    });
    expect(step("annual_pension")[0]).toMatchObject({
      label: "Less employee pension 8%",
      valueKobo: 11520000n,
    });
    expect(step("rent_relief")[0]).toMatchObject({
      label: "Less rent relief, 20% of ₦360,000 rent (cap ₦500,000)",
      valueKobo: 7200000n,
    });
    expect(step("taxable")[0]!.valueKobo?.toString()).toBe("125280000");
    expect(step("paye_band").map((s) => [s.label, s.valueKobo?.toString()])).toEqual([
      ["0% on ₦800,000", "0"],
      ["15% on ₦452,800", "6792000"],
    ]);
    expect(step("annual_tax")[0]!.valueKobo?.toString()).toBe("6792000");
    expect(step("paye")[0]!.valueKobo?.toString()).toBe("566000");
    expect(step("employer_cost")[0]!.valueKobo?.toString()).toBe("13440000");
  });

  it("keeps names out of the trace (the engine is never given one)", () => {
    const text = JSON.stringify(results.map((r) => storedTrace(r.result.trace)));
    for (const w of golden.workers) expect(text).not.toContain(w.name);
  });
});
