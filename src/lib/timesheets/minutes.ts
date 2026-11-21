/**
 * Timesheet days from punches (slice 4.2). The database works the minutes out
 * (private.timesheet_line_compute and private.timesheet_period_start in migration
 * 20261121120000); this mirror keeps the same rules for the unit tests, the screens and Lira.
 * tests/rls/timesheets.test.ts checks the two agree.
 *
 * Minutes are whole integers, never negative. Times are truncated to the minute. No money.
 */

/** Every exception a line can carry, in the order the database lists them. */
export const TIMESHEET_EXCEPTIONS = [
  "no_shift",
  "late",
  "early_out",
  "overtime",
  "no_clock_out",
  "no_show",
  "shift_removed",
  "outside",
  "near",
  "no_location",
  "no_selfie",
  "clock_drift",
  "double_in",
  "out_without_in",
  "delayed",
  "late_sync",
  "time_unverified",
  "supervisor",
  "corrected",
] as const;

export type TimesheetException = (typeof TIMESHEET_EXCEPTIONS)[number];

/** Punch flags copied onto the line (no_shift, late and early_out are the line's own rules). */
export const COPIED_PUNCH_FLAGS: readonly TimesheetException[] = [
  "outside",
  "near",
  "no_location",
  "no_selfie",
  "clock_drift",
  "double_in",
  "out_without_in",
  "delayed",
  "late_sync",
  "time_unverified",
];

/** Punch flags that mean the time rests on the phone's word (owner decision 12). */
export const REVIEW_PUNCH_FLAGS: readonly TimesheetException[] = [
  "delayed",
  "late_sync",
  "time_unverified",
];

/** A shift's punch window stays open this long after it ends (slice 3.5's matching). */
export const CLOCK_OUT_WINDOW_MINUTES = 240;

/** A no-shift clock-in pairs with a clock-out within this long (slice 3.5's 20 hours). */
export const NO_SHIFT_PAIR_MINUTES = 1200;

/** Plain-English label for each exception, for managers' screens and Lira. */
export const TIMESHEET_EXCEPTION_LABELS: Record<TimesheetException, string> = {
  no_shift: "No shift",
  late: "Late",
  early_out: "Left early",
  overtime: "Overtime",
  no_clock_out: "No clock-out",
  no_show: "No-show",
  shift_removed: "Taken off the shift",
  outside: "Outside the site",
  near: "Near the site",
  no_location: "No location",
  no_selfie: "No selfie",
  clock_drift: "Phone clock wrong",
  double_in: "Clocked in twice",
  out_without_in: "Clock-out without clock-in",
  delayed: "Time not checked live",
  late_sync: "Sent late",
  time_unverified: "Time not checked",
  supervisor: "Clocked in by supervisor",
  corrected: "Corrected",
};

export interface LineInput {
  /** The shift (ms epoch), or null for a clock-in that matched no shift. */
  startsAt: number | null;
  endsAt: number | null;
  /** The clock-in and clock-out that count (after corrections), or null. */
  inAt: number | null;
  outAt: number | null;
  /** A set_minutes correction: worked and overtime minutes. */
  setMinutes: number | null;
  setOtMinutes: number | null;
  inFlags: readonly string[];
  outFlags: readonly string[];
  bySupervisor: boolean;
  corrected: boolean;
  shiftRemoved: boolean;
  graceMinutes: number;
  noShowAfterMinutes: number;
  now: number;
}

export interface LineMinutes {
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  otMinutes: number;
  exceptions: TimesheetException[];
  needsReview: boolean;
}

const minute = (ms: number) => Math.floor(ms / 60_000);

/**
 * The minutes and exceptions of one line:
 * - clock-in within the grace period: worked from the rostered start (decision 4); beyond it:
 *   from the clock-in, late minutes from the start, `late`;
 * - clock-out before the end: to the clock-out, early minutes, `early_out`; after it: worked stops
 *   at the end and the rest is overtime, `overtime`;
 * - no clock-out once the punch window has closed (end + 4 hours): 0, `no_clock_out` (decision
 *   5); no clock-in `noShowAfterMinutes` after the start: 0, `no_show`;
 * - a no-shift clock-in counts to its clock-out, else 0 and `no_clock_out` after 20 hours;
 * - a set_minutes correction replaces the worked and overtime minutes.
 */
