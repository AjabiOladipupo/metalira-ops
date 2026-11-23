import { formatNaira, type Kobo } from "@/lib/money";

/**
 * The step-by-step trace of a payslip (slice 5.0; docs/PHASE_5.md "Outputs"). Pure.
 *
 * Stored on `payslips.trace` (5.2) as `{ trace_version, steps }` and shown by the run's Explain
 * panel and summarised on the payslip. Each step says what was worked out, how, from which
 * inputs, the value in kobo and the rule it comes from. Kobo travel as strings so the jsonb
 * holds every bigint exactly. Never names, account numbers, RSA PINs or TINs.
 *
 * The earnings stage (5.1) adds its steps first; `grossToNet` continues the same list.
 */

export const TRACE_VERSION = 1;

export type TraceStepId =
  // Earnings stage (5.1) steps keep their own ids; these are the gross-to-net ones.
  | "earning"
  | "gross"
  | "daily_worker"
  | "pension_base"
  | "pension_employee"
  | "nhf_base"
  | "nhf"
  | "annual_gross"
  | "annual_pension"
  | "annual_nhf"
  | "rent_relief"
  | "taxable"
  | "paye_band"
  | "annual_tax"
  | "paye"
  | "net_before_deductions"
  | "deduction"
  | "carried_deduction"
  | "net"
  | "pension_employer"
  | "nsitf"
  | "itf"
  | "employer_cost"
  | (string & {});

export interface TraceStep {
  step: TraceStepId;
  /** What the Explain panel shows: "Less employee pension 8%". */
  label: string;
  /** How, in words and numbers: "₦120,000 × 8%". */
  formula: string;
  /** Inputs: kobo as strings of digits, days, minutes, basis points. */
  inputs: Record<string, string | number | boolean | null>;
  /**
   * The step's value in kobo, as a string (rounded half up when the exact value is a fraction),
   * or null for a step that counts days or minutes rather than money.
   */
  value_kobo: string | null;
  /** Where the rule comes from: "RULES_NIGERIA PAYE", "PHASE_5 decision 6". */
  rule_ref: string;
}

export interface Trace {
  trace_version: number;
  steps: TraceStep[];
}

/** Builds a step; `value` is kobo. */
export function traceStep(
  step: TraceStepId,
  label: string,
  formula: string,
  value: Kobo,
  ruleRef: string,
  inputs: TraceStep["inputs"] = {},
): TraceStep {
  return { step, label, formula, inputs, value_kobo: value.toString(), rule_ref: ruleRef };
}

/** "₦120,000" for whole naira, "₦0.15" otherwise: the Explain panel's money. */
export function traceNaira(kobo: Kobo): string {
  return kobo % 100n === 0n ? formatNaira(kobo, { whole: true }) : formatNaira(kobo);
}

/** "-₦9,600" style signed value for a "Less ..." row. */
export function traceLess(kobo: Kobo): string {
  return kobo === 0n ? traceNaira(0n) : `-${traceNaira(kobo)}`;
}

/** A step as the earnings stage (5.1) holds it in memory: kobo as `bigint`, camel case. */
export interface EarningsTraceStep {
  step: string;
  label: string;
  formula: string;
  inputs: Record<string, string | number>;
  valueKobo: Kobo | null;
  ruleRef: string;
}

/** The stored shape of an earnings-stage step, so gross to net can continue the same trace. */
export function fromEarningsStep(s: EarningsTraceStep): TraceStep {
  return {
    step: s.step,
    label: s.label,
    formula: s.formula,
    inputs: { ...s.inputs },
    value_kobo: s.valueKobo === null ? null : s.valueKobo.toString(),
    rule_ref: s.ruleRef,
  };
}
