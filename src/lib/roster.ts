/**
 * The roster week (slice 3.2), pure and isomorphic so the server page and the browser agree.
 *
 * - Weeks start on Monday, by the company's calendar (dates are ISO strings, never shifted by a
 *   time zone). Nigeria keeps West Africa Time all year, so a week is always seven 24-hour days,
 *   but nothing here depends on that: times are formatted in the company's own zone.
 * - A shift belongs to the day it starts: a night shift from Sunday 18:00 to Monday 06:00 is in
 *   Sunday's column and Sunday's week, as `required_shifts` returns it.
 * - Required counts come from the requirement in force (`required_shifts`), never from the
 *   copies on shift rows; an assignment whose copied times differ from today's requirement is
 *   marked "Hours changed".
 * - No money: roster cost, billable and labour % wait for Phase 4 and 7.
 */

import { addDays, formatDate } from "./dates";
import { isoWeekday, WEEKDAY_SHORT } from "./headcount";

export const WEEKDAY_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The Monday on or before `iso`. */
export function mondayOf(iso: string): string {
  return addDays(iso, 1 - isoWeekday(iso));
}

/** The seven dates of the week starting `weekStart` (a Monday). */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** The last day (Sunday) of the week starting `weekStart`. */
export function weekEnd(weekStart: string): string {
  return addDays(weekStart, 6);
}

/** A `?week=` value as the Monday of its week; anything else is this week's Monday. */
export function parseWeekParam(raw: string | undefined | null, today: string): string {
  if (raw && ISO_DATE.test(raw)) {
    try {
      return mondayOf(raw);
    } catch {
      // fall through to this week
    }
  }
  return mondayOf(today);
}

/** "Week of 23 Nov 2026". */
export function formatWeekOf(weekStart: string): string {
  return `Week of ${formatDate(weekStart)}`;
}

/** "Mon" and "23". */
export function dayLabel(iso: string): { short: string; long: string; date: string } {
  const day = isoWeekday(iso);
  return {
    short: WEEKDAY_SHORT[day - 1] ?? "",
    long: WEEKDAY_LONG[day - 1] ?? "",
    date: String(Number(iso.slice(8, 10))),
  };
}

/** "Mon 23 Nov". */
export function formatShortDay(iso: string): string {
  const { short, date } = dayLabel(iso);
  return `${short} ${date} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""}`;
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

function timeFormat(timeZone: string): Intl.DateTimeFormat {
  let format = timeFormats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      format = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Lagos",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    timeFormats.set(timeZone, format);
  }
  return format;
}

/** "18:00" in the company's time zone. */
export function timeIn(timestamp: string, timeZone: string): string {
  return timeFormat(timeZone).format(new Date(timestamp));
}

/** "18:00–06:00". */
export function formatShiftHours(startsAt: string, endsAt: string, timeZone: string): string {
  return `${timeIn(startsAt, timeZone)}–${timeIn(endsAt, timeZone)}`;
}

/** Minutes between two timestamps. */
export function minutesBetween(startsAt: string, endsAt: string): number {
  return Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
}

/** "36 h", "37.5 h". */
export function formatHoursTotal(minutes: number): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

/** One row of `required_shifts` for the site and week. */
export interface RequiredShift {
  postId: string;
  postName: string;
  siteId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  requiredCount: number;
}

/** One assigned worker on a post-day. */
export interface RosterAssignment {
  id: string;
  shiftId: string;
  postId: string;
  date: string;
  workerId: string;
  workerName: string;
  staffId: string;
  startsAt: string;
  endsAt: string;
  /** Mapped to the site that day (worker_assignments). */
  mapped: boolean;
}

export interface RosterCell {
  date: string;
  /** People required that day; null when the post isn't staffed that day. */
  required: number | null;
  startsAt: string | null;
  endsAt: string | null;
  assigned: (RosterAssignment & { hoursChanged: boolean })[];
  /** Places still to fill (never negative). */
  open: number;
}

export interface RosterPostRow {
  postId: string;
  name: string;
  /** "06:00–18:00": the hours on most days this week. */
  hours: string;
  cells: RosterCell[];
}

export interface RosterDay {
  date: string;
  required: number;
  scheduled: number;
  /** Fewer scheduled than required. */
  gap: boolean;
}

export interface UncoveredShift {
  postId: string;
  postName: string;
  date: string;
  startsAt: string;
  endsAt: string;
  open: number;
}

export interface RosterWeek {
  weekStart: string;
  days: RosterDay[];
  posts: RosterPostRow[];
  /** Person-shifts required, filled and still open this week. */
  totals: { required: number; covered: number; open: number };
  uncovered: UncoveredShift[];
}

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>();
  let best = values[0] ?? "";
  for (const value of values) {
    const n = (counts.get(value) ?? 0) + 1;
    counts.set(value, n);
    if (n > (counts.get(best) ?? 0)) best = value;
  }
  return best;
}

/**
 * The grid for one site and week: a row per post (required that week, or with someone assigned),
 * a cell per day with the people required and who is assigned, the day totals and the uncovered
 * shifts. `required` and `assignments` should already be for the site; dates outside the week are
 * ignored.
 */
