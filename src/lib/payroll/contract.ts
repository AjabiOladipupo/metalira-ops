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
  | "arrears"
  | "leave_refund" // slice 5.7c: leave cancelled after a posted payslip deducted it
  | "clawback"; // slice 5.9a: a deduction correction of an overpaid earning, before tax (negative)

/**
 * Slice 5.9a (tax adviser, NSITF): regular monthly pay. Overtime, off-day and public-holiday
 * pay, bonuses and other one-off or irregular payments, arrears, refunds and clawbacks of earlier
 * months are irregular and stay out of the NSITF base. Derived from the line's code.
 */
export const REGULAR_EARNING_CODES: ReadonlySet<EarningCode> = new Set<EarningCode>([
  "basic",
  "housing",
  "transport",
  "other_allowances",
  "daily_pay",
  "hourly_pay",
  "leave_deduction",
]);

export function isRegularEarning(code: string): boolean {
  return REGULAR_EARNING_CODES.has(code as EarningCode);
}

/**
 * Whether an earning line is regular pay (NSITF's base): the line's own `regular` when the stage
 * that made it knew better (a refund of a regular leave deduction, a recurring allowance: money
 * review L4), else its code.
 */
export function isRegularLine(line: { code: string; regular?: boolean }): boolean {
  return line.regular ?? isRegularEarning(line.code);
}

/** Earning codes that may be negative (a reduction of pay): leave deductions and clawbacks. */
export function isNegativeEarning(code: string): boolean {
  return code === "leave_deduction" || code === "clawback";
}

/**
 * What a line pays, so a source is paid once (decision 10). The same shape as slice 5.1's
 * `earning-lines.ts`, so its earning lines pass straight in (5.2 keeps one definition):
 * a timesheet line by id; a leave request and the days of it a line covers; the salary days of a
 * pay version; an adjustment (5.2) by id.
 */
export type PaySourceRef =
  | {
      kind: "timesheet_line";
      id: string;
      workDate: string;
      /**
       * Paid as off-day work (the off-day rule; a monthly worker's day off, or a shift past
       * work_days_per_week). Stored on `payslip_sources.off_day` so arrears know the off days
       * already paid in a week (slice 5.2).
       */
      offDay?: boolean;
    }
  | { kind: "leave_request"; id: string; from: string; to: string }
  | { kind: "pay_rate"; id: string; from: string; to: string }
  | { kind: "adjustment"; id: string }
  /**
   * Slice 5.7c: a refund of leave cancelled after a posted payslip deducted it, naming the
   * deduction's exact days (paid once, as every source).
   */
  | { kind: "leave_refund"; id: string; from: string; to: string };

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
  /** Slice 5.9a: regular pay or not, when the code alone doesn't say (see `isRegularLine`). */
  regular?: boolean;
  /**
   * Slice 5.9a (money review M2): a recovery of an earlier overpayment before tax (a same-year
   * clawback or leave arrears). It is cut to what this month's pay can bear, and the rest is
   * carried forward after tax and flagged; it never blocks the run.
   */
  recovery?: boolean;
  /** Slice 5.9a (money review M6): the most a recovery may take before tax (the rest is carried). */
  recoveryCapKobo?: bigint;
  /**
   * Slice 5.10 (L3): recoveries sharing one cap (the clawbacks of one corrected payslip): the cap
   * is the group's, and each takes what the earlier ones left.
   */
  recoveryCapGroup?: string;
}

/** An after-tax deduction (salary advance repayment, "2 of 3"), in the order it was added. */
export interface DeductionLine {
  /**
   * `deduction` (an adjustment, the default) or `leave_arrears` (slice 5.7c: unpaid leave approved
   * after its period was posted, recovered after tax, RULES_NIGERIA open point 5's default).
   */
  code?: "deduction" | "leave_arrears";
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
  /**
   * Slice 5.9a: an NHF number is on file (NHF is taken only then, under the adviser's rules).
   * Left out: true.
   */
  nhfNumberOnFile?: boolean;
  /**
   * Slice 5.9a: verified annual reliefs on chargeable income (NHIS or NHIA contributions, life
   * assurance or deferred annuity premiums), counted only when the rule set allows them. Rent
   * relief stays `annualRentKobo` (the server passes only a verified rent under the adviser's
   * rules).
   */
  reliefs?: { nhisAnnualKobo: bigint; lifeAssuranceAnnualKobo: bigint };
  /**
   * Slice 5.9a (money review M3): rent relief for the months before the rule set required proof.
   * The declared rent counts for those `months` of the year so far (relief already given under
   * the earlier rule set stays); `annualRentKobo` (verified) counts for the whole year.
   */
  rentBeforeProof?: { annualRentKobo: bigint; months: number };
}

