/**
 * Slice 5.5: the payslip as the worker app shows it (src/lib/payroll/payslip-view.ts) and the
 * release notice (no amounts, inside the inbox rules).
 */
import { describe, expect, it } from "vitest";

import { hasPersonalNumberRun, inboxMessageSchema } from "@/lib/inbox";
import {
  appNaira,
  lessNaira,
  paidToLine,
  parsePayslipView,
  payslipFileName,
  pensionLine,
  rentLine,
  signedNaira,
  workerLineLabel,
} from "@/lib/payroll/payslip-view";
import { payslipNotice } from "@/server/payroll/payslip-documents";

function json(over: Record<string, unknown> = {}) {
  return {
    payslip_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    worker_id: "33333333-3333-4333-8333-333333333333",
    run_status: "released",
    period_start: "2026-09-20",
    period_end: "2026-10-19",
    pay_date: "2026-10-25",
    currency: "NGN",
    gross_kobo: "11600000",
    paye_kobo: "566000",
    pension_employee_kobo: "960000",
    pension_employer_kobo: "1200000",
    nhf_kobo: "0",
    other_deductions_kobo: "100000",
    net_kobo: "9974000",
    carried_forward_kobo: "0",
    nsitf_kobo: "116000",
    itf_kobo: "0",
    employment_type: "permanent",
    tax_state: "Lagos",
    pfa_name: "Stanbic IBTC Pension",
    rule_set_name: "NTA 2025 v1",
    organisation: { name: "Coastline", legal_name: null, address: null, logo_path: null },
    worker: {
      first_name: "Musa",
      last_name: "Ibrahim",
      staff_id: "MLS-0001",
      job_title: null,
      bank_name: "GTBank",
      bank_account_last4: "7712",
      rsa_pin_last4: "4421",
    },
    annual_rent_kobo: "36000000",
    lines: [
      { position: 1, code: "basic", kind: "earning", label: "Basic", amount_kobo: "6000000" },
      { position: 8, code: "housing", kind: "earning", label: "Housing", amount_kobo: "3600000" },
      {
        position: 9,
        code: "transport",
        kind: "earning",
        label: "Transport",
        amount_kobo: "2400000",
      },
      {
        position: 2,
        code: "leave_deduction",
        kind: "earning",
        label: "Unpaid leave",
        amount_kobo: "-400000",
      },
      { position: 3, code: "paye", kind: "statutory", label: "PAYE", amount_kobo: "566000" },
      {
        position: 4,
        code: "deduction",
        kind: "deduction",
        label: "Salary advance, 1 of 3",
        amount_kobo: "100000",
      },
      {
        position: 5,
        code: "pension_employee",
        kind: "statutory",
        label: "Employee pension 8%",
        amount_kobo: "960000",
      },
      {
        position: 6,
        code: "pension_employer",
        kind: "employer",
        label: "Employer pension 10%",
        amount_kobo: "1200000",
      },
      { position: 7, code: "nsitf", kind: "employer", label: "NSITF 1%", amount_kobo: "116000" },
    ],
    year_to_date: {
      year: 2026,
      payslips: 2,
      gross_kobo: "23600000",
      paye_kobo: "1132000",
      pension_employee_kobo: "1920000",
      nhf_kobo: "0",
      net_kobo: "20148100",
    },
    document: null,
    ...over,
  };
}

