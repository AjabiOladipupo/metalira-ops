/**
 * Headcount (slice 2.5): the staffing plan a client signs up to on a contract, and what it comes
 * to in a week at the rate card in force. Pure: no database, no clock. Isomorphic, because the
 * Headcount tab, the row editor's live line, the server's previews and the ops agent's cards all
 * show the same numbers (docs/PHASE_2.md 2.5; the database repeats the row rules in migration
 * 20261119140000_headcount).
 *
 * - Money is `bigint` kobo (CLAUDE.md rule 1); no `Number` arithmetic touches an amount. Counts,
 *   days and minutes are small integers.
 * - A row is matched to the rate card by its rate key (role, band, unit), ignoring case
 *   (`findRateLine`), never by id.
 * - Billable amounts here are a preview of the plan, not an invoice: nothing is stored and Phase 6
 *   prices the Work Units that actually happen. Hourly rows are rounded half away from zero once
 *   per row per week (or per row and rate card in a range), never per shift.
 * - A shift belongs to the day it starts: a night shift from Sunday 18:00 to Monday 06:00 is a
 *   Sunday shift, in a week and in a date range.
 */

import { addDays, formatDate } from "@/lib/dates";
import { roundHalfUp, sumKobo, type Kobo } from "@/lib/money";
import {
  STANDARD_BAND,
  findRateLine,
  formatRate,
  normaliseKeyPart,
  rateCardInForce,
  rateKeyId,
  type RateCardVersion,
  type RateKey,
  type RateLine,
} from "@/lib/rate-cards";

export const HEADCOUNT_UNITS = ["shift", "hour", "visit"] as const;
export type HeadcountUnit = (typeof HEADCOUNT_UNITS)[number];

export const HEADCOUNT_UNIT_LABELS: Record<HeadcountUnit, string> = {
  shift: "Per shift",
  hour: "Per hour",
  visit: "Per visit",
};

/** Contract types whose rows are priced from the rate card one by one. */
export const PRICED_CONTRACT_TYPES = ["manned_post", "per_visit"] as const;

/** Contract types that must have headcount before activation (2.7). */
export const HEADCOUNT_REQUIRED_TYPES = ["manned_post"] as const;

export const MAX_REQUIRED_COUNT = 200;
export const MINUTES_PER_DAY = 1440;

/** ISO weekdays: 1 = Monday ... 7 = Sunday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** fixed_monthly and per_job bill an agreed amount: their headcount is staffing only. */
export function headcountIsPriced(contractType: string): boolean {
  return (PRICED_CONTRACT_TYPES as readonly string[]).includes(contractType);
}

export function headcountRequired(contractType: string): boolean {
  return (HEADCOUNT_REQUIRED_TYPES as readonly string[]).includes(contractType);
}

export interface HeadcountLine {
  id: string;
  siteId: string;
  /** "Gate A", or null: the role names the post. */
  postName: string | null;
  role: string;
  /** `standard` when the role has one rate. */
  band: string;
  unit: HeadcountUnit;
  /** ISO weekdays, sorted, each once. */
  daysOfWeek: number[];
  /** "06:00" (Lagos time). */
  startTime: string;
  /** "18:00"; at or before the start means the next day. */
  endTime: string;
  requiredCount: number;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Times and names
// ---------------------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;

/** "06:00" or "06:00:00" as minutes after midnight; null when it isn't a time. */
export function minutesOf(time: string): number | null {
  const match = TIME.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "06:00:00" (Postgres) as "06:00". */
export function toHourMinute(time: string): string {
  return time.trim().slice(0, 5);
}

function minutesOrThrow(time: string): number {
  const minutes = minutesOf(time);
  if (minutes === null) throw new RangeError(`Not a time: ${time}`);
  return minutes;
}

/** How long one occurrence lasts: an end at or before the start is the next day; equal is 24 h. */
export function durationMinutes(startTime: string, endTime: string): number {
  const start = minutesOrThrow(startTime);
  const end = minutesOrThrow(endTime);
  return end > start ? end - start : MINUTES_PER_DAY - (start - end);
}

export function crossesMidnight(startTime: string, endTime: string): boolean {
  return minutesOrThrow(endTime) <= minutesOrThrow(startTime);
}

function isStandardBand(band: string): boolean {
  const part = normaliseKeyPart(band);
  return part === "" || part === STANDARD_BAND;
}

/** The post's name as 2.7 opens it: "Gate A · Day", "Guard · Night", or "Gate A". */
export function postLabel(line: Pick<HeadcountLine, "postName" | "role" | "band">): string {
  const name = line.postName?.trim() || line.role.trim();
  return isStandardBand(line.band) ? name : `${name} · ${line.band.trim()}`;
}

/** The rate key a row is priced by. */
export function headcountRateKey(line: Pick<HeadcountLine, "role" | "band" | "unit">): RateKey {
  return {
    role: line.role,
    band: isStandardBand(line.band) ? STANDARD_BAND : line.band,
    unit: line.unit,
  };
}

/** "Guard · Night", as the "No rate for ..." flag names it. */
export function formatRoleBand(line: Pick<HeadcountLine, "role" | "band">): string {
  return isStandardBand(line.band) ? line.role.trim() : `${line.role.trim()} · ${line.band.trim()}`;
}

/** "Every day", "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri", "Mon–Wed, Sat". */
export function formatDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  const runs: number[][] = [];
  for (const day of sorted) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1] === day - 1) run.push(day);
    else runs.push([day]);
  }
  return runs
    .flatMap((run) => {
      const first = WEEKDAY_SHORT[run[0]! - 1]!;
      const last = WEEKDAY_SHORT[run[run.length - 1]! - 1]!;
      if (run.length >= 3 || (run.length === 2 && run[0] === 6)) return [`${first}–${last}`];
      return run.map((d) => WEEKDAY_SHORT[d - 1]!);
    })
    .join(", ");
}

