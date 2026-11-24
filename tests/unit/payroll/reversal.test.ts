/**
 * Slice 5.7a: a reversal's copies sum to minus the original, to the kobo. The original is the
 * October 2026 golden run worked out by the engine (as golden.test.ts does); the reversal keeps
 * every stored amount as written with sign -1 (the migration's convention), so the run and its
 * reversal net to zero for every payslip, every line and every total.
 */
import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, sumKobo, type Kobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/contract";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import {
  MONEY_FIELDS,
  negatedTotals,
  reversalCopy,
  signed,
  signedTotals,
  type Amounts,
} from "@/lib/payroll/reversal";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import { runTotals } from "@/lib/payroll/run";

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

const results = golden.workers.map((w) =>
  grossToNet(
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
);

const amountsOf = (r: (typeof results)[number]): Amounts =>
  Object.fromEntries(MONEY_FIELDS.map((f) => [f, r[f]])) as Amounts;

describe("reversal copies of the october 2026 golden run", () => {
  const originals = results.map((r) => ({ sign: 1 as const, amounts: amountsOf(r) }));
  const copies = results.map((r) => reversalCopy(amountsOf(r)));

  it("keeps every stored amount as written, with sign -1", () => {
    for (const [i, c] of copies.entries()) {
      expect(c.sign).toBe(-1);
      expect(c.amounts).toEqual(originals[i]!.amounts);
    }
  });

  it("sums to minus the original run, field by field, to the kobo", () => {
    const original = signedTotals(originals);
    const reversal = signedTotals(copies);
    for (const f of MONEY_FIELDS) expect(reversal[f]).toBe(-original[f]);
    // The golden totals: gross ₦870,000, PAYE ₦55,150, pension ₦69,600, net ₦745,250, cost ₦974,400.
    expect(reversal.grossKobo).toBe(-kobo(golden.totals.gross));
    expect(reversal.payeKobo).toBe(-kobo(golden.totals.paye));
    expect(reversal.pensionEmployeeKobo).toBe(-kobo(golden.totals.pension_employee));
    expect(reversal.netKobo).toBe(-kobo(golden.totals.net));
    expect(reversal.employerCostKobo).toBe(-kobo(golden.totals.employer_cost));
  });

  it("nets the run and its reversal to zero", () => {
    const both = signedTotals([...originals, ...copies]);
    for (const f of MONEY_FIELDS) expect(both[f]).toBe(0n);
  });

  it("shows the reversal's totals as the run's totals negated", () => {
    const totals = runTotals(results);
    const shown = negatedTotals(totals);
    for (const f of MONEY_FIELDS) expect(shown[f]).toBe(-totals[f]);
    expect(shown.workerCount).toBe(totals.workerCount);
    expect(shown.netKobo).toBe(-kobo(golden.totals.net));
  });

  it("copies each payslip's lines so they sum to minus the original's", () => {
    for (const r of results) {
      const original = sumKobo(r.lines.map((l) => l.amountKobo));
      const copied = sumKobo(r.lines.map((l) => signed(-1, l.amountKobo)));
      expect(copied).toBe(-original);
    }
  });

  it("refuses a negative stored amount (stored amounts are never negative)", () => {
    const bad = { ...amountsOf(results[0]!), netKobo: -1n };
    expect(() => reversalCopy(bad)).toThrow(RangeError);
  });
});