export function buildRosterWeek(input: {
  weekStart: string;
  required: readonly RequiredShift[];
  assignments: readonly RosterAssignment[];
  postNames?: Readonly<Record<string, string>>;
  timeZone: string;
}): RosterWeek {
  const dates = weekDates(input.weekStart);
  const inWeek = new Set(dates);
  const required = input.required.filter((r) => inWeek.has(r.date));
  const assignments = input.assignments.filter((a) => inWeek.has(a.date));

  const byKey = new Map<string, RequiredShift>();
  for (const r of required) byKey.set(`${r.postId}|${r.date}`, r);
  const assignedByKey = new Map<string, RosterAssignment[]>();
  for (const a of assignments) {
    const key = `${a.postId}|${a.date}`;
    const list = assignedByKey.get(key) ?? [];
    list.push(a);
    assignedByKey.set(key, list);
  }

  // Posts in order of their earliest start time of day, then name.
  const postOrder = new Map<string, { name: string; firstMinute: number }>();
  for (const r of required) {
    const minute = Math.round(
      (Date.parse(r.startsAt) - Date.parse(`${r.date}T00:00:00Z`)) / 60_000,
    );
    const seen = postOrder.get(r.postId);
    if (!seen || minute < seen.firstMinute) {
      postOrder.set(r.postId, { name: r.postName, firstMinute: minute });
    }
  }
  for (const a of assignments) {
    if (!postOrder.has(a.postId)) {
      postOrder.set(a.postId, {
        name: input.postNames?.[a.postId] ?? "Post",
        firstMinute: Number.MAX_SAFE_INTEGER,
      });
    }
  }
  const postIds = [...postOrder.entries()]
    .sort(([, a], [, b]) => a.firstMinute - b.firstMinute || a.name.localeCompare(b.name))
    .map(([id]) => id);

  const dayTotals = dates.map((date) => ({ date, required: 0, scheduled: 0, gap: false }));
  const uncovered: UncoveredShift[] = [];
  let covered = 0;
  let requiredTotal = 0;

  const posts: RosterPostRow[] = postIds.map((postId) => {
    const meta = postOrder.get(postId)!;
    const hours: string[] = [];
    const cells: RosterCell[] = dates.map((date, i) => {
      const req = byKey.get(`${postId}|${date}`) ?? null;
      const list = (assignedByKey.get(`${postId}|${date}`) ?? [])
        .slice()
        .sort((a, b) => a.workerName.localeCompare(b.workerName));
      const assigned = list.map((a) => ({
        ...a,
        hoursChanged:
          req !== null &&
          (Date.parse(a.startsAt) !== Date.parse(req.startsAt) ||
            Date.parse(a.endsAt) !== Date.parse(req.endsAt)),
      }));
      const day = dayTotals[i]!;
      day.scheduled += assigned.length;
      let open = 0;
      if (req) {
        hours.push(formatShiftHours(req.startsAt, req.endsAt, input.timeZone));
        open = Math.max(0, req.requiredCount - assigned.length);
        day.required += req.requiredCount;
        requiredTotal += req.requiredCount;
        covered += Math.min(assigned.length, req.requiredCount);
        if (open > 0) {
          uncovered.push({
            postId,
            postName: req.postName,
            date,
            startsAt: req.startsAt,
            endsAt: req.endsAt,
            open,
          });
        }
      }
      return {
        date,
        required: req ? req.requiredCount : null,
        startsAt: req?.startsAt ?? null,
        endsAt: req?.endsAt ?? null,
        assigned,
        open,
      };
    });
    return { postId, name: meta.name, hours: mostCommon(hours), cells };
  });

  for (const day of dayTotals) day.gap = day.scheduled < day.required;
  uncovered.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
      a.postName.localeCompare(b.postName),
  );

  return {
    weekStart: input.weekStart,
    days: dayTotals,
    posts,
    totals: { required: requiredTotal, covered, open: requiredTotal - covered },
    uncovered,
  };
}

/** "26 of 28 shifts covered · 2 open". */
export function formatCoverage(totals: RosterWeek["totals"]): string {
  const noun = totals.required === 1 ? "shift" : "shifts";
  return `${totals.covered} of ${totals.required} ${noun} covered · ${totals.open} open`;
}

/** "Required 4 · Scheduled 3". */
export function formatDayCounts(day: Pick<RosterDay, "required" | "scheduled">): string {
  return `Required ${day.required} · Scheduled ${day.scheduled}`;
}

/** A post-day the live board asked the roster to open (slice 3.7, Send replacement). */
export interface RosterFocus {
  postId: string;
  date: string;
  /** The late or no-show worker's assignment, to take off the shift first. */
  assignmentId: string | null;
}

export interface ReplacementTarget {
  postId: string;
  postName: string;
  date: string;
  startsAt: string;
  endsAt: string;
  /** Still on the shift: remove first, then pick someone. Null when the place is already open. */
  remove: { assignmentId: string; workerName: string } | null;
}

/**
 * What Send replacement opens on the roster: the worker's assignment to remove (the shift is full
 * while they are on it), then the assign picker for the same post-day. Null when the post-day
 * isn't on this week, has no times, or has nothing to replace and no open place.
 */
export function replacementTarget(week: RosterWeek, focus: RosterFocus): ReplacementTarget | null {
  const post = week.posts.find((p) => p.postId === focus.postId);
  const cell = post?.cells.find((c) => c.date === focus.date);
  if (!post || !cell || !cell.startsAt || !cell.endsAt) return null;
  const current = focus.assignmentId
    ? cell.assigned.find((a) => a.id === focus.assignmentId)
    : undefined;
  if (!current && cell.open === 0) return null;
  return {
    postId: post.postId,
    postName: post.name,
    date: cell.date,
    startsAt: cell.startsAt,
    endsAt: cell.endsAt,
    remove: current ? { assignmentId: current.id, workerName: current.workerName } : null,
  };
}