describe("payslip view", () => {
  const view = parsePayslipView(json());

  it("turns kobo strings into bigint, never numbers", () => {
    expect(view.netKobo).toBe(9_974_000n);
    expect(typeof view.grossKobo).toBe("bigint");
    expect(view.yearToDate.grossKobo).toBe(23_600_000n);
    expect(view.annualRentKobo).toBe(36_000_000n);
  });

  it("groups lines: earned in order, taken out statutory first, employer apart", () => {
    expect(view.earned.map((l) => l.code)).toEqual([
      "basic",
      "housing",
      "transport",
      "leave_deduction",
    ]);
    expect(view.takenOut.map((l) => l.code)).toEqual(["paye", "pension_employee", "deduction"]);
    expect(view.employer.map((l) => l.code)).toEqual(["pension_employer", "nsitf"]);
    expect(view.totalTakenOutKobo).toBe(566_000n + 960_000n + 100_000n);
  });

  it("uses the worker's words for statutory lines, with the rate", () => {
    expect(workerLineLabel("paye", "PAYE")).toBe("Income tax (PAYE)");
    expect(workerLineLabel("pension_employee", "Employee pension 8%")).toBe("Your pension, 8%");
    expect(workerLineLabel("pension_employer", "Employer pension 10%")).toBe("Pension, 10%");
    expect(workerLineLabel("nhf", "NHF 2.5%")).toBe("Housing fund (NHF), 2.5%");
    expect(workerLineLabel("deduction", "Salary advance, 1 of 3")).toBe("Salary advance, 1 of 3");
  });

  it("shows money as the board does", () => {
    expect(appNaira(10_474_000n)).toBe("₦104,740");
    expect(appNaira(10_474_050n)).toBe("₦104,740.50");
    expect(lessNaira(566_000n)).toBe("−₦5,660");
    expect(signedNaira(-400_000n)).toBe("−₦4,000");
    expect(signedNaira(6_000_000n)).toBe("₦60,000");
  });

  it("masks the bank account and RSA PIN from their last 4 digits", () => {
    expect(paidToLine(view)).toBe("Paid to GTBank ••••7712 on 25 Oct");
    expect(pensionLine(view)).toBe("Your pension goes to Stanbic IBTC Pension · RSA PEN••••4421.");
    const none = parsePayslipView(
      json({
        worker: {
          ...json().worker,
          bank_name: null,
          bank_account_last4: null,
          rsa_pin_last4: null,
        },
        pfa_name: null,
      }),
    );
    expect(paidToLine(none)).toBe("Pay date 25 Oct");
    expect(pensionLine(none)).toBe("Your pension fund isn't on file yet. Ask HR.");
  });

  it("refuses anything but last 4 digits for bank and RSA PIN", () => {
    expect(() =>
      parsePayslipView(json({ worker: { ...json().worker, bank_account_last4: "0123457712" } })),
    ).toThrow();
  });

  it("states the rent the tax used, or nothing without one", () => {
    expect(rentLine(view)).toBe("Tax uses your rent declaration of ₦360,000 a year.");
    expect(rentLine(parsePayslipView(json({ annual_rent_kobo: null })))).toBeNull();
    expect(rentLine(parsePayslipView(json({ annual_rent_kobo: "0" })))).toBeNull();
  });

  it("refuses lines that don't add up to the totals", () => {
    expect(() => parsePayslipView(json({ net_kobo: "9974050" }))).toThrow(/add up/);
    expect(() => parsePayslipView(json({ gross_kobo: "12000000" }))).toThrow(/add up/);
  });

  it("names the PDF by month only", () => {
    expect(payslipFileName(view)).toBe("payslip-october-2026.pdf");
  });
});

describe("release notice", () => {
  it("fits the inbox rules and carries no amounts or numbers", () => {
    const notice = payslipNotice("October 2026", "2026-10-25");
    expect(inboxMessageSchema.parse(notice)).toMatchObject({
      kind: "payslip",
      title: "Your October 2026 payslip is ready",
      link: "/m/payslips",
    });
    expect(`${notice.title} ${notice.body}`).not.toMatch(/₦|NGN|kobo/);
    expect(hasPersonalNumberRun(`${notice.title} ${notice.body}`)).toBe(false);
  });
});

describe("Ask HR", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("takes a plain question and refuses numbers, addresses and markup (4.6's rules)", async () => {
    const { askHrSchema } = await import("@/server/payroll/payslips");
    expect(askHrSchema.parse({ payslipId: id, question: "  Why is my tax up?\r\n" }).question).toBe(
      "Why is my tax up?",
    );
    for (const question of ["My account is 0123456789", "See acme-pay.com", "<b>hi</b>", "ok"]) {
      expect(askHrSchema.safeParse({ payslipId: id, question }).success, question).toBe(false);
    }
  });
});
