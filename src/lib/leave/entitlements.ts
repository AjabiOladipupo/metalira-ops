/**
 * Leave entitlements and the working week (slice 4.1). Pure: dates are ISO strings, days and
 * percentages whole numbers. The database applies the same rules (migration
 * 20261121110000_leave_setup.sql); these mirror them for screens, previews and tests.
 */

import { addDays, formatDate } from "@/lib/dates";

import type { LeaveCounting } from "./presets";

export interface EntitlementValues {
  daysPerYear: number;
  carryOverCapDays: number | null;
  payPercent: number;
  payMinServiceMonths: number | null;
}

export interface EntitlementVersion extends EntitlementValues {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** Whole days from `from` to `to`, counting both ends. */
function daysBetweenInclusive(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * A joiner's entitlement for `year` (owner decision 2; PHASE_4.md "Proration for joiners"):
 * days a year × days from the start date to 31 Dec ÷ days in the year, rounded half up once to
 * a whole day. A start on or before 1 January gets the full figure; one after the year, none.
 * Integer maths only.
 */
export function prorateEntitlement(daysPerYear: number, startDate: string, year: number): number {
  if (!Number.isInteger(daysPerYear) || daysPerYear < 0) {
    throw new RangeError("Days a year is a whole number of 0 or more.");
  }
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  if (startDate <= first) return daysPerYear;
  if (startDate > last) return 0;
  const remaining = daysBetweenInclusive(startDate, last);
  const total = daysInYear(year);
  // Half up: floor((2 × days × remaining + total) ÷ (2 × total)).
  return Math.floor((2 * daysPerYear * remaining + total) / (2 * total));
}

/** The dates a change to a type's days may start: tomorrow, or the next 1 January (rule 3). */
export function changeDateChoices(today: string): { tomorrow: string; nextJanuary: string } {
  return { tomorrow: addDays(today, 1), nextJanuary: `${yearOf(today) + 1}-01-01` };
}

/** True when `from` is tomorrow or a 1 January after today (private.leave_change_date_ok). */
export function isAllowedChangeDate(from: string, today: string): boolean {
  if (from === addDays(today, 1)) return true;
  return from > today && from.slice(5) === "01-01";
}

export type EntitlementPlan =
  | {
      kind: "first";
      effectiveFrom: string;
    }
  | {
      kind: "unchanged";
      effectiveFrom: string;
      before: EntitlementVersion;
    }
  | {
      kind: "change";
      effectiveFrom: string;
      /** The version before the change, which closes the day before it, if any. */
      closes: { id: string; effectiveTo: string } | null;
      before: EntitlementVersion | null;
      /** Scheduled versions from that date on, which the change replaces. */
      replaces: EntitlementVersion[];
    };

function sameValues(a: EntitlementValues, b: EntitlementValues): boolean {
  return (
    a.daysPerYear === b.daysPerYear &&
    a.carryOverCapDays === b.carryOverCapDays &&
    a.payPercent === b.payPercent &&
    a.payMinServiceMonths === b.payMinServiceMonths
  );
}

/**
 * What adding a version does (private.leave_entitlement_write): a type with no version gets its
 * first from 1 January of this year; otherwise the change starts on `from`, replaces versions
 * scheduled from that date on, and closes the version before it the day before. Throws a
 * RangeError for a date that isn't tomorrow or a future 1 January.
 */
export function planEntitlementChange(
  versions: readonly EntitlementVersion[],
  values: EntitlementValues,
  from: string,
  today: string,
): EntitlementPlan {
  if (versions.length === 0) {
    return { kind: "first", effectiveFrom: `${yearOf(today)}-01-01` };
  }
  if (!isAllowedChangeDate(from, today)) {
    throw new RangeError("A change to the days starts tomorrow or on a future 1 January.");
  }
  const sorted = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const before = sorted.filter((v) => v.effectiveFrom < from).at(-1) ?? null;
  const replaces = sorted.filter((v) => v.effectiveFrom >= from);
  if (before && replaces.length === 0 && sameValues(before, values)) {
    return { kind: "unchanged", effectiveFrom: from, before };
  }
  return {
    kind: "change",
    effectiveFrom: from,
    closes: before ? { id: before.id, effectiveTo: addDays(from, -1) } : null,
    before,
    replaces,
  };
}

/** The version in force on `date`, if any. */
export function versionOn(
  versions: readonly EntitlementVersion[],
  date: string,
): EntitlementVersion | null {
  return (
    versions.find(
      (v) => v.effectiveFrom <= date && (v.effectiveTo === null || date <= v.effectiveTo),
    ) ?? null
  );
}

/** Versions that start after `date`: changes already scheduled. */
export function scheduledVersions(
  versions: readonly EntitlementVersion[],
  date: string,
): EntitlementVersion[] {
  return versions
    .filter((v) => v.effectiveFrom > date)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/** "15 working days", "84 calendar days (12 weeks)", "1 working day". */
export function formatLeaveDays(days: number, counting: LeaveCounting): string {
  const unit = counting === "working_days" ? "working" : "calendar";
  const base = `${days} ${unit} ${days === 1 ? "day" : "days"}`;
  if (counting === "calendar_days" && days > 0 && days % 7 === 0) {
    const weeks = days / 7;
    return `${base} (${weeks} ${weeks === 1 ? "week" : "weeks"})`;
  }
  return base;
}

/** "Full pay", "No pay", "50% pay after 6 months' service". */
export function formatLeavePay(
  paid: boolean,
  payPercent: number,
  payMinServiceMonths: number | null,
): string {
  if (!paid || payPercent === 0) return "No pay";
  const base = payPercent === 100 ? "Full pay" : `${payPercent}% pay`;
  if (payMinServiceMonths && payMinServiceMonths > 0) {
    return `${base} after ${formatMonths(payMinServiceMonths)}' service`;
  }
  return base;
}

/** "1 month", "12 months". */
export function formatMonths(months: number): string {
  return `${months} ${months === 1 ? "month" : "months"}`;
}

/** "From 1 Jan 2027: 18 working days". */
export function formatScheduled(version: EntitlementVersion, counting: LeaveCounting): string {
  return `From ${formatDate(version.effectiveFrom)}: ${formatLeaveDays(version.daysPerYear, counting)}`;
}

// ---------------------------------------------------------------------------
// The working week
// ---------------------------------------------------------------------------

/** ISO weekdays, Monday first. */
export const WEEKDAYS = [
  { iso: 1, short: "Mon", long: "Monday" },
  { iso: 2, short: "Tue", long: "Tuesday" },
  { iso: 3, short: "Wed", long: "Wednesday" },
  { iso: 4, short: "Thu", long: "Thursday" },
  { iso: 5, short: "Fri", long: "Friday" },
  { iso: 6, short: "Sat", long: "Saturday" },
  { iso: 7, short: "Sun", long: "Sunday" },
] as const;

export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** Sorted, distinct ISO weekdays; null when empty or out of range (private.valid_work_days). */
export function normaliseWorkDays(days: readonly number[]): number[] | null {
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return null;
  const out = [...new Set(days)].sort((a, b) => a - b);
  return out.length === 0 ? null : out;
}

/** "Mon to Fri", "Mon to Sat", "Mon, Wed, Fri", "Every day". */
export function formatWorkDays(days: readonly number[]): string {
  const sorted = normaliseWorkDays(days);
  if (!sorted) return "No working days";
  if (sorted.length === 7) return "Every day";
  const name = (iso: number) => WEEKDAYS[iso - 1]!.short;
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (consecutive && sorted.length >= 3) {
    return `${name(sorted[0]!)} to ${name(sorted.at(-1)!)}`;
  }
  return sorted.map(name).join(", ");
}

// ---------------------------------------------------------------------------
// Copying holidays
// ---------------------------------------------------------------------------

export interface HolidayCopyPlan {
  copied: { date: string; name: string }[];
  skipped: { date: string; name: string; reason: string }[];
}

/**
 * Copying one year's holidays into another (private.copy_public_holidays): same day and month,
 * skipping a date already a holiday in the target year and 29 February in a year without one.
 */
export function planHolidayCopy(
  source: readonly { date: string; name: string }[],
  target: readonly { date: string; name: string }[],
  toYear: number,
): HolidayCopyPlan {
  const taken = new Map(target.map((h) => [h.date, h.name]));
  const plan: HolidayCopyPlan = { copied: [], skipped: [] };
  for (const h of [...source].sort((a, b) => a.date.localeCompare(b.date))) {
    const monthDay = h.date.slice(5);
    if (monthDay === "02-29" && !isLeapYear(toYear)) {
      plan.skipped.push({ date: h.date, name: h.name, reason: `29 Feb isn't in ${toYear}` });
      continue;
    }
    const date = `${toYear}-${monthDay}`;
    const existing = taken.get(date);
    if (existing !== undefined) {
      plan.skipped.push({ date, name: h.name, reason: `Already a holiday: ${existing}` });
      continue;
    }
    plan.copied.push({ date, name: h.name });
  }
  return plan;
}
