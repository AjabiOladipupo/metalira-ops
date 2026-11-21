/**
 * Timesheet approval and Work Units (slice 4.3). The database decides (migration
 * 20261121130000: private.timesheet_line_is_clean, private.work_unit_billable); this mirror keeps
 * the same rules for the screens, the previews, Lira and the unit tests. tests/rls checks the SQL
 * agrees. Minutes only: no money anywhere.
 */

import { TIMESHEET_EXCEPTION_LABELS, type TimesheetException } from "./minutes";

export type LineStatus = "pending" | "approved" | "rejected" | "disputed";
export type DecisionKind = "approved" | "rejected" | "disputed" | "reopened";
export type ContractType = "manned_post" | "per_visit" | "fixed_monthly" | "per_job";
export type PunchSource = "self" | "supervisor";

/**
 * Exceptions that never stop "Approve N clean" (must-do 2): `supervisor` always, and
 * `no_location` / `no_selfie` only when every punch on the line that carries them was made by a
 * supervisor (a crew clock-in has no worker location or selfie by design; slice 3.6). Everything
 * else, `corrected` included, needs the approver to open the day.
 */
export const ALWAYS_INFORMATIONAL: readonly TimesheetException[] = ["supervisor"];
export const SUPERVISOR_INFORMATIONAL: readonly TimesheetException[] = ["no_location", "no_selfie"];

export interface CleanInput {
  status: LineStatus;
  exceptions: readonly string[];
  needsReview: boolean;
  inPunch: { source: PunchSource; flags: readonly string[] } | null;
  outPunch: { source: PunchSource; flags: readonly string[] } | null;
}

/** The exceptions that need a person, after the informational ones are set aside. */
export function blockingExceptions(input: Omit<CleanInput, "status" | "needsReview">): string[] {
  const supervisor = input.exceptions.includes("supervisor");
  const selfCarries = (name: string) =>
    [input.inPunch, input.outPunch].some(
      (p) => p !== null && p.source !== "supervisor" && p.flags.includes(name),
    );
  return input.exceptions.filter((name) => {
    if ((ALWAYS_INFORMATIONAL as readonly string[]).includes(name)) return false;
    if (
      (SUPERVISOR_INFORMATIONAL as readonly string[]).includes(name) &&
      supervisor &&
      !selfCarries(name)
    ) {
      return false;
    }
    return true;
  });
}

/** Clean: pending, nothing to review, and no exception but the informational ones. */
export function isCleanLine(input: CleanInput): boolean {
  return input.status === "pending" && !input.needsReview && blockingExceptions(input).length === 0;
}

/**
 * Whether a Work Unit on a contract of this type is billable: manned_post and per_visit are
 * billed by the unit; fixed_monthly and per_job by month or job (Phase 6), so their units are
 * recorded but not billable.
 */
export function workUnitBillable(type: ContractType | string | null): boolean {
  return type === "manned_post" || type === "per_visit";
}

/** A day makes a Work Unit when it is on a shift and counted minutes. */
export function makesWorkUnit(line: {
  hasShift: boolean;
  workedMinutes: number;
  otMinutes: number;
}): boolean {
  return line.hasShift && (line.workedMinutes > 0 || line.otMinutes > 0);
}

/** Why "Approve N clean" left a day out (the codes approve_clean_timesheet_lines returns). */
export type CleanRefusal =
  | "not_found"
  | "own"
  | "not_yours"
  | "decided"
  | "disputed"
  | "running"
  | "needs_review"
  | "flagged";

export const CLEAN_REFUSAL_TEXT: Record<CleanRefusal, string> = {
  not_found: "Not found",
  own: "Your own day",
  not_yours: "Doesn't report to you",
  decided: "Already decided",
  disputed: "Disputed: decide it on its own",
  running: "Shift hasn't finished",
  needs_review: "Time needs checking",
  flagged: "Flagged",
};

export interface CleanCandidate {
  id: string;
  status: LineStatus;
  clean: boolean;
  running: boolean;
  canDecide: boolean;
}

/** The days "Approve N clean" offers: clean, finished and the caller's to decide. */
export function cleanLineIds(lines: readonly CleanCandidate[]): string[] {
  return lines
    .filter((l) => l.status === "pending" && l.clean && !l.running && l.canDecide)
    .map((l) => l.id);
}

export const LINE_STATUS_TEXT: Record<LineStatus, string> = {
  pending: "Needs decision",
  approved: "Approved",
  rejected: "Rejected",
  disputed: "Disputed",
};

