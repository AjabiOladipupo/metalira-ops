import { formatNaira, type Kobo } from "@/lib/money";

/**
 * The step-by-step trace of a payslip (slice 5.0; docs/PHASE_5.md "Outputs"). Pure.
 *
 * In memory a step has the same shape as slice 5.1's `earning-lines.ts` `TraceStep` (kobo as
 * `bigint`, camel case), so the earnings stage's steps and gross to net's form one list.
 * `storedTrace` gives the jsonb stored on `payslips.trace` (5.2): `{ trace_version, steps }`
 * with each step as `{step, label, formula, inputs, value_kobo, rule_ref}` and kobo as strings,
 * so the jsonb holds every bigint exactly. Never names, account numbers, RSA PINs or TINs.
 */

export const TRACE_VERSION = 1;

export type TraceStepId =
  // Earnings stage (5.1) steps keep their own ids; these are the gross-to-net ones.
  | "rule_set"
  | "gross"
  | "daily_worker"
  | "base_override"
  | "pension_base"
  | "pension_employee"
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
  /** Inputs: kobo as strings of digits, days, minutes, basis points; yes/no as "true"/"false". */
  inputs: Record<string, string | number>;
  /**
   * The step's value in kobo (rounded half up when the exact value is a fraction, which the
   * inputs then give exactly), or null for a step that holds no amount.
   */
  valueKobo: Kobo | null;
  /** Where the rule comes from: "RULES_NIGERIA PAYE", "PHASE_5 decision 6". */
  ruleRef: string;
}

/** A step as stored in `payslips.trace`. */
export interface StoredTraceStep {
  step: string;
  label: string;
  formula: string;
  inputs: Record<string, string | number>;
  value_kobo: string | null;
  rule_ref: string;
}

export interface StoredTrace {
  trace_version: number;
  steps: StoredTraceStep[];
}

/** Builds a step; `value` is kobo or null. */
export function traceStep(
  step: TraceStepId,
  label: string,
  formula: string,
  value: Kobo | null,
  ruleRef: string,
  inputs: Record<string, string | number | boolean> = {},
): TraceStep {
  const clean: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(inputs)) clean[k] = typeof v === "boolean" ? String(v) : v;
  return { step, label, formula, inputs: clean, valueKobo: value, ruleRef };
}

/** The jsonb for `payslips.trace`. */
export function storedTrace(steps: readonly TraceStep[]): StoredTrace {
  return {
    trace_version: TRACE_VERSION,
    steps: steps.map((s) => ({
      step: s.step,
      label: s.label,
      formula: s.formula,
      inputs: { ...s.inputs },
      value_kobo: s.valueKobo === null ? null : s.valueKobo.toString(),
      rule_ref: s.ruleRef,
    })),
  };
}

/** "₦120,000" for whole naira, "₦0.15" otherwise: the Explain panel's money. */
export function traceNaira(kobo: Kobo): string {
  return kobo % 100n === 0n ? formatNaira(kobo, { whole: true }) : formatNaira(kobo);
}

/** "-₦9,600" style signed value for a "Less ..." row. */
export function traceLess(kobo: Kobo): string {
  return kobo === 0n ? traceNaira(0n) : `-${traceNaira(kobo)}`;
}