/** "06:00–18:00", "18:00–06:00 (next day)", "24 hours from 06:00". */
export function formatHours(line: Pick<HeadcountLine, "startTime" | "endTime">): string {
  const start = toHourMinute(line.startTime);
  const end = toHourMinute(line.endTime);
  if (durationMinutes(start, end) === MINUTES_PER_DAY) return `24 hours from ${start}`;
  return `${start}–${end}${crossesMidnight(start, end) ? " (next day)" : ""}`;
}

/** 720 as "12 h", 450 as "7 h 30 min". */
export function formatDuration(minutes: number): string {
  const hours = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// ---------------------------------------------------------------------------
// A week, and a date range
// ---------------------------------------------------------------------------

export interface WeekOccurrence {
  /** Index of the row in the lines given. */
  line: number;
  /** The ISO weekday it starts on. */
  weekday: number;
  /** Minutes after Monday 00:00 that it starts. */
  startsAt: number;
  /** Minutes after Monday 00:00 that it ends: past 10080 for a Sunday night shift. */
  endsAt: number;
  people: number;
}

/** Every occurrence the rows describe in one week (Monday to Sunday), in start order. */
export function expandWeek(lines: readonly HeadcountLine[]): WeekOccurrence[] {
  const out: WeekOccurrence[] = [];
  lines.forEach((line, index) => {
    const start = minutesOrThrow(line.startTime);
    const length = durationMinutes(line.startTime, line.endTime);
    for (const weekday of [...new Set(line.daysOfWeek)].sort((a, b) => a - b)) {
      if (weekday < 1 || weekday > 7) continue;
      const startsAt = (weekday - 1) * MINUTES_PER_DAY + start;
      out.push({
        line: index,
        weekday,
        startsAt,
        endsAt: startsAt + length,
        people: line.requiredCount,
      });
    }
  });
  return out.sort((a, b) => a.startsAt - b.startsAt || a.line - b.line);
}

/** Person-shifts (or person-visits) in a week: days × people. */
export function shiftsPerWeek(line: Pick<HeadcountLine, "daysOfWeek" | "requiredCount">): number {
  return new Set(line.daysOfWeek.filter((d) => d >= 1 && d <= 7)).size * line.requiredCount;
}

/** Person-minutes in a week. */
export function minutesPerWeek(
  line: Pick<HeadcountLine, "daysOfWeek" | "requiredCount" | "startTime" | "endTime">,
): number {
  return shiftsPerWeek(line) * durationMinutes(line.startTime, line.endTime);
}

/** The ISO weekday (1 = Monday) of a `YYYY-MM-DD` date. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

export interface DatedOccurrence {
  line: number;
  /** The day it starts. */
  date: string;
  /** "2026-12-04T18:00", Lagos time. */
  startsAt: string;
  /** "2026-12-05T06:00": the next day for a night shift. */
  endsAt: string;
  people: number;
}

