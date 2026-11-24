/**
 * The payroll run (slice 5.2, docs/PHASE_5.md 5.2): the pure part. Pure and isomorphic; the
 * server (`src/server/payroll/run.ts`) gathers the inputs, calls these and saves the results
 * through `save_payroll_results`, which checks every invariant again in SQL.
 *
 * - `workerPayslip`: one worker's earnings stage (5.1) plus the run's adjustments, then gross to
 *   net (5.0), with the rule set the run snapshotted (decision 15).
 * - `workerAnomalies` / `runAnomalies`: what looks wrong, worked out at each recalculation. The
 *   detail documents hold no personal numbers (no account numbers, RSA PINs, TINs, NINs, kobo
 *   amounts): ids, dates, counts and percentages.
 * - `canonicalJson`: key-sorted JSON, so the inputs hash ignores key order.
 * - `runTotals` and `resultsPayload`: the totals and the jsonb `save_payroll_results` takes.
 *
 * Money is `bigint` kobo throughout; kobo leave this file only as strings of digits.
 */

import { sumKobo, type Kobo } from "@/lib/money";

import type {
  DeductionLine,
  EarningLine,
  EmploymentType,
  PaySourceRef,
  PayslipResult,
} from "./contract";
import type { EarningsFlag, EarningsResult } from "./earnings";
import { grossToNet, PayrollInputError } from "./gross-to-net";
import type { RuleSet } from "./rule-set";
import { storedTrace, traceStep, type StoredTrace } from "./trace";

// ---------------------------------------------------------------------------
// Adjustments in the engine
// ---------------------------------------------------------------------------

/** A one-off or recurring earning or deduction on the run (`payroll_adjustments`). */
export interface RunAdjustment {
  id: string;
  workerId: string;
  kind: "earning" | "deduction";
  label: string;
  amountKobo: Kobo;
  pensionable: boolean;
  taxable: boolean;
  instalmentNumber: number;
  instalmentCount: number;
}

/** "Supervisor allowance", or "Salary advance repayment, 2 of 3" for a recurring item. */
export function adjustmentLabel(
  a: Pick<RunAdjustment, "label" | "instalmentNumber" | "instalmentCount">,
): string {
  return a.instalmentCount > 1
    ? `${a.label}, ${a.instalmentNumber} of ${a.instalmentCount}`
    : a.label;
}

/**
 * The adjustments as engine lines: earnings join the earning lines (taxable, pensionable only when
 * HR marked it, never in the NHF base); deductions come off after tax, in the order added.
 */
export function adjustmentLines(adjustments: readonly RunAdjustment[]): {
  earnings: EarningLine[];
  deductions: DeductionLine[];
} {
  const earnings: EarningLine[] = [];
  const deductions: DeductionLine[] = [];
  for (const a of adjustments) {
    const sources: PaySourceRef[] = [{ kind: "adjustment", id: a.id }];
    if (a.kind === "earning") {
      earnings.push({
        code: "adjustment_earning",
        label: adjustmentLabel(a),
        amountKobo: a.amountKobo,
        pensionable: a.pensionable,
        nhfBase: false,
        taxable: a.taxable,
        sources,
      });
    } else {
      deductions.push({ label: adjustmentLabel(a), amountKobo: a.amountKobo, sources });
    }
  }
  return { earnings, deductions };
}

export interface WorkerPayslipInput {
  employmentType: EmploymentType;
  earnings: EarningsResult;
  adjustments: readonly RunAdjustment[];
  nhfOptIn: boolean;
  annualRentKobo: Kobo;
  /** Outstanding from the worker's latest posted payslip (open question 6). */
  carriedDeductionKobo: Kobo;
}

export interface WorkerPayslipOptions {
  itfApplies: boolean;
  ruleSetId: string;
}