/** Per-run choices the gross-to-net stage needs beyond the worker's input. */
export interface GrossToNetOptions {
  /** ITF accrues this run (open question 14: 5 or more workers in the levy base, or the owner's switch). */
  itfApplies: boolean;
  /** The id of the rule set version used (null for the starting values not yet saved). */
  ruleSetId?: string | null;
  /** Steps from the earnings stage, continued by gross to net. */
  priorTrace?: TraceStep[];
  /**
   * Cumulative year-to-date PAYE (slice 5.9a, tax adviser): the worker's tax year so far. Left
   * out, this is the worker's first payslip of the year with nothing before it (one month
   * elapsed), which is exactly the month annualised.
   */
  yearToDate?: YearToDate;
  /**
   * Slice 5.9a: pension applies (the company has the rule set's minimum number of employees on
   * the pay date). Left out: true.
   */
  pensionApplies?: boolean;
  /**
   * Slice 5.9a: this is the worker's last payslip of the tax year (a December pay date, or a
   * leaver's final pay), so PAYE this payslip can't withhold needs settling at year end.
   */
  lastOfYear?: boolean;
}

/**
 * The worker's tax year before this payslip (slice 5.9a). The tax year is the calendar year of
 * the pay date. Months elapsed count from the later of 1 January, the worker's start date and the
 * company's payroll go-live month (1 January or the start date when an opening balance covers the
 * months before go-live) through the pay date's month.
 */
export interface YearToDate {
  /** Calendar months in the tax year so far, this payslip's month included (1 to 12). */
  monthsElapsed: number;
  /** "2026-10": the first month counted. */
  fromMonth: string;
  /** Standing (approved or released) payslips of the year counted, not this one. */
  payslips: number;
  /** Their gross pay (total income), summed. */
  grossKobo: bigint;
  /** Their chargeable pay (taxable pay less employee pension and NHF), summed. */
  chargeableKobo: bigint;
  /** The PAYE they withheld, summed. */
  payeKobo: bigint;
  /** The opening balance HR entered at go-live, if any (payroll_opening_balances). */
  opening: OpeningBalance | null;
  /** Ids of the verified relief declarations counted (for the trace and approval's check). */
  reliefIds?: readonly string[];
  /**
   * Slice 5.10 (M2): no opening balance, so the year counts from the worker's first payslip in
   * Metalira, later than 1 January and their start date (the run warns: no_opening_balance).
   */
  fromFirstPayslip?: boolean;
}

export interface OpeningBalance {
  id: string;
  /** "2026-09": the last month the balance covers. */
  asOfMonth: string;
  grossKobo: bigint;
  chargeableKobo: bigint;
  payeKobo: bigint;
  pensionKobo: bigint;
}

export type PayslipLineKind = "earning" | "deduction" | "statutory" | "employer";

export type PayslipLineCode =
  | EarningCode
  | "paye"
  | "pension_employee"
  | "nhf"
  | "deduction"
  | "carried_deduction"
  | "leave_arrears"
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
  /** Slice 5.9a: an earning line's regular flag (NSITF's base), stored on the line. */
  regular?: boolean;
}

/**
 * Anomalies the engine itself raises; 5.2 adds the run-level ones (bank details, tax state and
 * so on) beside them.
 */
export type AnomalyCode =
  /** Other deductions were cut so net pay stays at ₦0 or more; the rest is carried (decision 6). */
  | "deduction_cut"
  /** Slice 5.9a: other deductions were capped at a third of gross (Labour Act s.5(7)). */
  | "deduction_capped"
  /** Slice 5.9a: PAYE already withheld this year exceeds the tax due to date (not refunded). */
  | "paye_overwithheld"
  /** Slice 5.9a: opted in to NHF but no NHF number on file, or pay below the minimum wage. */
  | "nhf_not_deducted"
  /** Slice 5.9a (money review M2): PAYE above what the payslip can pay; caught up later. */
  | "paye_not_withheld"
  /** Slice 5.9a (money review M2): a recovery larger than this month's pay; the rest carried. */
  | "recovery_carried";

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
