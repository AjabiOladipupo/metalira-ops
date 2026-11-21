/**
 * Counting leave days (slice 4.4, owner decision 3). Pure: dates are ISO strings, days whole
 * numbers. The database counts the same way (private.leave_count_days in migration
 * 20261121180000_leave_requests.sql) and has the last word; this mirror lets the worker's form
 * show the count live ("3 working days. Covers 3 rostered shifts at Gate A").
 *
 * - A calendar-day type counts every day in the range.
 * - A working-day type counts the worker's working days in the range, minus the company's public
 *   holidays. A day with an assigned shift is a working day. On or before the worker's last
 *   rostered day, a day without a shift is an off-day; after it, the worker's usual days (their
 *   own `usual_work_days`, else the company's `default_work_days`) stand in.
 */

import { addDays } from "@/lib/dates";

import type { LeaveCounting } from "./presets";

export interface LeaveCalendar {
  /** ISO weekdays (1 Monday to 7 Sunday) the worker usually works. */
  workDays: readonly number[];
  /** The worker's last day with an assigned shift, or null when they have none. */
  lastRostered: string | null;
  /** The company's live public holidays (ISO dates). */
  holidays: ReadonlySet<string>;
  /** The worker's assigned shifts: one entry per shift, with its site's name. */
  shifts: readonly { date: string; site: string }[];
}

export interface LeaveCount {
  /** Whole days the request takes from the balance. */
  days: number;
  /** Assigned shifts in the range. */
  shifts: number;
  /** Their sites, by name, each once, in order. */
  sites: string[];
}

/** ISO weekday of an ISO date: 1 Monday to 7 Sunday. */
export function isoWeekday(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `from` to `to`, counting both ends (0 when `to` is before `from`). */
export function spanDays(from: string, to: string): number {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || to < from) return 0;
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** The days a request from `from` to `to` covers. Throws a RangeError past 366 days. */
export function countLeaveDays(
  from: string,
  to: string,
  counting: LeaveCounting,
  calendar: LeaveCalendar,
): LeaveCount {
  const span = spanDays(from, to);
  if (span > 367) throw new RangeError("Choose up to a year of dates.");
  const inRange = calendar.shifts.filter((s) => s.date >= from && s.date <= to);
  const sites = [...new Set(inRange.map((s) => s.site))].sort((a, b) => a.localeCompare(b));
  if (span === 0) return { days: 0, shifts: 0, sites: [] };
  if (counting === "calendar_days") return { days: span, shifts: inRange.length, sites };

  const shiftDays = new Set(inRange.map((s) => s.date));
  let days = 0;
  for (let i = 0; i < span; i += 1) {
    const day = addDays(from, i);
    if (calendar.holidays.has(day)) continue;
    if (shiftDays.has(day)) {
      days += 1;
      continue;
    }
    const beyondRoster = calendar.lastRostered === null || day > calendar.lastRostered;
    if (beyondRoster && calendar.workDays.includes(isoWeekday(day))) days += 1;
  }
  return { days, shifts: inRange.length, sites };
}

/** "3 working days", "1 working day", "84 calendar days". */
export function formatDayCount(days: number, counting: LeaveCounting): string {
  const unit = counting === "working_days" ? "working" : "calendar";
  return `${days} ${unit} ${days === 1 ? "day" : "days"}`;
}

/** "Covers 3 rostered shifts at Gate A.", "Covers 1 rostered shift at Gate A and Lekki Mall.", "No rostered shifts." */
export function formatShiftCover(count: Pick<LeaveCount, "shifts" | "sites">): string {
  if (count.shifts === 0) return "No rostered shifts.";
  const shifts = `${count.shifts} rostered ${count.shifts === 1 ? "shift" : "shifts"}`;
  if (count.sites.length === 0) return `Covers ${shifts}.`;
  const sites =
    count.sites.length === 1
      ? count.sites[0]!
      : `${count.sites.slice(0, -1).join(", ")} and ${count.sites.at(-1)!}`;
  return `Covers ${shifts} at ${sites}.`;
}