export function computeLine(input: LineInput): LineMinutes {
  const grace = Math.max(input.graceMinutes, 0);
  const noShow = Math.max(input.noShowAfterMinutes, 0);
  const now = minute(input.now);
  const i = input.inAt === null ? null : minute(input.inAt);
  const o = input.outAt === null ? null : minute(input.outAt);
  const hits = new Set<TimesheetException>();
  let scheduled = 0;
  let worked = 0;
  let late = 0;
  let early = 0;
  let ot = 0;

  if (input.startsAt === null || input.endsAt === null) {
    hits.add("no_shift");
    if (input.setMinutes !== null) {
      worked = input.setMinutes;
      ot = input.setOtMinutes ?? 0;
    } else if (i !== null) {
      if (o !== null) worked = Math.max(0, o - i);
      else if (now >= i + NO_SHIFT_PAIR_MINUTES) hits.add("no_clock_out");
    }
  } else {
    const s = minute(input.startsAt);
    const e = minute(input.endsAt);
    scheduled = Math.max(0, e - s);
    if (input.setMinutes !== null) {
      worked = input.setMinutes;
      ot = input.setOtMinutes ?? 0;
    } else if (i === null) {
      if (now >= s + noShow) hits.add("no_show");
    } else {
      let start = s;
      if (i > s + grace) {
        start = i;
        late = Math.min(i - s, scheduled);
        hits.add("late");
      }
      if (o === null) {
        if (now >= e + CLOCK_OUT_WINDOW_MINUTES) hits.add("no_clock_out");
      } else {
        let end = e;
        if (o < e) {
          end = o;
          early = Math.min(e - o, scheduled);
          hits.add("early_out");
        } else {
          ot = Math.max(0, o - Math.max(e, i));
          if (ot > 0) hits.add("overtime");
        }
        worked = Math.max(0, end - start);
      }
    }
  }

  const flags = new Set<string>([...input.inFlags, ...input.outFlags]);
  const exceptions = TIMESHEET_EXCEPTIONS.filter(
    (name) =>
      hits.has(name) ||
      (COPIED_PUNCH_FLAGS.includes(name) && flags.has(name)) ||
      (name === "supervisor" && input.bySupervisor) ||
      (name === "corrected" && input.corrected) ||
      (name === "shift_removed" && input.shiftRemoved),
  );
  return {
    scheduledMinutes: scheduled,
    workedMinutes: Math.max(worked, 0),
    lateMinutes: late,
    earlyMinutes: early,
    otMinutes: Math.max(ot, 0),
    exceptions,
    needsReview: REVIEW_PUNCH_FLAGS.some((flag) => flags.has(flag)),
  };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function iso(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The first day of the pay period holding `date` (owner decision 7): the start day of its month
 * when the date is on or after it, else the start day of the month before. `startDay` is the
 * company's pay_cycle_start_day (1 to 28, default 20).
 */
export function periodStart(date: string, startDay: number): string {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`Not an ISO date: ${date}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return day >= startDay ? iso(year, month, startDay) : iso(year, month - 1, startDay);
}

/** The last day of the pay period starting `start` (the day before the same day next month). */
export function periodEnd(start: string): string {
  const match = ISO_DATE.exec(start);
  if (!match) throw new RangeError(`Not an ISO date: ${start}`);
  return iso(Number(match[1]), Number(match[2]) + 1, Number(match[3]) - 1);
}

/** The pay period holding `date`: its first and last day. */
export function periodFor(date: string, startDay: number): { start: string; end: string } {
  const start = periodStart(date, startDay);
  return { start, end: periodEnd(start) };
}

/**
 * A correction's reason (private.timesheet_reason_ok): plain text, 1 to 500 characters, no web
 * addresses and no runs of 10 or more digits (no phone, account or ID numbers; rule 9). Pass the
 * reason with its spaces collapsed and trimmed.
 */
export function correctionReasonOk(reason: string): boolean {
  return (
    reason === reason.trim() &&
    reason.length >= 1 &&
    reason.length <= 500 &&
    !/[\p{Cc}<>]/u.test(reason) &&
    !/(:\/\/|www\.)/i.test(reason) &&
    !/[0-9]([ -]*[0-9]){9,}/.test(reason)
  );
}

/** "12 h 20 min", "45 min", "0 min". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