function localStamp(date: string, minutes: number): string {
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const rest = minutes % MINUTES_PER_DAY;
  const hh = String(Math.trunc(rest / 60)).padStart(2, "0");
  const mm = String(rest % 60).padStart(2, "0");
  return `${addDays(date, days)}T${hh}:${mm}`;
}

/** Every occurrence starting from `from` to `to` inclusive (a shift starting on `to` counts whole). */
export function expandRange(
  lines: readonly HeadcountLine[],
  from: string,
  to: string,
): DatedOccurrence[] {
  const out: DatedOccurrence[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = isoWeekday(date);
    lines.forEach((line, index) => {
      if (!line.daysOfWeek.includes(weekday)) return;
      const start = minutesOrThrow(line.startTime);
      out.push({
        line: index,
        date,
        startsAt: localStamp(date, start),
        endsAt: localStamp(date, start + durationMinutes(line.startTime, line.endTime)),
        people: line.requiredCount,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * What `count` occurrences of `minutes` each, for `people` each, come to on `line`:
 * - per shift or per visit: rate × occurrences × people;
 * - per hour: rate × minutes × occurrences × people ÷ 60, rounded half away from zero once.
 * Null when the row is billed per something the line isn't.
 */
export function priceOccurrences(
  line: Pick<RateLine, "rateKobo" | "unit">,
  unit: HeadcountUnit,
  personOccurrences: number,
  minutesEach: number,
): Kobo | null {
  if (line.unit !== unit) return null;
  const n = BigInt(personOccurrences);
  if (unit === "hour") return roundHalfUp(line.rateKobo * BigInt(minutesEach) * n, 60n);
  return line.rateKobo * n;
}

export interface PricedRow {
  line: HeadcountLine;
  label: string;
  /** Person-shifts (or person-visits) a week. */
  perWeek: number;
  minutesPerWeek: number;
  /** The matching rate line, or null. */
  rate: RateLine | null;
  /** Billable kobo a week; null when unpriced or the contract isn't priced per row. */
  weeklyKobo: Kobo | null;
  /** True when the contract is priced per row and this row's key has no line. */
  missingRate: boolean;
}

export interface HeadcountTotals {
  posts: number;
  /** Person-shifts a week (rows billed per shift or hour). */
  shifts: number;
  /** Person-visits a week. */
  visits: number;
  /** Sum of the priced rows; null when the contract isn't priced per row or no row is priced. */
  weeklyKobo: Kobo | null;
  /** Rows with no matching rate line. */
  unpriced: number;
  /** The keys with no line, each once ("Guard · Night (shift)"). */
  missingKeys: RateKey[];
}

export interface SiteTotals extends HeadcountTotals {
  siteId: string;
  rows: PricedRow[];
}

export interface WeeklyHeadcount extends HeadcountTotals {
  priced: boolean;
  rows: PricedRow[];
  sites: SiteTotals[];
}

function totalsOf(rows: readonly PricedRow[]): HeadcountTotals {
  const priced = rows.filter((r) => r.weeklyKobo !== null);
  const seen = new Set<string>();
  const missingKeys: RateKey[] = [];
  for (const row of rows) {
    if (!row.missingRate) continue;
    const key = headcountRateKey(row.line);
    const id = rateKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    missingKeys.push(key);
  }
  return {
    posts: rows.length,
    shifts: rows.filter((r) => r.line.unit !== "visit").reduce((n, r) => n + r.perWeek, 0),
    visits: rows.filter((r) => r.line.unit === "visit").reduce((n, r) => n + r.perWeek, 0),
    weeklyKobo: priced.length ? sumKobo(priced.map((r) => r.weeklyKobo!)) : null,
    unpriced: rows.filter((r) => r.missingRate).length,
    missingKeys,
  };
}

/**
 * One week of the plan at `version`'s rates. A PREVIEW of the plan, never stored: hourly rows are
 * rounded once per row for the week, the same rule as `rangeTotals` (once per row and rate
 * version over the range). Invoices (Phase 6) round once per invoice line from the Work Units
 * that actually happen, so they can differ from these figures by a kobo.
 * The week is priced at `version` (the version in force on the day that matters,
 * found by the caller with `pricingDate` and `rateCardInForce`). Rows grouped by site in the
 * order the site ids first appear. `version` null on a priced contract flags every row.
 */
export function weeklyHeadcount(
  lines: readonly HeadcountLine[],
  version: Pick<RateCardVersion, "lines"> | null,
  contractType: string,
): WeeklyHeadcount {
  const priced = headcountIsPriced(contractType);
  const rows: PricedRow[] = lines.map((line) => {
    const perWeek = shiftsPerWeek(line);
    const minutes = minutesPerWeek(line);
    const rate = priced ? findRateLine(version, headcountRateKey(line)) : null;
    // A matched line always has the row's unit; if pricing ever returns null the row counts as
    // unpriced rather than vanishing from the total.
    const weeklyKobo = rate
      ? priceOccurrences(rate, line.unit, perWeek, durationMinutes(line.startTime, line.endTime))
      : null;
    return {
      line,
      label: postLabel(line),
      perWeek,
      minutesPerWeek: minutes,
      rate,
      weeklyKobo,
      missingRate: priced && weeklyKobo === null,
    };
  });
  const order: string[] = [];
  for (const row of rows) if (!order.includes(row.line.siteId)) order.push(row.line.siteId);
  const sites = order.map((siteId) => {
    const siteRows = rows.filter((r) => r.line.siteId === siteId);
    return { siteId, rows: siteRows, ...totalsOf(siteRows) };
  });
  return { priced, rows, sites, ...totalsOf(rows) };
}

export interface RangeTotals {
  shifts: number;
  visits: number;
  /** Priced occurrences only. */
  billableKobo: Kobo;
  /** Person-occurrences on a day with no rate card in force or no matching line. */
  unpricedOccurrences: number;
}

/**
 * The plan from `from` to `to` inclusive (a partial week, a month, the days around a rate
 * change), clamped to the contract's dates: days outside the contract are neither shifts nor
 * unpriced. Each occurrence is priced at the version in force on the day it starts. A PREVIEW:
 * hourly rows are rounded once per row and rate version over the whole range (so a two-week
 * range can be a kobo below two one-week totals); nothing here is stored.
 * On a contract not priced per row only the counts are given.
 */
export function rangeTotals(
  lines: readonly HeadcountLine[],
  versions: readonly RateCardVersion[],
  range: { from: string; to: string },
  contract: { type: string; startDate: string; endDate: string | null },
): RangeTotals {
  const priced = headcountIsPriced(contract.type);
  const from = range.from < contract.startDate ? contract.startDate : range.from;
  const to = contract.endDate !== null && range.to > contract.endDate ? contract.endDate : range.to;
  let shifts = 0;
  let visits = 0;
  let unpricedOccurrences = 0;
  // Person-occurrences per (row, version) so hourly rows round once per period.
  const groups = new Map<string, { line: number; rate: RateLine; people: number }>();
  for (const occurrence of expandRange(lines, from, to)) {
    const line = lines[occurrence.line]!;
    if (line.unit === "visit") visits += occurrence.people;
    else shifts += occurrence.people;
    if (!priced) continue;
    const version = rateCardInForce(versions, occurrence.date, contract.endDate);
    const rate = findRateLine(version, headcountRateKey(line));
    if (!version || !rate) {
      unpricedOccurrences += occurrence.people;
      continue;
    }
    const key = `${occurrence.line}|${version.id}`;
    const group = groups.get(key);
    if (group) group.people += occurrence.people;
    else groups.set(key, { line: occurrence.line, rate, people: occurrence.people });
  }
  const amounts: Kobo[] = [];
  for (const group of groups.values()) {
    const line = lines[group.line]!;
    const amount = priceOccurrences(
      group.rate,
      line.unit,
      group.people,
      durationMinutes(line.startTime, line.endTime),
    );
    if (amount === null) unpricedOccurrences += group.people;
    else amounts.push(amount);
  }
  return { shifts, visits, billableKobo: sumKobo(amounts), unpricedOccurrences };
}

/**
 * The day whose rates the weekly total uses: today, or the start date for a contract that hasn't
 * started, or the end date for one that has ended.
 */
export function pricingDate(today: string, startDate: string, endDate: string | null): string {
  if (today < startDate) return startDate;
  if (endDate !== null && today > endDate) return endDate;
  return today;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

/** "28 shifts a week", "5 visits a week", "14 shifts and 5 visits a week". */
export function formatWeeklyCounts(totals: Pick<HeadcountTotals, "shifts" | "visits">): string {
  const parts: string[] = [];
  if (totals.shifts > 0 || totals.visits === 0)
    parts.push(plural(totals.shifts, "shift", "shifts"));
  if (totals.visits > 0) parts.push(plural(totals.visits, "visit", "visits"));
  return `${parts.join(" and ")} a week`;
}

/**
 * The Headcount tab's total line: "4 posts · 28 shifts a week · ₦385,000 a week at today's
 * rates". `ratesLabel` says which rates ("at today's rates", "at the rates from 1 Dec 2026").
 */
export function formatHeadcountTotals(
  totals: HeadcountTotals & { priced?: boolean },
  ratesLabel: string,
): string {
  const parts = [plural(totals.posts, "post", "posts"), formatWeeklyCounts(totals)];
  if (totals.priced !== false && totals.weeklyKobo !== null) {
    parts.push(`${formatRate(totals.weeklyKobo)} a week ${ratesLabel}`);
  }
  return parts.join(" · ");
}

/** "at today's rates", or "at the rates from 1 Dec 2026" for another day. */
export function ratesLabel(date: string, today: string): string {
  return date === today ? "at today's rates" : `at the rates on ${formatDate(date)}`;
}

/** "No rate for Guard · Night". */
export function missingRateMessage(line: Pick<HeadcountLine, "role" | "band" | "unit">): string {
  const unit = line.unit === "hour" ? " an hour" : line.unit === "visit" ? " a visit" : "";
  return `No rate for ${formatRoleBand(line)}${unit}`;
}

// ---------------------------------------------------------------------------
// Typed input
// ---------------------------------------------------------------------------

/** One row as typed in the editor: every value is text, the days a list. */
export interface HeadcountInput {
  siteId: string;
  postName: string;
  role: string;
  band: string;
  unit: string;
  days: string[];
  startTime: string;
  endTime: string;
  requiredCount: string;
  notes: string;
}

export type HeadcountField = keyof HeadcountInput;

export type ParsedHeadcount =
  | { ok: true; line: Omit<HeadcountLine, "id"> }
  | { ok: false; errors: Partial<Record<HeadcountField, string>> };

const PLAIN_TEXT = /^[^\u0000-\u001f\u007f-\u009f<>]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plainText(value: string, label: string, max: number): string | null {
  if (value.length > max) return `${label} must be ${max} characters or fewer`;
  if (!PLAIN_TEXT.test(value) || /:\/\/|www\./i.test(value)) return `${label} must be plain text`;
  return null;
}

function quarterHour(text: string): number | null {
  const minutes = minutesOf(text);
  return minutes !== null && minutes % 15 === 0 ? minutes : null;
}

/** One typed row as a headcount line, or every problem with it, keyed by field. */
export function parseHeadcountInput(input: HeadcountInput): ParsedHeadcount {
  const errors: Partial<Record<HeadcountField, string>> = {};
  const siteId = input.siteId.trim();
  if (!UUID.test(siteId)) errors.siteId = "Choose the site";

  const postName = input.postName.trim();
  const postProblem = postName ? plainText(postName, "Post", 80) : null;
  if (postProblem) errors.postName = postProblem;

  const role = input.role.trim();
  if (!role) errors.role = "Enter the role, like Guard";
  else {
    const problem = plainText(role, "Role", 80);
    if (problem) errors.role = problem;
  }

  const band = input.band.trim() === "" ? STANDARD_BAND : input.band.trim();
  const bandProblem = plainText(band, "Band", 40);
  if (bandProblem) errors.band = bandProblem;

  if (!(HEADCOUNT_UNITS as readonly string[]).includes(input.unit)) {
    errors.unit = "Choose what each shift is billed per";
  }

  const days = [...new Set(input.days.map((d) => d.trim()))];
  const daysOfWeek = days.map(Number).sort((a, b) => a - b);
  if (days.length === 0) errors.days = "Choose at least one day";
  else if (!days.every((d) => /^[1-7]$/.test(d))) errors.days = "Choose days from Monday to Sunday";

  const start = quarterHour(input.startTime);
  if (start === null) errors.startTime = "Enter a start time on the quarter hour, like 06:00";
  const end = quarterHour(input.endTime);
  if (end === null) errors.endTime = "Enter an end time on the quarter hour, like 18:00";

  const countText = input.requiredCount.trim();
  const count = /^\d{1,3}$/.test(countText) ? Number(countText) : NaN;
  if (!(count >= 1 && count <= MAX_REQUIRED_COUNT)) {
    errors.requiredCount = `Enter how many people, from 1 to ${MAX_REQUIRED_COUNT}`;
  }

  const notes = input.notes.replace(/\r\n?/g, "\n").trim();
  if (notes.length > 500) errors.notes = "Notes must be 500 characters or fewer";
  else if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f<>]/u.test(notes)) {
    errors.notes = "Notes must be plain text";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    line: {
      siteId,
      postName: postName || null,
      role,
      band,
      unit: input.unit as HeadcountUnit,
      daysOfWeek,
      startTime: input.startTime.trim().slice(0, 5),
      endTime: input.endTime.trim().slice(0, 5),
      requiredCount: count,
      notes: notes || null,
    },
  };
}

/** A stored line as the editor shows it. */
export function toHeadcountInput(line: Omit<HeadcountLine, "id">): HeadcountInput {
  return {
    siteId: line.siteId,
    postName: line.postName ?? "",
    role: line.role,
    band: isStandardBand(line.band) ? "" : line.band,
    unit: line.unit,
    days: line.daysOfWeek.map(String),
    startTime: toHourMinute(line.startTime),
    endTime: toHourMinute(line.endTime),
    requiredCount: String(line.requiredCount),
    notes: line.notes ?? "",
  };
}

// ---------------------------------------------------------------------------
// Preview of a change (Lira groundwork 3)
// ---------------------------------------------------------------------------

export interface HeadcountChangePreview {
  /** One sentence, numbers first. */
  summary: string;
  changes: { label: string; before?: string; after: string }[];
}

/** "7 shifts a week · ₦87,500 a week", or the flag. */
export function describeRow(row: PricedRow, priced: boolean): string {
  const counts = formatWeeklyCounts(
    row.line.unit === "visit"
      ? { shifts: 0, visits: row.perWeek }
      : { shifts: row.perWeek, visits: 0 },
  );
  if (!priced) return counts;
  if (row.weeklyKobo === null) return `${counts} · ${missingRateMessage(row.line)}`;
  return `${counts} · ${formatRate(row.weeklyKobo)} a week`;
}

/**
 * What adding, changing or removing rows does to the plan: the rows that change and the weekly
 * total before and after, at `version`'s rates. The screen shows it beside the form and the
 * server and the ops agent's card use it as the write's preview.
 */
export function previewHeadcountChange(args: {
  before: readonly HeadcountLine[];
  after: readonly HeadcountLine[];
  version: Pick<RateCardVersion, "lines"> | null;
  contractType: string;
  siteName: (siteId: string) => string;
  ratesLabel: string;
}): HeadcountChangePreview {
  const before = weeklyHeadcount(args.before, args.version, args.contractType);
  const after = weeklyHeadcount(args.after, args.version, args.contractType);
  const priced = after.priced;
  const changes: HeadcountChangePreview["changes"] = [];
  const oldById = new Map(before.rows.map((r) => [r.line.id, r]));
  const newIds = new Set(after.rows.map((r) => r.line.id));
  const where = (row: PricedRow) => `${row.label} at ${args.siteName(row.line.siteId)}`;
  const verbs: string[] = [];
  for (const row of after.rows) {
    const old = oldById.get(row.line.id);
    const text = `${formatDays(row.line.daysOfWeek)} ${formatHours(row.line)} × ${row.line.requiredCount}: ${describeRow(row, priced)}`;
    if (!old) {
      changes.push({ label: where(row), after: text });
      verbs.push(`adds ${where(row)}`);
    } else {
      const oldText = `${formatDays(old.line.daysOfWeek)} ${formatHours(old.line)} × ${old.line.requiredCount}: ${describeRow(old, priced)}`;
      if (oldText !== text || where(old) !== where(row)) {
        changes.push({ label: where(row), before: oldText, after: text });
        verbs.push(`changes ${where(row)}`);
      }
    }
  }
  for (const row of before.rows) {
    if (newIds.has(row.line.id)) continue;
    changes.push({ label: where(row), before: describeRow(row, priced), after: "Removed" });
    verbs.push(`removes ${where(row)}`);
  }
  const totalBefore = formatHeadcountTotals({ ...before, priced }, args.ratesLabel);
  const totalAfter = formatHeadcountTotals({ ...after, priced }, args.ratesLabel);
  changes.push({ label: "Weekly total", before: totalBefore, after: totalAfter });
  const what = verbs.length ? verbs.join("; ") : "changes nothing";
  const flag =
    after.unpriced > 0 ? ` ${plural(after.unpriced, "row has", "rows have")} no rate.` : "";
  return {
    summary: `${what.charAt(0).toUpperCase()}${what.slice(1)}. ${totalAfter}.${flag}`,
    changes,
  };
}