export const DECISION_TEXT: Record<DecisionKind, string> = {
  approved: "Approved",
  rejected: "Rejected",
  disputed: "Disputed by the worker",
  reopened: "Reopened",
};

/** The exceptions in words, informational ones last. */
export function exceptionLabels(exceptions: readonly string[]): string[] {
  return exceptions
    .filter((e): e is TimesheetException => e in TIMESHEET_EXCEPTION_LABELS)
    .map((e) => TIMESHEET_EXCEPTION_LABELS[e]);
}

/** The first exception that needs a person, in words ("No clock-out"), or null. */
export function headlineFlag(exceptions: readonly string[]): string | null {
  const first = exceptions.find(
    (e) => !(ALWAYS_INFORMATIONAL as readonly string[]).includes(e) && e !== "corrected",
  );
  if (first && first in TIMESHEET_EXCEPTION_LABELS) {
    return TIMESHEET_EXCEPTION_LABELS[first as TimesheetException];
  }
  if (exceptions.includes("supervisor")) return TIMESHEET_EXCEPTION_LABELS.supervisor;
  if (exceptions.includes("corrected")) return TIMESHEET_EXCEPTION_LABELS.corrected;
  return null;
}

export interface ReviewPunch {
  recordedAt: number;
  deviceTime: number;
  receivedAt: number;
  timeSource: "elapsed" | "offset" | "device" | string;
}

/** "3 h", "45 min", "2 days": a gap in words, rounded down. */
export function formatGap(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/**
 * Why a day needs its time checked (owner decision 12), in plain words for the list:
 * "Sent 3 h after the time it claims" (a punch the server received long after its time),
 * "Phone time not checked" (the server couldn't check the phone's clock).
 */
export function reviewReasons(
  exceptions: readonly string[],
  punches: readonly (ReviewPunch | null)[],
): string[] {
  const out: string[] = [];
  if (exceptions.includes("delayed") || exceptions.includes("late_sync")) {
    const gaps = punches
      .filter((p): p is ReviewPunch => p !== null)
      .map((p) => p.receivedAt - p.recordedAt)
      .filter((gap) => gap > 0);
    const gap = gaps.length > 0 ? Math.max(...gaps) : 0;
    out.push(gap >= 60_000 ? `Sent ${formatGap(gap)} after the time it claims` : "Sent late");
  }
  if (exceptions.includes("time_unverified")) out.push("Phone time not checked");
  return out;
}

/** "Matched", "11 min behind, corrected", "4 min ahead, corrected". */
export function deviceVsServer(driftSeconds: number | null): string {
  if (driftSeconds === null) return "Not known";
  const minutes = Math.round(Math.abs(driftSeconds) / 60);
  if (minutes === 0) return "Matched";
  return `${minutes} min ${driftSeconds > 0 ? "ahead" : "behind"}, corrected`;
}

/** "18 m, inside the site" from a punch's distance and geofence result. */
export function distanceText(distanceM: number | null, geofence: string | null): string {
  const where =
    geofence === "inside"
      ? "inside the site"
      : geofence === "near"
        ? "near the site"
        : geofence === "outside"
          ? "outside the site"
          : "location not known";
  if (distanceM === null) return where.charAt(0).toUpperCase() + where.slice(1);
  return `${distanceM.toLocaleString("en-NG")} m, ${where}`;
}

/** "Own phone" or "Supervisor crew clock-in". */
export function methodText(source: string | null): string {
  if (source === "supervisor") return "Supervisor crew clock-in";
  if (source === "self") return "Own phone";
  return "No punch";
}

/**
 * The Work Unit an approval makes, in words, for the detail panel: "Work Unit · 12 h · billable"
 * or why it makes none. Minutes only; Phase 6 prices it.
 */
export function workUnitText(line: {
  hasShift: boolean;
  workedMinutes: number;
  otMinutes: number;
  contractType: string | null;
  status: LineStatus;
  workUnitId: string | null;
}): string {
  if (!line.hasShift) return "No Work Unit: a day with no shift";
  if (line.status === "approved") {
    return line.workUnitId ? "Work Unit made" : "No Work Unit: no minutes";
  }
  if (!makesWorkUnit(line)) return "No Work Unit until minutes are counted";
  return workUnitBillable(line.contractType)
    ? "Approving makes a billable Work Unit"
    : "Approving makes a Work Unit, billed with the contract";
}
