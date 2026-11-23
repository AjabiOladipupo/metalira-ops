/**
 * The stage contract between the earnings stage (slice 5.1, `earnings.ts`) and the gross-to-net
 * stage (slice 5.0, `gross-to-net.ts`), as fixed in docs/PHASE_5.md "Calculation design". Pure
 * types; isomorphic.
 *
 * Built in parallel with 5.0: when both land (slice 5.2), keep one definition of `EarningLine`
 * and `TraceStep` and import it from both stages.
 */

import type { Kobo } from "@/lib/money";

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
 * What a line pays, so a source is paid once (decision 10). Slice 5.2 records each as a payslip
 * source, unique while its payslip stands:
 * - a timesheet line (one approved day's line) by id;
 * - a leave request by id and the days of it this line covers (a request can cross two cycles);
 * - the salary days of a pay version (`from` to `to`, both inside the cycle), so an off-cycle run
 *   can't pay the same salary days twice;
 * - an adjustment (5.2) by id.
 */
export type PaySourceRef =
  | { kind: "timesheet_line"; id: string; workDate: string }
  | { kind: "leave_request"; id: string; from: string; to: string }
  | { kind: "pay_rate"; id: string; from: string; to: string }
  | { kind: "adjustment"; id: string };

export interface EarningLine {
  code: EarningCode;
  /** "Overtime, 6 h 20 min at ₦750.00 an hour". No names, no personal numbers. */
  label: string;
  /** Rounded once, half up. Negative only for leave_deduction. */
  amountKobo: Kobo;
  /** Counts toward basic + housing + transport. */
  pensionable: boolean;
  /** Counts toward basic (NHF). */
  nhfBase: boolean;
  taxable: boolean;
  sources: PaySourceRef[];
}

/**
 * One step of the explanation (docs/PHASE_5.md "Outputs"): stored as `{step, label, formula,
 * inputs, value_kobo, rule_ref}` with kobo as strings. Never names, account numbers, RSA PINs or
 * TINs.
 */
export interface TraceStep {
  step: string;
  label: string;
  formula: string;
  inputs: Record<string, string | number>;
  valueKobo: Kobo | null;
  ruleRef: string;
}
