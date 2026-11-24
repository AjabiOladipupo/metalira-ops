import { z } from "zod";

import { formatDate } from "@/lib/dates";
import { formatLeaveRange } from "@/lib/leave/requests";
import { maskAccount, maskRsaPin } from "@/lib/mask";
import { formatNaira, sumKobo, toKobo, type Kobo } from "@/lib/money";

import { runMonth } from "./run-format";

/**
 * A payslip as the worker app and the PDF show it (slice 5.5; the WkPayslip board). Pure and
 * browser-safe. The database's `private.payslip_view` gives it as jsonb (kobo as strings of
 * digits); `parsePayslipView` checks it with Zod and turns kobo into `bigint` (never a `number`).
 *
 * Personal data (rule 9): only the last 4 digits of the bank account and RSA PIN ever reach
 * here, and they are shown masked (`••••7712`, `PEN••••4421`). No NIN, BVN, TIN or full number.
 */

const kobo = z
  .string()
  .regex(/^-?\d{1,18}$/)
  .transform((v) => toKobo(v));
const isoDate = z.iso.date();
const last4 = z
  .string()
  .regex(/^\d{4}$/)
  .nullable();

const lineSchema = z.object({
  position: z.number().int(),
  code: z.string(),
  kind: z.enum(["earning", "deduction", "statutory", "employer"]),
  label: z.string(),
  amount_kobo: kobo,
});

export const payslipViewSchema = z.object({
  payslip_id: z.uuid(),
  run_id: z.uuid(),
  worker_id: z.uuid(),
  run_status: z.string(),
  period_start: isoDate,
  period_end: isoDate,
  pay_date: isoDate,
  currency: z.literal("NGN"),
  gross_kobo: kobo,
  paye_kobo: kobo,
  pension_employee_kobo: kobo,
  pension_employer_kobo: kobo,
  nhf_kobo: kobo,
  other_deductions_kobo: kobo,
  net_kobo: kobo,
  carried_forward_kobo: kobo,
  nsitf_kobo: kobo,
  itf_kobo: kobo,
  employment_type: z.string(),
  tax_state: z.string().nullable(),
  pfa_name: z.string().nullable(),
  rule_set_name: z.string().nullable(),
  organisation: z.object({
    name: z.string(),
    legal_name: z.string().nullable(),
    address: z.string().nullable(),
    logo_path: z.string().nullable(),
  }),
  worker: z.object({
    first_name: z.string(),
    last_name: z.string(),
    staff_id: z.string(),
    job_title: z.string().nullable(),
    bank_name: z.string().nullable(),
    bank_account_last4: last4,
    rsa_pin_last4: last4,
  }),
  annual_rent_kobo: kobo.nullable(),
  lines: z.array(lineSchema),
  year_to_date: z.object({
    year: z.number().int(),
    payslips: z.number().int(),
    gross_kobo: kobo,
    paye_kobo: kobo,
    pension_employee_kobo: kobo,
    nhf_kobo: kobo,
    net_kobo: kobo,
  }),
  document: z.object({ id: z.uuid(), made_at: z.string() }).nullable(),
});

type Raw = z.output<typeof payslipViewSchema>;

export interface PayslipLineView {
  code: string;
  label: string;
  amountKobo: Kobo;
}

export interface PayslipView {
  payslipId: string;
  runId: string;
  workerId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  /** "October 2026": the run's name, from the period's end. */
  month: string;
  grossKobo: Kobo;
  payeKobo: Kobo;
  pensionEmployeeKobo: Kobo;
  pensionEmployerKobo: Kobo;
  nhfKobo: Kobo;
  otherDeductionsKobo: Kobo;
  netKobo: Kobo;
  carriedForwardKobo: Kobo;
  nsitfKobo: Kobo;
  itfKobo: Kobo;
  ruleSetName: string | null;
  pfaName: string | null;
  taxState: string | null;
  organisation: {
    name: string;
    legalName: string | null;
    address: string | null;
    logoPath: string | null;
  };
  worker: {
    name: string;
    staffId: string;
    jobTitle: string | null;
    bankName: string | null;
    bankLast4: string | null;
    rsaPinLast4: string | null;
  };
  annualRentKobo: Kobo | null;
  /** What you earned: earning lines, in order. A leave deduction shows as a negative earning. */
  earned: PayslipLineView[];
  /** Taken out: PAYE, pension, NHF, then other deductions, in order. */
  takenOut: PayslipLineView[];
  /** Your employer also paid: employer pension, NSITF, ITF. */
  employer: PayslipLineView[];
  totalTakenOutKobo: Kobo;
  yearToDate: {
    year: number;
    payslips: number;
    grossKobo: Kobo;
    payeKobo: Kobo;
    pensionEmployeeKobo: Kobo;
    nhfKobo: Kobo;
    netKobo: Kobo;
  };
  hasDocument: boolean;
}

/** The worker's words for a statutory or employer line: "Your pension, 8%". */
export function workerLineLabel(code: string, label: string): string {
  const rate = /(\d+(?:\.\d+)?%)/.exec(label)?.[1];
  const withRate = (words: string) => (rate ? `${words}, ${rate}` : words);
  switch (code) {
    case "paye":
      return "Income tax (PAYE)";
    case "pension_employee":
      return withRate("Your pension");
    case "nhf":
      return withRate("Housing fund (NHF)");
    case "pension_employer":
      return withRate("Pension");
    case "nsitf":
      return withRate("NSITF");
    case "itf":
      return withRate("ITF");
    default:
      return label;
  }
}

