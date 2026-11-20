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
  return todayIn(LAGOS_TIME_ZONE, now);
}

/**
 * Today's date in an IANA time zone as `YYYY-MM-DD`: the company's calendar day, as the database's
 * `private.org_today` sees it. An unknown zone falls back to Lagos, as the database does.
 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const format = (zone: string) =>
    // en-CA formats as YYYY-MM-DD.
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  try {
    return format(timeZone);
  } catch {
    return format(LAGOS_TIME_ZONE);
  }
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

const LAGOS_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: LAGOS_TIME_ZONE,
  day: "numeric",
  month: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A moment as "19 Nov 2026, 14:05" in Lagos time (24-hour clock). */
export function formatDateTime(at: string | Date): string {
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a date and time: ${String(at)}`);
  const parts = LAGOS_DATE_TIME.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const month = MONTHS[Number(get("month")) - 1] ?? "";
  return `${Number(get("day"))} ${month} ${get("year")}, ${get("hour")}:${get("minute")}`;
}
