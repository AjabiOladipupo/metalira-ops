import type { TraceStep } from "./trace";

/**
 * The contract between the two pure payroll stages (docs/PHASE_5.md "Calculation design"), fixed
 * so the earnings stage (5.1) and gross to net (5.0) could be built at the same time:
 *
 *   inputs (5.1) → computeEarnings (5.1) → EarningLine[] → grossToNet (5.0) → PayslipResult
 *
 * Every amount is integer kobo in a `bigint`; no `number` ever holds kobo.
 */

export type EarningCode =
  | "basic"
  | "housing"
  | "transport"
  | "other_allowances" // monthly salary, prorated
  | "daily_pay"
  | "hourly_pay"
  | "overtime"
  | "off_day"
  | "public_holiday"
  | "leave_deduction" // negative
  | "adjustment_earning"
  | "arrears";

/**
 * What a line pays, so a source is paid once (decision 10). The same shape as slice 5.1's
 * `earning-lines.ts`, so its earning lines pass straight in (5.2 keeps one definition):
 * a timesheet line by id; a leave request and the days of it a line covers; the salary days of a
 * pay version; an adjustment (5.2) by id.
 */
export type PaySourceRef =
  | { kind: "timesheet_line"; id: string; workDate: string }
  | { kind: "leave_request"; id: string; from: string; to: string }
  | { kind: "pay_rate"; id: string; from: string; to: string }
  | { kind: "adjustment"; id: string };

export interface EarningLine {
  code: EarningCode;
  /** "Overtime, 6 h 20 min at ₦750 an hour". */
  label: string;
  /** Rounded once; negative only for `leave_deduction`. */
  amountKobo: bigint;
  /** Counts toward the pension base (basic + housing + transport). */
  pensionable: boolean;
  /** Counts toward the NHF base (basic). */
  nhfBase: boolean;
  taxable: boolean;
  sources: PaySourceRef[];
}

/** An after-tax deduction (salary advance repayment, "2 of 3"), in the order it was added. */
export interface DeductionLine {
  label: string;
  amountKobo: bigint;
  sources: PaySourceRef[];
}

export type EmploymentType = "permanent" | "contract" | "casual" | "daily";

export interface GrossToNetInput {
  employmentType: EmploymentType;
  earnings: EarningLine[];
  nhfOptIn: boolean;
  /** Declared annual rent (rent relief). */
  annualRentKobo: bigint;
  /** After tax, in the order added. */
  deductions: DeductionLine[];
  /** Outstanding from earlier runs (open question 6's default). */
  carriedDeductionKobo: bigint;
}

/** Per-run choices the gross-to-net stage needs beyond the worker's input. */
export interface GrossToNetOptions {
  /** ITF accrues this run (open question 14: 5 or more workers in the levy base, or the owner's switch). */
  itfApplies: boolean;
  /** Steps from the earnings stage, continued by gross to net. */
  priorTrace?: TraceStep[];
}

export type PayslipLineKind = "earning" | "deduction" | "statutory" | "employer";

export type PayslipLineCode =
  | EarningCode
  | "paye"
  | "pension_employee"
  | "nhf"
  | "deduction"
  | "carried_deduction"
  | "pension_employer"
  | "nsitf"
  | "itf";

export interface PayslipLine {
  code: PayslipLineCode;
  kind: PayslipLineKind;
  label: string;
  /** Earnings as earned (a leave deduction negative); deductions and levies as positive amounts. */
  amountKobo: bigint;
  pensionable: boolean;
  taxable: boolean;
  sources: PaySourceRef[];
}

/**
 * Anomalies the engine itself raises; 5.2 adds the run-level ones (bank details, tax state and
 * so on) beside them.
 */
export type AnomalyCode =
  /** Other deductions were cut so net pay stays at ₦0 or more; the rest is carried (decision 6). */
  "deduction_cut";

export interface PayslipResult {
  grossKobo: bigint;
  payeKobo: bigint;
  pensionEmployeeKobo: bigint;
  nhfKobo: bigint;
  otherDeductionsKobo: bigint;
  netKobo: bigint;
  carriedForwardKobo: bigint;
  pensionEmployerKobo: bigint;
  nsitfKobo: bigint;
  itfKobo: bigint;
  employerCostKobo: bigint;
  lines: PayslipLine[];
  trace: TraceStep[];
  flags: AnomalyCode[];
}