function toView(r: Raw): PayslipView {
  const line = (l: Raw["lines"][number]): PayslipLineView => ({
    code: l.code,
    label: workerLineLabel(l.code, l.label),
    amountKobo: l.amount_kobo,
  });
  const earned = r.lines.filter((l) => l.kind === "earning").map(line);
  const takenOut = [
    ...r.lines.filter((l) => l.kind === "statutory"),
    ...r.lines.filter((l) => l.kind === "deduction"),
  ].map(line);
  const employer = r.lines.filter((l) => l.kind === "employer").map(line);
  return {
    payslipId: r.payslip_id,
    runId: r.run_id,
    workerId: r.worker_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    payDate: r.pay_date,
    month: runMonth(r.period_end),
    grossKobo: r.gross_kobo,
    payeKobo: r.paye_kobo,
    pensionEmployeeKobo: r.pension_employee_kobo,
    pensionEmployerKobo: r.pension_employer_kobo,
    nhfKobo: r.nhf_kobo,
    otherDeductionsKobo: r.other_deductions_kobo,
    netKobo: r.net_kobo,
    carriedForwardKobo: r.carried_forward_kobo,
    nsitfKobo: r.nsitf_kobo,
    itfKobo: r.itf_kobo,
    ruleSetName: r.rule_set_name,
    pfaName: r.pfa_name,
    taxState: r.tax_state,
    organisation: {
      name: r.organisation.name,
      legalName: r.organisation.legal_name,
      address: r.organisation.address,
      logoPath: r.organisation.logo_path,
    },
    worker: {
      name: `${r.worker.first_name} ${r.worker.last_name}`.trim(),
      staffId: r.worker.staff_id,
      jobTitle: r.worker.job_title,
      bankName: r.worker.bank_name,
      bankLast4: r.worker.bank_account_last4,
      rsaPinLast4: r.worker.rsa_pin_last4,
    },
    annualRentKobo: r.annual_rent_kobo,
    earned,
    takenOut,
    employer,
    totalTakenOutKobo: sumKobo(takenOut.map((l) => l.amountKobo)),
    yearToDate: {
      year: r.year_to_date.year,
      payslips: r.year_to_date.payslips,
      grossKobo: r.year_to_date.gross_kobo,
      payeKobo: r.year_to_date.paye_kobo,
      pensionEmployeeKobo: r.year_to_date.pension_employee_kobo,
      nhfKobo: r.year_to_date.nhf_kobo,
      netKobo: r.year_to_date.net_kobo,
    },
    hasDocument: r.document !== null,
  };
}

/** One payslip from the database's jsonb. Throws if the shape is wrong. */
export function parsePayslipView(json: unknown): PayslipView {
  return toView(payslipViewSchema.parse(json));
}

/** A list of payslips (my_payslips, payslip_pdf_views). */
export function parsePayslipViews(json: unknown): PayslipView[] {
  return z.array(payslipViewSchema).parse(json).map(toView);
}

/** "₦104,740" for whole naira, "₦104,740.50" otherwise: the worker app's money. */
export function appNaira(k: Kobo): string {
  return k % 100n === 0n ? formatNaira(k, { whole: true }) : formatNaira(k);
}

/** "−₦5,660": what was taken out, with a true minus sign. */
export function lessNaira(k: Kobo, format: (k: Kobo) => string = appNaira): string {
  return k === 0n ? format(0n) : `−${format(k < 0n ? -k : k)}`;
}

/** Signed money: a leave deduction among earnings shows "−₦4,000". */
export function signedNaira(k: Kobo, format: (k: Kobo) => string = appNaira): string {
  return k < 0n ? lessNaira(-k, format) : format(k);
}

/** "Paid to GTBank ••••7712 on 25 Oct": the bank line, masked; null without bank details. */
export function paidToLine(view: PayslipView): string {
  const day = formatDate(view.payDate).replace(/ \d{4}$/, "");
  const masked = maskAccount(view.worker.bankLast4);
  if (!view.worker.bankName || !masked) return `Pay date ${day}`;
  return `Paid to ${view.worker.bankName} ${masked} on ${day}`;
}

/** "Your pension goes to Stanbic IBTC Pension · RSA PEN••••4421." or null when none is due. */
export function pensionLine(view: PayslipView): string | null {
  if (view.pensionEmployeeKobo === 0n && view.pensionEmployerKobo === 0n) return null;
  const pin = maskRsaPin(view.worker.rsaPinLast4);
  if (!view.pfaName) return "Your pension fund isn't on file yet. Ask HR.";
  return pin
    ? `Your pension goes to ${view.pfaName} · RSA ${pin}.`
    : `Your pension goes to ${view.pfaName}.`;
}

/**
 * "Tax uses your rent declaration of ₦360,000 a year." from the rent the tax used (the trace), or
 * null when none was declared. No estimate of the saving: the trace is the record.
 */
export function rentLine(view: PayslipView, format: (k: Kobo) => string = appNaira): string | null {
  if (view.annualRentKobo === null || view.annualRentKobo <= 0n) return null;
  return `Tax uses your rent declaration of ${format(view.annualRentKobo)} a year.`;
}

/** "20 Sep to 19 Oct 2026 · pay date 25 Oct 2026". */
export function periodLine(view: PayslipView): string {
  return `${formatLeaveRange(view.periodStart, view.periodEnd)} · pay date ${formatDate(view.payDate)}`;
}

/** The PDF's file name: "payslip-october-2026.pdf". No names or numbers. */
export function payslipFileName(view: Pick<PayslipView, "month">): string {
  return `payslip-${view.month.toLowerCase().replace(/\s+/g, "-")}.pdf`;
}
