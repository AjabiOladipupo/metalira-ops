/**
 * Calendar dates as ISO strings (`2026-11-14`), the way Postgres `date` columns arrive. Pure:
 * no time zone maths on the date itself, so a date never shifts by a day in the browser.
 * "Today" is the company's calendar day in Lagos (DESIGN_SYSTEM.md: times in Lagos time).
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const LAGOS_TIME_ZONE = "Africa/Lagos";

function parts(iso: string): [number, number, number] {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new RangeError(`Not an ISO date: ${iso}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "14 Nov 2026". */
export function formatDate(iso: string): string {
  const [year, month, day] = parts(iso);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** Today's date in Lagos as `YYYY-MM-DD`. */
export function lagosToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LAGOS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The date `days` after `iso` (negative goes back). */
export function addDays(iso: string, days: number): string {
  const [year, month, day] = parts(iso);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** The first day of the month after `iso`. */
export function firstOfNextMonth(iso: string): string {
  const [year, month] = parts(iso);
  return month === 12 ? toIso(year + 1, 1, 1) : toIso(year, month + 1, 1);
}

/** True when `iso` falls between `from` and `to` inclusive; a null `to` is open-ended. */
export function isWithin(iso: string, from: string, to: string | null): boolean {
  return from <= iso && (to === null || iso <= to);
}
