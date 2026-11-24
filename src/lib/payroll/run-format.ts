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

export type RunStatusName = "draft" | "review" | "approved" | "released" | "reversed";
export type RunStatusTone = "done" | "pending" | "partial" | "action";

export const RUN_STATUS: Record<RunStatusName, { label: string; tone: RunStatusTone }> = {
  draft: { label: "Draft", tone: "pending" },
  review: { label: "Waiting for approval", tone: "action" },
  approved: { label: "Approved", tone: "done" },
  released: { label: "Released", tone: "done" },
  reversed: { label: "Reversed", tone: "partial" },
};

/** A reversal run's status (slice 5.7a): a declined one is back in draft and never submitted again. */
export const REVERSAL_STATUS: Record<RunStatusName, { label: string; tone: RunStatusTone }> = {
  draft: { label: "Reversal declined", tone: "pending" },
  review: { label: "Reversal waiting for approval", tone: "action" },
  approved: { label: "Reversal approved", tone: "done" },
  released: { label: "Released", tone: "done" },
  reversed: { label: "Reversed", tone: "partial" },
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