/** One worker's payslip: the earnings stage's lines and trace, the adjustments, gross to net. */
export function workerPayslip(
  input: WorkerPayslipInput,
  rules: RuleSet,
  options: WorkerPayslipOptions,
): PayslipResult {
  const adj = adjustmentLines(input.adjustments);
  const priorTrace = [...input.earnings.trace];
  for (const e of adj.earnings) {
    priorTrace.push(
      traceStep(
        "adjustment_earning",
        e.label,
        `Added by HR: taxable ${e.taxable ? "yes" : "no"}, pensionable ${e.pensionable ? "yes" : "no"}`,
        e.amountKobo,
        "PHASE_5 open question 12",
      ),
    );
  }
  return grossToNet(
    {
      employmentType: input.employmentType,
      earnings: [...input.earnings.lines, ...adj.earnings],
      nhfOptIn: input.nhfOptIn,
      annualRentKobo: input.annualRentKobo,
      deductions: adj.deductions,
      carriedDeductionKobo: input.carriedDeductionKobo,
    },
    rules,
    { itfApplies: options.itfApplies, ruleSetId: options.ruleSetId, priorTrace },
  );
}

/**
 * ITF applies when the run has `minStaff` (5) or more workers in the levy base (open question
 * 14's default): workers with pay this run who aren't exempt daily workers.
 */
