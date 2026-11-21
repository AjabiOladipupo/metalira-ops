/**
 * Leave requests and the leave year (slice 4.4). Pure. The database applies the same rules
 * (migration 20261121180000_leave_requests.sql); these mirror them for screens and tests.
 */

import { daysInYear, prorateEntitlement } from "./entitlements";

/** The status dot (src/components/status.tsx). */
type StatusTone = "done" | "pending" | "partial" | "action";

export const LEAVE_STATUSES = [
  "pending_line_manager",
  "pending_hr",
  "approved",
  "declined",
  "cancelled",
] as const;

export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Requests that hold days and block other requests on the same dates. */
export const LIVE_STATUSES: readonly LeaveStatus[] = ["pending_line_manager", "pending_hr", "approved"];

export function isLeaveStatus(value: string): value is LeaveStatus {
  return (LEAVE_STATUSES as readonly string[]).includes(value);
}

/** The worker's words for a status. */
export const STATUS_LABELS: Record<LeaveStatus, string> = {
  pending_line_manager: "With line manager",
  pending_hr: "With HR",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** Status dot: done for approved, hollow while waiting or closed without leave. */
export function statusTone(status: LeaveStatus): StatusTone {
  return status === "approved" ? "done" : "pending";
}

/** The status a manager sees, with "needs your action" when it is theirs to decide. */
export function managerStatusTone(status: LeaveStatus, yours: boolean): StatusTone {
  if (yours) return "action";
  return statusTone(status);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string): { y: number; m: number; d: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

/**
 * "4 to 6 Nov 2026", "4 Nov 2026", "28 Oct to 3 Nov 2026" (private.leave_range_label). With
 * `withYear` false the year is left out ("4 to 6 Nov"), for lists inside one year.
 */
export function formatLeaveRange(start: string, end: string, withYear = true): string {
  const a = parts(start);
  const b = parts(end);
  const year = withYear ? ` ${b.y}` : "";
  if (start === end) return `${a.d} ${MONTHS[a.m - 1]}${year}`;
  if (a.y === b.y && a.m === b.m) return `${a.d} to ${b.d} ${MONTHS[b.m - 1]}${year}`;
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m - 1]} ${a.y} to ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  return `${a.d} ${MONTHS[a.m - 1]} to ${b.d} ${MONTHS[b.m - 1]}${year}`;
}

/** Whole months of service from `start` to `at` (private.leave_service_months); 0 before. */
export function serviceMonths(start: string, at: string): number {
  if (at < start) return 0;
  const s = parts(start);
  const a = parts(at);
  let months = (a.y - s.y) * 12 + (a.m - s.m);
  if (a.d < s.d) months -= 1;
  return Math.max(0, months);
}

/**
 * A prorated share for `year` that may be negative (private.leave_prorate): the absolute value
 * is prorated half up, then the sign put back, so a version that lowers the days rounds half away
 * from zero.
 */
export function prorateSigned(days: number, from: string, year: number): number {
  if (days === 0) return 0;
  const share = prorateEntitlement(Math.abs(days), from, year);
  return days < 0 ? -share : share;
}

/**
 * The adjustment a version starting after 1 January adds to a worker's year (coordinator,
 * 21 Nov 2026): (new days - old days), prorated from the version's date or the worker's start,
 * whichever is later. 0 for a version starting on 1 January, or outside the year.
 */
export function versionAdjustment(
  previousDays: number,
  newDays: number,
  effectiveFrom: string,
  workerStart: string,
  year: number,
): number {
  if (effectiveFrom <= `${year}-01-01` || effectiveFrom > `${year}-12-31`) return 0;
  const from = effectiveFrom > workerStart ? effectiveFrom : workerStart;
  return prorateSigned(newDays - previousDays, from, year);
}

/** The carry-over into a new year: last year's remainder (never below 0), up to the cap. */
export function carryOver(remainder: number, cap: number | null): number {
  if (cap === null) return 0;
  return Math.min(Math.max(remainder, 0), cap);
}

export type LedgerKind = "grant" | "carry_over" | "taken" | "returned" | "adjustment";

export interface LedgerRow {
  kind: LedgerKind;
  days: number;
}

/** A balance is the sum of the ledger; never stored. */
export function ledgerBalance(rows: readonly LedgerRow[]): number {
  return rows.reduce((sum, row) => sum + row.days, 0);
}

/** Days in `year`, re-exported for screens that explain proration. */
export { daysInYear };

/** Plain text a person types into a reason or note (private.leave_clean_text). */
export function cleanLeaveText(value: string | null | undefined, max = 500): string | null {
  const text = (value ?? "").trim();
  if (text === "") return null;
  if (text.length > max) return null;
  if (/[\p{Cc}<>]/u.test(text.replace(/\n/g, ""))) return null;
  if (/:\/\/|www\./i.test(text)) return null;
  if (/[0-9](?:[ -]*[0-9]){9,}/.test(text)) return null;
  return text;
}
