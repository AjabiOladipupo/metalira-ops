/**
 * Approved leave meets the roster (slice 4.5). Pure and isomorphic.
 *
 * - HR's final approval opens the worker's shifts in the range that haven't started
 *   (migration 20261121190000_leave_roster.sql, private.leave_shifts_to_open). The preview lists
 *   them: "Opens 3 shifts: Gate A · Day, 4 to 6 Nov".
 * - The roster's suggestions skip a worker on approved leave that day and mark one with leave
 *   waiting for a decision.
 */

import { addDays } from "../dates";
import { formatLeaveRange } from "./requests";

/** One shift approved leave opens (decide_leave_hr's `open_shifts`). */
export interface OpenedShift {
  assignmentId: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  siteId: string;
  siteName: string;
  postId: string;
  postName: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** decide_leave_hr's `open_shifts` as typed rows; anything malformed is dropped. */
export function toOpenedShifts(value: unknown): OpenedShift[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      assignmentId: str(v.assignment_id),
      shiftDate: str(v.shift_date),
      startsAt: str(v.starts_at),
      endsAt: str(v.ends_at),
      siteId: str(v.site_id),
      siteName: str(v.site_name),
      postId: str(v.post_id),
      postName: str(v.post_name),
    }))
    .filter((s) => s.assignmentId !== "" && /^\d{4}-\d{2}-\d{2}$/.test(s.shiftDate));
}

/**
 * Days as runs: "4 to 6 Nov" when they follow one another, else each run joined with commas
 * ("4 to 5 Nov, 9 Nov").
 */
export function formatDayRuns(dates: readonly string[]): string {
  const sorted = [...new Set(dates)].sort();
  const runs: { from: string; to: string }[] = [];
  for (const date of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === date) last.to = date;
    else runs.push({ from: date, to: date });
  }
  return runs.map((r) => formatLeaveRange(r.from, r.to, false)).join(", ");
}

const shifts = (n: number) => `${n} ${n === 1 ? "shift" : "shifts"}`;

/**
 * "Opens 3 shifts: Gate A · Day, 4 to 6 Nov" (one post), "Opens 4 shifts: Gate A · Day, 4 to 6
 * Nov; Gate B · Night, 7 Nov" (several), or "Opens no shifts" when the worker has none rostered.
 */
export function formatOpenedShifts(opened: readonly OpenedShift[]): string {
  if (opened.length === 0) return "Opens no shifts";
  const byPost = new Map<string, { name: string; first: string; dates: string[] }>();
  for (const s of opened) {
    const key = `${s.siteId}|${s.postId}`;
    const group = byPost.get(key) ?? { name: s.postName, first: s.startsAt, dates: [] };
    group.dates.push(s.shiftDate);
    if (s.startsAt < group.first) group.first = s.startsAt;
    byPost.set(key, group);
  }
  const groups = [...byPost.values()].sort(
    (a, b) => a.first.localeCompare(b.first) || a.name.localeCompare(b.name),
  );
  return `Opens ${shifts(opened.length)}: ${groups
    .map((g) => `${g.name}, ${formatDayRuns(g.dates)}`)
    .join("; ")}`;
}

/** The sites the shifts are at, by name, once each. */
export function openedSiteNames(opened: readonly OpenedShift[]): string[] {
  return [...new Set(opened.map((s) => s.siteName).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** "3 shifts at Apapa Warehouse 3", "4 shifts at Apapa Warehouse 3 and Lekki Phase 1". */
export function formatOpenedAtSites(opened: readonly OpenedShift[]): string {
  const sites = openedSiteNames(opened);
  const where =
    sites.length === 0
      ? ""
      : sites.length === 1
        ? ` at ${sites[0]}`
        : ` at ${sites.slice(0, -1).join(", ")} and ${sites[sites.length - 1]}`;
  return `${shifts(opened.length)}${where}`;
}

/** Approved or pending leave from public.roster_leave: worker ids and dates only. */
export interface LeaveSpan {
  workerId: string;
  startDate: string;
  endDate: string;
  status: "approved" | "pending";
}

/** The span covering `date` for the worker with the given status, or null. */
export function leaveOn(
  spans: readonly LeaveSpan[],
  workerId: string,
  date: string,
  status: LeaveSpan["status"],
): LeaveSpan | null {
  return (
    spans.find(
      (s) =>
        s.workerId === workerId && s.status === status && s.startDate <= date && date <= s.endDate,
    ) ?? null
  );
}

/** "On leave 4 to 6 Nov" (the database's MLRSL wording, without the full stop). */
export function onLeaveLabel(span: Pick<LeaveSpan, "startDate" | "endDate">): string {
  return `On leave ${formatLeaveRange(span.startDate, span.endDate, false)}`;
}

/** "Leave waiting for a decision 4 to 6 Nov". */
export function pendingLeaveLabel(span: Pick<LeaveSpan, "startDate" | "endDate">): string {
  return `Leave waiting for a decision ${formatLeaveRange(span.startDate, span.endDate, false)}`;
}
