import { describe, expect, it } from "vitest";
import golden from "../../fixtures/october-2026-golden.json";
import { applyBps, formatNaira, parseNairaToKobo, sumKobo, type Kobo } from "@/lib/money";

/**
 * Money shapes from fixtures/october-2026-golden.json, checked in exact kobo.
 * The fixture holds naira for readability; convert through the string parser, never `n * 100`.
 * PAYE itself is computed in Phase 5; here we only check the arithmetic that ties the numbers.
 */
const kobo = (naira: number): Kobo => parseNairaToKobo(String(naira));

const workers = golden.workers.map((w) => ({
  name: w.name,
  gross: kobo(w.gross),
  paye: kobo(w.paye),
  pensionEmployee: kobo(w.pension_employee),
  net: kobo(w.net),
  employerCost: kobo(w.employer_cost),
}));

const PENSION_EMPLOYEE_BPS = 800n;
const PENSION_EMPLOYER_BPS = 1000n;
const NSITF_BPS = 100n;
const ITF_BPS = 100n;
const VAT_BPS = 750n;

describe("october 2026 golden fixture: payroll money shapes", () => {
  it("worker columns sum exactly to the totals", () => {
    expect(sumKobo(workers.map((w) => w.gross))).toBe(kobo(golden.totals.gross));
    expect(sumKobo(workers.map((w) => w.paye))).toBe(kobo(golden.totals.paye));
    expect(sumKobo(workers.map((w) => w.pensionEmployee))).toBe(
      kobo(golden.totals.pension_employee),
    );
    expect(sumKobo(workers.map((w) => w.net))).toBe(kobo(golden.totals.net));
    expect(sumKobo(workers.map((w) => w.employerCost))).toBe(kobo(golden.totals.employer_cost));
  });

  it.each(workers)("$name: gross - paye - employee pension = net", (w) => {
    expect(w.gross - w.paye - w.pensionEmployee).toBe(w.net);
  });

  it.each(workers)("$name: employee pension is 8% of gross", (w) => {
    expect(applyBps(w.gross, PENSION_EMPLOYEE_BPS)).toBe(w.pensionEmployee);
  });

  it.each(workers)("$name: employer cost = gross + 10% pension + 1% NSITF + 1% ITF", (w) => {
    expect(
      w.gross +
        applyBps(w.gross, PENSION_EMPLOYER_BPS) +
        applyBps(w.gross, NSITF_BPS) +
        applyBps(w.gross, ITF_BPS),
    ).toBe(w.employerCost);
  });

  it("statutory schedules match", () => {
    const pensionTotal = sumKobo(
      workers.map(
        (w) => applyBps(w.gross, PENSION_EMPLOYEE_BPS) + applyBps(w.gross, PENSION_EMPLOYER_BPS),
      ),
    );
    expect(pensionTotal).toBe(kobo(golden.statutory.pension_total));
    const totalGross = sumKobo(workers.map((w) => w.gross));
    expect(applyBps(totalGross, NSITF_BPS)).toBe(kobo(golden.statutory.nsitf));
    expect(applyBps(totalGross, ITF_BPS)).toBe(kobo(golden.statutory.itf));
  });
});

describe("october 2026 golden fixture: invoice money shapes", () => {
  it.each(golden.invoices)("$number: VAT is 7.5% of subtotal and subtotal + VAT = total", (inv) => {
    const subtotal = kobo(inv.subtotal);
    const vat = applyBps(subtotal, VAT_BPS);
    expect(vat).toBe(kobo(inv.vat));
    expect(subtotal + vat).toBe(kobo(inv.total));
  });

  it("converts fractional naira exactly", () => {
    const inv = golden.invoices.find((i) => i.number === "INV-0412");
    expect(inv).toBeDefined();
    expect(kobo(inv!.vat)).toBe(4481250n);
    expect(kobo(inv!.total)).toBe(64231250n);
  });

  it("formats INV-0412's total as in the design system voice example", () => {
    const inv = golden.invoices.find((i) => i.number === "INV-0412");
    expect(formatNaira(kobo(inv!.total))).toBe("₦642,312.50");
    expect(formatNaira(kobo(inv!.total), { whole: true })).toBe("₦642,313");
  });
});
