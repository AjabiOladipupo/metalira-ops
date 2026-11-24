/**
 * Slice 5.5: the payslip PDF (docs/PHASE_5.md 5.5, decision 14). Musa Ibrahim's golden October
 * payslip, worked out by the engine and shaped as the database's payslip view gives it, renders
 * as a PDF whose text holds the golden figures (gross ₦120,000, PAYE ₦5,660, pension ₦9,600,
 * net ₦104,740), the masked bank account and RSA PIN only, the rent line and the rule set's name.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, type Kobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/contract";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import { parsePayslipView, type PayslipView } from "@/lib/payroll/payslip-view";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import { storedTrace } from "@/lib/payroll/trace";
import { renderPayslipPdf } from "@/server/payroll/payslip-pdf";

const kobo = (naira: number): Kobo => parseNairaToKobo(String(naira));
const musa = golden.workers.find((w) => w.name === "Musa Ibrahim")!;

function salary(grossKobo: Kobo): EarningLine[] {
  const [basic, housing, transport] = allocateKobo(grossKobo, [5n, 3n, 2n]);
  const line = (code: "basic" | "housing" | "transport", label: string, amount: Kobo) => ({
    code,
    label,
    amountKobo: amount,
    pensionable: true,
    nhfBase: code === "basic",
    taxable: true,
    sources: [],
  });
  return [
    line("basic", "Basic", basic!),
    line("housing", "Housing", housing!),
    line("transport", "Transport", transport!),
  ];
}

const result = grossToNet(
  {
    employmentType: "permanent",
    earnings: salary(kobo(musa.gross)),
    nhfOptIn: false,
    annualRentKobo: kobo(musa.annual_rent),
    deductions: [],
    carriedDeductionKobo: 0n,
  },
  NTA_2025_V1,
  { itfApplies: true },
);

/** The payslip view as private.payslip_view returns it for this result (kobo as strings). */
function musaViewJson(extra: { yearToDate?: Record<string, string | number> } = {}) {
  const trace = storedTrace(result.trace);
  const rent = trace.steps.find((st) => st.step === "rent_relief")?.inputs.annual_rent_kobo;
  return {
    payslip_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    worker_id: "33333333-3333-4333-8333-333333333333",
    run_status: "released",
    period_start: "2026-09-20",
    period_end: "2026-10-19",
    pay_date: "2026-10-25",
    currency: "NGN",
    gross_kobo: result.grossKobo.toString(),
    paye_kobo: result.payeKobo.toString(),
    pension_employee_kobo: result.pensionEmployeeKobo.toString(),
    pension_employer_kobo: result.pensionEmployerKobo.toString(),
    nhf_kobo: result.nhfKobo.toString(),
    other_deductions_kobo: result.otherDeductionsKobo.toString(),
    net_kobo: result.netKobo.toString(),
    carried_forward_kobo: result.carriedForwardKobo.toString(),
    nsitf_kobo: result.nsitfKobo.toString(),
    itf_kobo: result.itfKobo.toString(),
    employment_type: "permanent",
    tax_state: "Lagos",
    pfa_name: "Stanbic IBTC Pension",
    rule_set_name: NTA_2025_V1.name,
    organisation: {
      name: "Coastline Guards",
      legal_name: "Coastline Guards Limited",
      address: "12 Marina, Lagos",
      logo_path: null,
    },
    worker: {
      first_name: "Musa",
      last_name: "Ibrahim",
      staff_id: "MLS-0001",
      job_title: "Guard",
      bank_name: "GTBank",
      bank_account_last4: "7712",
      rsa_pin_last4: "4421",
    },
    annual_rent_kobo: typeof rent === "string" ? rent : null,
    lines: result.lines.map((l, i) => ({
      position: i + 1,
      code: l.code,
      kind: l.kind,
      label: l.label,
      amount_kobo: l.amountKobo.toString(),
    })),
    year_to_date: {
      year: 2026,
      payslips: 10,
      gross_kobo: "120000000",
      paye_kobo: "5660000",
      pension_employee_kobo: "9600000",
      nhf_kobo: "0",
      net_kobo: "104740000",
      ...extra.yearToDate,
    },
    document: null,
  };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  await doc.destroy();
  // One space between words, whatever the PDF's runs were.
  return parts.join(" ").replace(/\s+/g, " ");
}

describe("payslip PDF", () => {
  let view: PayslipView;
  let text: string;
  let bytes: Uint8Array;

  it("renders Musa Ibrahim's golden payslip as a PDF", async () => {
    view = parsePayslipView(musaViewJson());
    bytes = await renderPayslipPdf(view, { madeOn: "2026-10-25" });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
    text = await pdfText(bytes);
  }, 30_000);

  it("shows the golden figures to the kobo", () => {
    expect(text).toContain("₦104,740.00"); // You received
    expect(text).toContain("₦120,000.00"); // Gross pay
    expect(text).toContain("−₦5,660.00"); // Income tax (PAYE)
    expect(text).toContain("−₦9,600.00"); // Your pension, 8%
    expect(text).toContain("−₦15,260.00"); // Total taken out
    expect(text).toContain("₦12,000.00"); // Employer pension 10%
    expect(text).toContain("₦60,000.00");
    expect(text).toContain("₦36,000.00");
    expect(text).toContain("₦24,000.00");
  });

  it("shows this year so far from the year-to-date figures, not the month's", () => {
    expect(text).toContain("₦1,200,000.00");
    expect(text).toContain("₦56,600.00");
    expect(text).toContain("₦96,000.00");
  });

  it("names the sections, the company, the period, the pay date and the rule set", () => {
    for (const words of [
      "Coastline Guards",
      "Payslip",
      "October 2026",
      "20 Sep to 19 Oct 2026",
      "25 Oct 2026",
      "What you earned",
      "Taken out",
      "Your employer also paid",
      "This year so far",
      "Income tax (PAYE)",
      "Your pension, 8%",
      "Tax uses your rent declaration of ₦360,000.00 a year.",
      `Worked out with the payroll rules ${NTA_2025_V1.name}.`,
    ]) {
      // Section labels are set in capitals (DESIGN_SYSTEM label style).
      expect(text.toLowerCase(), words).toContain(words.toLowerCase());
    }
  });

  it("masks the bank account and RSA PIN and holds no full number", () => {
    expect(text).toContain("GTBank ••••7712");
    expect(text).toContain("PEN••••4421");
    // No run of 10 or more digits anywhere (account numbers, NIN, BVN, RSA PIN, phone).
    expect(text.replace(/[,.]/g, "")).not.toMatch(/\d{10,}/);
  });

  it("never carries the tax adviser line (owner decision, slice 5.8: managers only)", () => {
    expect(text.toLowerCase()).not.toContain("tax adviser");
  });

  it("is the same figures the view gives", () => {
    expect(view.netKobo).toBe(kobo(musa.net));
    expect(view.payeKobo).toBe(kobo(musa.paye));
    expect(view.pensionEmployeeKobo).toBe(kobo(musa.pension_employee));
    expect(view.totalTakenOutKobo).toBe(kobo(musa.paye) + kobo(musa.pension_employee));
  });
});
