/**
 * Display helpers for payroll runs (slice 5.2). Pure.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The run's name from its period end: "October 2026" for 20 Sep to 19 Oct 2026. */
export function runMonth(periodEnd: string): string {
  const [y, m] = periodEnd.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export type RunStatusName = "draft" | "review" | "approved" | "released";
export type RunStatusTone = "done" | "pending" | "partial" | "action";

export const RUN_STATUS: Record<RunStatusName, { label: string; tone: RunStatusTone }> = {
  draft: { label: "Draft", tone: "pending" },
  review: { label: "Waiting for approval", tone: "action" },
  approved: { label: "Approved", tone: "done" },
  released: { label: "Released", tone: "done" },
};

export const RUN_STEPS = [
  { id: "period", label: "Period" },
  { id: "timesheets", label: "Timesheets" },
  { id: "earnings", label: "Earnings" },
  { id: "anomalies", label: "Anomalies" },
  { id: "gross-to-net", label: "Gross to net" },
  { id: "submit", label: "Submit" },
  { id: "pay", label: "Pay" },
] as const;

export type RunStepId = (typeof RUN_STEPS)[number]["id"];

export function runStep(value: string | undefined): RunStepId {
  return RUN_STEPS.find((s) => s.id === value)?.id ?? "period";
}

// ---------------------------------------------------------------------------
// Off-cycle runs (slice 5.7b)
// ---------------------------------------------------------------------------

export type OffCycleReason = "final_pay" | "missed_worker" | "correction" | "one_off";

export const OFF_CYCLE_REASONS: Record<
  OffCycleReason,
  { label: string; hint: string; fullPay: boolean }
> = {
  final_pay: {
    label: "Final pay for a leaver",
    hint: "Pays the period up to the worker's last day (prorated), with their approved days and leave. Add leave encashment or terminal benefits as a one-off earning with a reason.",
    fullPay: true,
  },
  missed_worker: {
    label: "A worker the regular run missed",
    hint: "Pays the worker's full period from their pay rate, approved days and leave, as the regular run would have.",
    fullPay: true,
  },
  correction: {
    label: "A correction",
    hint: "Pays one-off items you add, with a reason, and, for a leaver paid off-cycle, approved days and leave no payslip has paid yet. Salary stays with the period's other runs.",
    fullPay: false,
  },
  one_off: {
    label: "A one-off payment",
    hint: "Pays one-off earnings you add, such as a bonus, with a reason. Salary, timesheets and leave stay with the regular run.",
    fullPay: false,
  },
};

export function isOffCycleReason(value: unknown): value is OffCycleReason {
  return typeof value === "string" && value in OFF_CYCLE_REASONS;
}

/** True for an off-cycle run that pays the worker's full period from the engine. */
export function offCyclePaysFullPeriod(reason: OffCycleReason | null): boolean {
  return reason !== null && OFF_CYCLE_REASONS[reason].fullPay;
}

/** "October 2026", or "October 2026 off-cycle: Final pay for a leaver". */
export function runTitle(run: {
  kind: string;
  periodEnd: string;
  offCycleReason: OffCycleReason | null;
}): string {
  const month = runMonth(run.periodEnd);
  return run.kind === "off_cycle" && run.offCycleReason
    ? `${month} off-cycle: ${OFF_CYCLE_REASONS[run.offCycleReason].label}`
    : month;
}