export function itfAppliesTo(
  workers: readonly { employmentType: EmploymentType; grossKobo: Kobo }[],
  rules: RuleSet,
): boolean {
  const base = workers.filter(
    (w) => w.grossKobo > 0n && !(w.employmentType === "daily" && rules.rules.dailyWorkersExempt),
  ).length;
  return base >= rules.rules.itf.minStaff;
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

export type AnomalySeverity = "blocking" | "warning";

export type AnomalyCode =
  | "no_pay_rate"
  | "no_rostered_days"
  | "no_tax_state"
  | "calculation_failed"
  | "previous_not_posted"
  | "roster_pattern_unknown"
  | "leave_pay_missing"
  | "open_timesheet_days"
  | "no_show_days"
  | "bank_missing"
  | "bank_in_hold"
  | "bank_not_checked"
  | "bank_unreadable"
  | "bank_shared"
  | "bank_shared_unchecked"
  | "first_pay"
  | "final_pay"
  | "net_change"
  | "deduction_cut"
  | "no_pension_details"
  | "recurring_not_carried";

/** Blocking anomalies are fixed, never acknowledged (MUST 4: no_rostered_days blocks). */
export const ANOMALY_SEVERITY: Record<AnomalyCode, AnomalySeverity> = {
  no_pay_rate: "blocking",
  no_rostered_days: "blocking",
  no_tax_state: "blocking",
  calculation_failed: "blocking",
  previous_not_posted: "blocking",
  roster_pattern_unknown: "warning",
  leave_pay_missing: "warning",
  open_timesheet_days: "warning",
  no_show_days: "warning",
  bank_missing: "warning",
  bank_in_hold: "warning",
  bank_not_checked: "warning",
  bank_unreadable: "warning",
  bank_shared: "warning",
  bank_shared_unchecked: "warning",
  first_pay: "warning",
  final_pay: "warning",
  net_change: "warning",
  deduction_cut: "warning",
  no_pension_details: "warning",
  recurring_not_carried: "warning",
};

export type AnomalyDetail = Record<string, string | number | boolean | string[]>;

export interface RunAnomaly {
  workerId: string | null;
  code: AnomalyCode;
  severity: AnomalySeverity;
  detail: AnomalyDetail;
}

function anomaly(
  code: AnomalyCode,
  workerId: string | null,
  detail: AnomalyDetail = {},
): RunAnomaly {
  return { workerId, code, severity: ANOMALY_SEVERITY[code], detail };
}

/** A worker's bank details as the server found them; never the number itself. */
export interface BankState {
  /** No bank account on file. */
  missing: boolean;
  /** A bank-detail change waiting for a second approver, or approved and inside the 72-hour hold. */
  inHold: boolean;
  /** When the hold ends (ISO), if a change is approved. */
  holdEndsAt: string | null;
  /** Details from the first import nobody checked against the bank ("Not checked"). */
  notChecked: boolean;
  /** The stored number couldn't be decrypted, so the shared-account check skipped it. */
  unreadable: boolean;
}

export interface WorkerAnomalyInput {
  workerId: string;
  employmentType: EmploymentType;
  startDate: string;
  endDate: string | null;
  period: { start: string; end: string };
  taxState: string | null;
  pfaName: string | null;
  hasRsaPin: boolean;
  earningsFlags: readonly EarningsFlag[];
  noShowDates: readonly string[];
  /** Null when the engine refused the worker (calculation_failed). */
  payslip: PayslipResult | null;
  bank: BankState | null;
  /** Net of the worker's latest posted payslip, if any. */
  previousNetKobo: Kobo | null;
  /** True when the worker has a posted payslip already. */
  paidBefore: boolean;
  rules: RuleSet;
}

/** Percent change, rounded half away from zero to a whole percent (display only). */
export function percentChange(before: Kobo, after: Kobo): number {
  if (before === 0n) return after === 0n ? 0 : 100;
  const diff = after - before;
  const abs = diff < 0n ? -diff : diff;
  const whole = (abs * 200n + before) / (before * 2n);
  return Number(diff < 0n ? -whole : whole);
}

/** More than 10% either way (the plan's "net change" choice). */
export function netChangeOverTenPercent(before: Kobo, after: Kobo): boolean {
  if (before <= 0n) return false;
  const diff = after - before;
  const abs = diff < 0n ? -diff : diff;
  return abs * 10n > before;
}

/** A worker's anomalies, in a stable order. */
export function workerAnomalies(w: WorkerAnomalyInput): RunAnomaly[] {
  const out: RunAnomaly[] = [];
  const flags = new Set(w.earningsFlags);
  const exempt = w.employmentType === "daily" && w.rules.rules.dailyWorkersExempt;
  const slip = w.payslip;

  if (flags.has("no_pay_rate")) out.push(anomaly("no_pay_rate", w.workerId));
  if (flags.has("no_rostered_days")) out.push(anomaly("no_rostered_days", w.workerId));
  if (!slip) out.push(anomaly("calculation_failed", w.workerId));
  if (slip && !exempt && slip.grossKobo > 0n && !w.taxState) {
    out.push(anomaly("no_tax_state", w.workerId));
  }
  if (flags.has("roster_pattern_unknown")) out.push(anomaly("roster_pattern_unknown", w.workerId));
  if (flags.has("leave_pay_missing")) out.push(anomaly("leave_pay_missing", w.workerId));
  if (w.noShowDates.length > 0) {
    out.push(
      anomaly("no_show_days", w.workerId, {
        days: w.noShowDates.length,
        dates: [...w.noShowDates],
      }),
    );
  }
  if (slip && slip.netKobo > 0n && w.bank) {
    if (w.bank.missing) out.push(anomaly("bank_missing", w.workerId));
    else {
      if (w.bank.inHold) {
        out.push(
          anomaly(
            "bank_in_hold",
            w.workerId,
            w.bank.holdEndsAt ? { ends_at: w.bank.holdEndsAt } : {},
          ),
        );
      }
      if (w.bank.notChecked) out.push(anomaly("bank_not_checked", w.workerId));
      if (w.bank.unreadable) out.push(anomaly("bank_unreadable", w.workerId));
    }
  }
  if (!w.paidBefore && w.startDate >= w.period.start && w.startDate <= w.period.end) {
    out.push(anomaly("first_pay", w.workerId, { start_date: w.startDate }));
  }
  if (w.endDate !== null && w.endDate >= w.period.start && w.endDate <= w.period.end) {
    out.push(anomaly("final_pay", w.workerId, { end_date: w.endDate }));
  }
  if (
    slip &&
    w.previousNetKobo !== null &&
    netChangeOverTenPercent(w.previousNetKobo, slip.netKobo)
  ) {
    out.push(
      anomaly("net_change", w.workerId, {
        percent: percentChange(w.previousNetKobo, slip.netKobo),
      }),
    );
  }
  if (slip && slip.flags.includes("deduction_cut")) out.push(anomaly("deduction_cut", w.workerId));
  if (slip && slip.pensionEmployeeKobo > 0n && (!w.pfaName || !w.hasRsaPin)) {
    out.push(
      anomaly("no_pension_details", w.workerId, { no_pfa: !w.pfaName, no_rsa_pin: !w.hasRsaPin }),
    );
  }
  return out;
}

/** Open (pending or disputed) timesheet days at one site in the period. */
export interface OpenDaysAtSite {
  siteId: string | null;
  days: number;
  reasons: string[];
}

/**
 * Run-level anomalies: open timesheet days by site ("5 timesheets still block this run",
 * acknowledged per site as "pay next run") and groups of workers sharing one account number
 * (worker ids only; the server compared the numbers in memory).
 */
export function runAnomalies(
  openDays: readonly OpenDaysAtSite[],
  sharedAccounts: readonly (readonly string[])[],
): RunAnomaly[] {
  const out: RunAnomaly[] = [];
  // The site's name isn't stored (the screen reads it by id), so free text never reaches the
  // detail document.
  for (const site of [...openDays].sort((a, b) => (a.siteId ?? "").localeCompare(b.siteId ?? ""))) {
    out.push(
      anomaly("open_timesheet_days", null, {
        ...(site.siteId ? { site_id: site.siteId } : {}),
        days: site.days,
        reasons: [...site.reasons].sort(),
      }),
    );
  }
  for (const group of sharedAccounts) {
    const ids = [...group].sort();
    out.push(
      anomaly("bank_shared", null, {
        worker_ids: ids.slice(0, SHARED_IDS_SHOWN),
        workers: ids.length,
      }),
    );
  }
  return out;
}

/** A shared-account anomaly names at most this many workers (and gives the full count). */
export const SHARED_IDS_SHOWN = 20;

/** The latest posted payslip's figures for one worker. */
export interface PostedSlip {
  netKobo: Kobo;
  carriedForwardKobo: Kobo;
}

/** The regular run of the period just before this one, if there is one. */
export interface PreviousPeriodRun {
  periodStart: string;
  posted: boolean;
  slips: ReadonlyMap<string, PostedSlip>;
}

/**
 * What a worker brings from earlier runs (open question 6, money review M3): the net of their
 * payslip in the period just before (for the 10% check) only when that run is posted, and the
 * carried deduction from that payslip, else from their own latest posted payslip, so a carry is
 * never lost when they had no payslip in the period before.
 */
export function workerHistory(
  workerId: string,
  previous: PreviousPeriodRun | null,
  latestPosted: ReadonlyMap<string, PostedSlip>,
): { previousNetKobo: Kobo | null; carriedKobo: Kobo; paidBefore: boolean } {
  const prev = previous?.posted ? previous.slips.get(workerId) : undefined;
  const own = latestPosted.get(workerId);
  return {
    previousNetKobo: prev?.netKobo ?? null,
    carriedKobo: prev ? prev.carriedForwardKobo : (own?.carriedForwardKobo ?? 0n),
    paidBefore: own !== undefined || prev !== undefined,
  };
}

/**
 * "Previous period not posted" (blocking): the period before has a run that isn't approved yet,
 * so this run can't know what it carries or how far net pay moved.
 */
export function previousPeriodAnomalies(previous: PreviousPeriodRun | null): RunAnomaly[] {
  return previous && !previous.posted
    ? [anomaly("previous_not_posted", null, { period_start: previous.periodStart })]
    : [];
}

/** A recurring adjustment of the period before whose next instalment isn't on this run. */
export interface RecurringSeries {
  seriesId: string;
  workerId: string;
  instalmentNumber: number;
  instalmentCount: number;
}

/**
 * Recurring items not carried (money review L4): instalments are carried only from posted runs
 * (create_payroll_run), so a change to an unposted run can never pay twice; any series of the
 * period before with instalments left and no next instalment here is flagged for HR to add.
 */
export function recurringAnomalies(
  previous: readonly RecurringSeries[],
  carriedSeries: ReadonlySet<string>,
): RunAnomaly[] {
  return previous
    .filter((s) => s.instalmentNumber < s.instalmentCount && !carriedSeries.has(s.seriesId))
    .map((s) =>
      anomaly("recurring_not_carried", s.workerId, {
        series_id: s.seriesId,
        next: s.instalmentNumber + 1,
        of: s.instalmentCount,
      }),
    );
}

/** Groups of worker ids holding the same value (account numbers compared in memory only). */
export function sharedGroups(values: ReadonlyMap<string, string>): string[][] {
  const byValue = new Map<string, string[]>();
  for (const [workerId, value] of values) {
    byValue.set(value, [...(byValue.get(value) ?? []), workerId]);
  }
  return [...byValue.values()].filter((ids) => ids.length > 1).map((ids) => ids.sort());
}

// ---------------------------------------------------------------------------
// Canonical inputs and totals
// ---------------------------------------------------------------------------

/**
 * JSON with object keys sorted at every depth, so the same inputs hash the same whatever order
 * the database or the server built them in (decision 7). Bigints become strings of digits.
 */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[key];
        if (inner !== undefined) out[key] = norm(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export interface RunTotals {
  grossKobo: Kobo;
  payeKobo: Kobo;
  pensionEmployeeKobo: Kobo;
  pensionEmployerKobo: Kobo;
  nhfKobo: Kobo;
  otherDeductionsKobo: Kobo;
  netKobo: Kobo;
  nsitfKobo: Kobo;
  itfKobo: Kobo;
  employerCostKobo: Kobo;
  carriedForwardKobo: Kobo;
  workerCount: number;
}

export function runTotals(payslips: readonly PayslipResult[]): RunTotals {
  const s = (pick: (p: PayslipResult) => Kobo) => sumKobo(payslips.map(pick));
  return {
    grossKobo: s((p) => p.grossKobo),
    payeKobo: s((p) => p.payeKobo),
    pensionEmployeeKobo: s((p) => p.pensionEmployeeKobo),
    pensionEmployerKobo: s((p) => p.pensionEmployerKobo),
    nhfKobo: s((p) => p.nhfKobo),
    otherDeductionsKobo: s((p) => p.otherDeductionsKobo),
    netKobo: s((p) => p.netKobo),
    nsitfKobo: s((p) => p.nsitfKobo),
    itfKobo: s((p) => p.itfKobo),
    employerCostKobo: s((p) => p.employerCostKobo),
    carriedForwardKobo: s((p) => p.carriedForwardKobo),
    workerCount: payslips.length,
  };
}

// ---------------------------------------------------------------------------
// The results payload for save_payroll_results
// ---------------------------------------------------------------------------

export interface WorkerResult {
  workerId: string;
  employmentType: EmploymentType;
  taxState: string | null;
  pfaName: string | null;
  earnings: EarningsResult;
  payslip: PayslipResult;
}

interface StoredSource {
  kind: PaySourceRef["kind"];
  id: string;
  from: string;
  to: string;
  off_day: boolean;
}

function storedSource(ref: PaySourceRef, period: { start: string; end: string }): StoredSource {
  switch (ref.kind) {
    case "timesheet_line":
      return {
        kind: ref.kind,
        id: ref.id,
        from: ref.workDate,
        to: ref.workDate,
        off_day: ref.offDay === true,
      };
    case "leave_request":
    case "pay_rate":
      return { kind: ref.kind, id: ref.id, from: ref.from, to: ref.to, off_day: false };
    case "adjustment":
      return { kind: ref.kind, id: ref.id, from: period.start, to: period.end, off_day: false };
  }
}

const koboText = (k: Kobo) => k.toString();

export interface ResultsPayload {
  itf_applies: boolean;
  totals: Record<string, string | number>;
  payslips: {
    worker_id: string;
    employment_type: EmploymentType;
    tax_state: string | null;
    pfa_name: string | null;
    pay_rate_ids: string[];
    days: { cycle: number; rostered: number; employed_rostered: number; leave_deducted: number };
    gross_kobo: string;
    paye_kobo: string;
    pension_employee_kobo: string;
    nhf_kobo: string;
    other_deductions_kobo: string;
    net_kobo: string;
    carried_forward_kobo: string;
    pension_employer_kobo: string;
    nsitf_kobo: string;
    itf_kobo: string;
    employer_cost_kobo: string;
    trace: StoredTrace;
    lines: {
      code: string;
      kind: string;
      label: string;
      amount_kobo: string;
      pensionable: boolean;
      taxable: boolean;
      sources: StoredSource[];
    }[];
  }[];
  anomalies: { worker_id: string | null; code: string; severity: string; detail: AnomalyDetail }[];
}

/** The jsonb `save_payroll_results` takes: kobo as strings, the trace as stored. */
export function resultsPayload(
  period: { start: string; end: string },
  workers: readonly WorkerResult[],
  anomalies: readonly RunAnomaly[],
  itfApplies: boolean,
): ResultsPayload {
  const totals = runTotals(workers.map((w) => w.payslip));
  return {
    itf_applies: itfApplies,
    totals: {
      gross_kobo: koboText(totals.grossKobo),
      paye_kobo: koboText(totals.payeKobo),
      pension_employee_kobo: koboText(totals.pensionEmployeeKobo),
      pension_employer_kobo: koboText(totals.pensionEmployerKobo),
      nhf_kobo: koboText(totals.nhfKobo),
      other_deductions_kobo: koboText(totals.otherDeductionsKobo),
      net_kobo: koboText(totals.netKobo),
      nsitf_kobo: koboText(totals.nsitfKobo),
      itf_kobo: koboText(totals.itfKobo),
      employer_cost_kobo: koboText(totals.employerCostKobo),
      carried_forward_kobo: koboText(totals.carriedForwardKobo),
      worker_count: totals.workerCount,
    },
    payslips: workers.map((w) => ({
      worker_id: w.workerId,
      employment_type: w.employmentType,
      tax_state: w.taxState,
      pfa_name: w.pfaName,
      pay_rate_ids: [...w.earnings.payRateIds],
      days: {
        cycle: w.earnings.days.cycle,
        rostered: w.earnings.days.rostered,
        employed_rostered: w.earnings.days.employedRostered,
        leave_deducted: w.earnings.days.leaveDeducted,
      },
      gross_kobo: koboText(w.payslip.grossKobo),
      paye_kobo: koboText(w.payslip.payeKobo),
      pension_employee_kobo: koboText(w.payslip.pensionEmployeeKobo),
      nhf_kobo: koboText(w.payslip.nhfKobo),
      other_deductions_kobo: koboText(w.payslip.otherDeductionsKobo),
      net_kobo: koboText(w.payslip.netKobo),
      carried_forward_kobo: koboText(w.payslip.carriedForwardKobo),
      pension_employer_kobo: koboText(w.payslip.pensionEmployerKobo),
      nsitf_kobo: koboText(w.payslip.nsitfKobo),
      itf_kobo: koboText(w.payslip.itfKobo),
      employer_cost_kobo: koboText(w.payslip.employerCostKobo),
      trace: storedTrace(w.payslip.trace),
      lines: w.payslip.lines.map((l) => ({
        code: l.code,
        kind: l.kind,
        label: l.label,
        amount_kobo: koboText(l.amountKobo),
        pensionable: l.pensionable,
        taxable: l.taxable,
        sources: l.sources.map((s) => storedSource(s, period)),
      })),
    })),
    anomalies: anomalies.map((a) => ({
      worker_id: a.workerId,
      code: a.code,
      severity: a.severity,
      detail: a.detail,
    })),
  };
}

export { PayrollInputError };
