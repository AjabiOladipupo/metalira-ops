/**
 * The earnings stage (slice 5.1, docs/PHASE_5.md "Earnings rules (5.1)"): one worker's pay
 * inputs for a cycle in, earning lines and the trace steps out. Pure and isomorphic; the
 * gross-to-net stage (5.0) continues from the lines.
 *
 * Money is `bigint` kobo throughout. Every amount is first kept as an exact fraction and rounded
 * once, half up, at the final value of its line (RULES_NIGERIA "Rounding"); splits use
 * `allocateKobo` so the parts sum to the whole. Minutes and days are integers.
 *
 * The rules (pay policy, RULES_NIGERIA "Pay policy", owner 15 Nov 2026; the plan's defaults for
 * open questions 1 to 5 and 8, and its "Choices made in this plan"):
 * - Monthly salary: each pay version's components x that version's rostered employed days ÷
 *   rostered days in the full cycle, rounded once per version and split across the components
 *   with allocateKobo. Employed the whole cycle on one version: exactly the monthly components.
 * - Normal hourly rate: monthly gross (basic + housing + transport + other allowances) ÷
 *   (hourly_rate_divisor_days x standard shift hours); daily rate ÷ standard shift hours; the
 *   hourly rate. Kept as a fraction, always of the version in force on the day.
 * - Overtime: approved ot_minutes at the hourly rate x the multiplier (1.0x until Phase 8), one
 *   line per pay version. Only time past the assigned shift's end is overtime: that is how
 *   timesheet lines count ot_minutes (slice 4.2), so a 12-hour shift worked in full has none.
 * - Off-day work (monthly pay): a day with approved minutes, no shift and off in the calendar, or a shift beyond
 *   work_days_per_week in its ISO week (the latest days are the extra ones), pays a flat
 *   off_day_paid_minutes (480) at the overtime rate instead of its minutes.
 * - Public holidays: every minute worked on one (worked plus overtime) is paid once, at the
 *   overtime rate, on top of normal pay (its overtime minutes are not paid again as overtime); a
 *   monthly worker keeps full pay for a rostered holiday not worked.
 *   A day that is both an off day and a holiday pays the larger of the two, never both.
 * - Leave (monthly pay): one deduction per approved request, monthly gross x the request's
 *   rostered working days in the cycle ÷ rostered days in the cycle x (100 − pay percent)%, the
 *   same base as proration, so a fully unpaid cycle pays 0. Public holidays are left out of a
 *   working-day leave's days (as the 4.4 leave counter does) but stay in the base; calendar-day
 *   leave keeps them. Below the pay's service (preset A
 *   maternity under 6 months) the leave is unpaid. The deduction is split across the salary
 *   components with allocateKobo so the pension and NHF bases fall with it.
 * - Daily pay: daily rate x the dates with an approved line with worked minutes above 0 (a date
 *   counts once). Hourly pay: approved worked minutes x hourly rate ÷ 60. Daily and hourly pay
 *   get no leave pay or deduction and no off-day rule (they are paid for what they work).
 * - Arrears: an approved day from a cycle already posted, priced by the same rules at the rate
 *   on that day, without the salary a monthly worker was already paid; one line per earlier
 *   cycle.
 * - Absence without leave is flagged (no-show and rejected days), never deducted.
 * - Leave arrears (slice 5.7c): unpaid or part-paid leave approved after its period was posted is
 *   worked out by the same leave rule, on that period's own rostered days (the posted payslip's
 *   base and the worker's shifts then), and recovered now as an after-tax deduction (RULES_NIGERIA
 *   open point 5's default for clawbacks: taxable pay and pension of the later month aren't
 *   reduced; open point 10 asks the adviser). It is cut to fit net pay like any deduction; the
 *   rest is carried (open question 6). One deduction per leave request and period, its days the
 *   source; one with no working days left records ₦0 so it isn't looked at again.
 * - Leave refunds (slice 5.7c): leave cancelled after a posted payslip deducted it is paid back
 *   line by line, exactly what each line took: a leave deduction's earning lines as they were
 *   (pensionable and taxable), an after-tax leave arrears line as an earning outside tax and
 *   pension, in full (what it took plus what it carried, so the carried rest nets to ₦0).
 */

import { addDays } from "@/lib/dates";
import { isoWeekday } from "@/lib/leave/days";
import { formatLeaveRange } from "@/lib/leave/requests";
import { allocateKobo, formatNaira, roundHalfUp, type Kobo } from "@/lib/money";
import { formatMinutes, periodEnd } from "@/lib/timesheets/minutes";

import type { DeductionLine } from "./contract";
import type { EarningCode, EarningLine, PaySourceRef, TraceStep } from "./earning-lines";
import {
  outsidePattern,
  rosteredCalendar,
  type ArrearsDayInput,
  type CalendarDay,
  type LeaveArrearsInput,
  type LeaveInput,
  type LeaveRefundInput,
  type PayPeriod,
  type PayRateInput,
  type TimesheetDayInput,
} from "./inputs";

export interface PayPolicy {
  /** organisations.standard_shift_minutes (480). */
  standardShiftMinutes: number;
  /** organisations.hourly_rate_divisor_days (20). */
  hourlyRateDivisorDays: number;
  /** organisations.work_days_per_week (5). */
  workDaysPerWeek: number;
  /** The rule set policy's overtime multiplier in basis points (10000 = 1.0x). */
  overtimeMultiplierBps: number;
  /** The rule set policy's flat pay for off-day work, in minutes (480). */
  offDayPaidMinutes: number;
}

/**
 * The policy figures that live in the rule set's `policy` part (slice 5.0's `tax_rule_sets`);
 * the owner's starting values. Slice 5.2 takes them from the rule set in force on each day
 * (`EarningsInput.policyOn`), arrears days included.
 */
export const POLICY_DEFAULTS = { overtimeMultiplierBps: 10_000, offDayPaidMinutes: 480 } as const;

/** The policy figures that can change by day (a dated rule set version). */
export type DayPolicy = Partial<Pick<PayPolicy, "overtimeMultiplierBps" | "offDayPaidMinutes">>;

export interface EarningsWorker {
  workerId: string;
  employmentType: "permanent" | "contract" | "casual" | "daily";
  startDate: string;
  endDate: string | null;
  usualWorkDays: readonly number[] | null;
  payRates: readonly PayRateInput[];
  shifts: readonly { date: string; onLeave: boolean }[];
  lastRostered: string | null;
  lines: readonly TimesheetDayInput[];
  arrears: readonly ArrearsDayInput[];
  leave: readonly LeaveInput[];
  noShowDates: readonly string[];
  openLineCount: number;
  /** Slice 5.7c: leave approved after its period was posted (deducted now). */
  leaveArrears?: readonly LeaveArrearsInput[];
  /** Slice 5.7c: leave cancelled after a posted payslip deducted it (refunded now). */
  leaveRefunds?: readonly LeaveRefundInput[];
}

export interface EarningsInput {
  period: Pick<PayPeriod, "start" | "end">;
  /** The company's live public holidays (ISO dates); earlier ones too when arrears need them. */
  holidays: readonly string[];
  /** organisations.default_work_days. */
  defaultWorkDays: readonly number[];
  worker: EarningsWorker;
  /**
   * The rule set's policy in force on a day (overtime multiplier, off-day minutes), for days
   * worked and arrears days. Left out, or a figure missing: the `policy` argument's. NOTE for
   * 5.2: pass the dated rule set version in force on each day.
   */
  policyOn?: (date: string) => DayPolicy;
}

export type EarningsFlag =
  | "no_pay_rate"
  | "no_rostered_days"
  | "leave_pay_missing"
  | "no_show_days"
  | "open_timesheet_days"
  /** Days outside employment counted on the company's days for a worker who has a roster. */
  | "roster_pattern_unknown";

export interface EarningsResult {
  workerId: string;
  lines: EarningLine[];
  /** Slice 5.7c: leave arrears, recovered after tax (before the run's adjustments). */
  deductions?: DeductionLine[];
  trace: TraceStep[];
  flags: EarningsFlag[];
  days: {
    /** Calendar days in the cycle. */
    cycle: number;
    /** Rostered working days in the full cycle (the proration base). */
    rostered: number;
    /** Rostered working days inside the worker's employment. */
    employedRostered: number;
    /** Leave days deducted (rostered working days of unpaid or part-paid leave). */
    leaveDeducted: number;
    /** Dates in the cycle with a no-show or rejected day (flagged only). */
    noShowDates: string[];
    /** Employed working days or worked days with no pay rate in force. */
    unratedDates: string[];
  };
  /** The pay versions the lines used. */
  payRateIds: string[];
}

// ---------------------------------------------------------------------------
// Exact fractions of kobo
// ---------------------------------------------------------------------------

interface Fraction {
  num: bigint;
  den: bigint;
}

const ZERO: Fraction = { num: 0n, den: 1n };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function frac(num: bigint, den: bigint): Fraction {
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function add(a: Fraction, b: Fraction): Fraction {
  return frac(a.num * b.den + b.num * a.den, a.den * b.den);
}

function scale(a: Fraction, by: bigint): Fraction {
  return frac(a.num * by, a.den);
}

function roundFraction(a: Fraction): Kobo {
  return roundHalfUp(a.num, a.den);
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

function monthlyGross(rate: PayRateInput): Kobo {
  return rate.basic + rate.housing + rate.transport + rate.otherAllowances;
}

/** The normal pay for one minute, in kobo, as a fraction (before any multiplier). */
function minuteRate(rate: PayRateInput, policy: PayPolicy): Fraction {
  switch (rate.payType) {
    case "monthly":
      return frac(
        monthlyGross(rate),
        BigInt(policy.hourlyRateDivisorDays) * BigInt(policy.standardShiftMinutes),
      );
    case "daily":
      return frac(rate.dailyRate, BigInt(policy.standardShiftMinutes));
    case "hourly":
      return frac(rate.hourlyRate, 60n);
  }
}

/** Value of `minutes` at the overtime rate (normal minute rate x the multiplier). */
function overtimeValue(rate: PayRateInput, minutes: number, policy: PayPolicy): Fraction {
  return frac(
    minuteRate(rate, policy).num * BigInt(minutes) * BigInt(policy.overtimeMultiplierBps),
    minuteRate(rate, policy).den * 10_000n,
  );
}

/** "₦750.00 an hour" (display only: the line itself is worked from the exact fraction). */
function hourlyLabel(rate: PayRateInput, policy: PayPolicy, overtime: boolean): string {
  const r = minuteRate(rate, policy);
  const mult = overtime ? BigInt(policy.overtimeMultiplierBps) : 10_000n;
  return `${formatNaira(roundHalfUp(r.num * 60n * mult, r.den * 10_000n))} an hour`;
}

function versionOn(rates: readonly PayRateInput[], date: string): PayRateInput | null {
  return (
    rates.find(
      (r) => r.effectiveFrom <= date && (r.effectiveTo === null || date <= r.effectiveTo),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

interface DayLines {
  date: string;
  worked: number;
  ot: number;
  anyShift: boolean;
  lineIds: string[];
}

/** Approved lines with minutes, one entry per date (a date counts once). */
function groupByDate(
  lines: readonly {
    id: string;
    workDate: string;
    workedMinutes: number;
    otMinutes: number;
    hasShift: boolean;
  }[],
): Map<string, DayLines> {
  const days = new Map<string, DayLines>();
  for (const line of lines) {
    if (line.workedMinutes + line.otMinutes <= 0) continue;
    const day = days.get(line.workDate) ?? {
      date: line.workDate,
      worked: 0,
      ot: 0,
      anyShift: false,
      lineIds: [],
    };
    day.worked += line.workedMinutes;
    day.ot += line.otMinutes;
    day.anyShift ||= line.hasShift;
    day.lineIds.push(line.id);
    days.set(line.workDate, day);
  }
  return days;
}

/** Monday of the ISO week holding `date`. */
function weekKey(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/**
 * Shift days beyond `perWeek` in their ISO week: the latest days are the extra ones. Counts dates
 * with an approved shift line with minutes, the days before the cycle in the same week included.
 */
function extraShiftDates(days: Map<string, DayLines>, perWeek: number): Set<string> {
  const weeks = new Map<string, string[]>();
  for (const day of days.values()) {
    if (!day.anyShift) continue;
    const key = weekKey(day.date);
    weeks.set(key, [...(weeks.get(key) ?? []), day.date]);
  }
  const extra = new Set<string>();
  for (const dates of weeks.values()) {
    dates.sort();
    dates.slice(perWeek).forEach((d) => extra.add(d));
  }
  return extra;
}

interface Contribution {
  code: Exclude<
    EarningCode,
    | "basic"
    | "housing"
    | "transport"
    | "other_allowances"
    | "leave_deduction"
    | "adjustment_earning"
    | "arrears"
    | "leave_refund"
  >;
  value: Fraction;
  minutes: number;
  days: number;
}

/**
 * What one worked date pays beyond a monthly worker's salary, by the day rules. `offDay` is
 * worked out by the caller (it needs the ISO week).
 */
function dayContributions(
  day: DayLines,
  rate: PayRateInput,
  offDay: boolean,
  holiday: boolean,
  policy: PayPolicy,
): Contribution[] {
  const out: Contribution[] = [];
  const holidayMinutes = day.worked + day.ot;
  if (rate.payType === "monthly" && offDay) {
    if (holiday && holidayMinutes > policy.offDayPaidMinutes) {
      out.push({
        code: "public_holiday",
        value: overtimeValue(rate, holidayMinutes, policy),
        minutes: holidayMinutes,
        days: 1,
      });
    } else {
      out.push({
        code: "off_day",
        value: overtimeValue(rate, policy.offDayPaidMinutes, policy),
        minutes: policy.offDayPaidMinutes,
        days: 1,
      });
    }
    return out;
  }
  if (rate.payType === "daily" && day.worked > 0) {
    out.push({ code: "daily_pay", value: frac(rate.dailyRate, 1n), minutes: day.worked, days: 1 });
  }
  if (rate.payType === "hourly" && day.worked > 0) {
    out.push({
      code: "hourly_pay",
      value: scale(minuteRate(rate, policy), BigInt(day.worked)),
      minutes: day.worked,
      days: 1,
    });
  }
  // On a public holiday every minute worked (worked plus overtime) is paid once, at the overtime
  // rate, on top of normal pay: its overtime minutes are in the holiday line, not here.
  if (day.ot > 0 && !holiday) {
    out.push({
      code: "overtime",
      value: overtimeValue(rate, day.ot, policy),
      minutes: day.ot,
      days: 1,
    });
  }
  if (holiday && holidayMinutes > 0) {
    out.push({
      code: "public_holiday",
      value: overtimeValue(rate, holidayMinutes, policy),
      minutes: holidayMinutes,
      days: 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const COMPONENTS = [
  { code: "basic", label: "Basic", pensionable: true, nhfBase: true },
  { code: "housing", label: "Housing", pensionable: true, nhfBase: false },
  { code: "transport", label: "Transport", pensionable: true, nhfBase: false },
  { code: "other_allowances", label: "Other allowances", pensionable: false, nhfBase: false },
] as const;

function componentAmounts(rate: PayRateInput): bigint[] {
  return [rate.basic, rate.housing, rate.transport, rate.otherAllowances];
}

const BUCKET_LABEL: Record<Contribution["code"], string> = {
  daily_pay: "Daily pay",
  hourly_pay: "Hourly pay",
  overtime: "Overtime",
  off_day: "Off-day work",
  public_holiday: "Public holiday work",
};

const ORDER: Record<EarningCode, number> = {
  basic: 0,
  housing: 1,
  transport: 2,
  other_allowances: 3,
  daily_pay: 4,
  hourly_pay: 5,
  overtime: 6,
  off_day: 7,
  public_holiday: 8,
  arrears: 9,
  adjustment_earning: 10,
  leave_deduction: 11,
  leave_refund: 12,
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function koboText(value: Fraction): string {
  return value.den === 1n ? value.num.toString() : `${value.num}/${value.den}`;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function clampRange(from: string, to: string | null, lo: string, hi: string): [string, string] {
  return [from > lo ? from : lo, to === null || to > hi ? hi : to];
}

/** The salary component a leave deduction line was for, from the engine's own label. */
function componentOf(label: string): (typeof COMPONENTS)[number] | null {
  const tail = label
    .slice(label.lastIndexOf(", ") + 2)
    .trim()
    .toLowerCase();
  return COMPONENTS.find((c) => c.label.toLowerCase() === tail) ?? null;
}

interface LeaveDeductionArgs {
  requestId: string;
  typeCode: string;
  counting: "working_days" | "calendar_days";
  percent: number;
  belowService: boolean;
  /** The leave's days inside the cycle the deduction is for. */
  from: string;
  to: string;
  /** That cycle's rostered working days while employed. */
  employedWorking: readonly CalendarDay[];
  /** That cycle's rostered days (the proration base). */
  rostered: number;
  holidays: ReadonlySet<string>;
  payRates: readonly PayRateInput[];
  /** "Unpaid leave, 5 Oct to 9 Oct"; the day count and component follow. */
  label: string;
  /** Closes the label after the day count (arrears put it inside brackets). */
  closeLabel?: string;
  /** At most this many days (arrears: the posted payslip's rostered days). */
  maxDays?: number;
  step: "leave_deduction" | "leave_arrears";
}

interface LeaveDeductionResult {
  lines: EarningLine[];
  trace: TraceStep;
  days: number;
  rates: string[];
}

/**
 * One leave request's deduction for one cycle (open questions 3 and 4): monthly gross x the
 * leave's rostered working days ÷ rostered days in the cycle x (100 − pay percent)%, rounded once
 * and split across the salary components with allocateKobo. Public holidays are left out of a
 * working-day leave's days (as the 4.4 leave counter does) but stay in the base; calendar-day leave
 * keeps them. Null when it deducts nothing.
 */
function leaveDeduction(a: LeaveDeductionArgs): LeaveDeductionResult | null {
  const perRate = new Map<string, { rate: PayRateInput; days: number }>();
  for (const day of a.employedWorking) {
    if (day.date < a.from || day.date > a.to) continue;
    if (a.counting === "working_days" && a.holidays.has(day.date)) continue;
    const rate = versionOn(a.payRates, day.date);
    if (!rate || rate.payType !== "monthly") continue;
    const entry = perRate.get(rate.id) ?? { rate, days: 0 };
    entry.days += 1;
    perRate.set(rate.id, entry);
  }
  if (a.maxDays !== undefined) {
    // Clamp from the latest days back, so the count never passes the base.
    let excess = [...perRate.values()].reduce((n, e) => n + e.days, 0) - a.maxDays;
    for (const e of [...perRate.values()].reverse()) {
      if (excess <= 0) break;
      const cut = Math.min(e.days, excess);
      e.days -= cut;
      excess -= cut;
    }
  }
  const days = [...perRate.values()].reduce((n, e) => n + e.days, 0);
  if (days === 0 || a.rostered === 0) return null;
  const unpaid = BigInt(100 - a.percent);
  const weights = COMPONENTS.map((_, i) =>
    [...perRate.values()].reduce(
      (sum, e) => sum + (componentAmounts(e.rate)[i] ?? 0n) * BigInt(e.days) * unpaid,
      0n,
    ),
  );
  const total = roundHalfUp(
    weights.reduce((x, y) => x + y, 0n),
    BigInt(a.rostered) * 100n,
  );
  if (total === 0n) return null;
  const parts = allocateKobo(total, weights);
  const label =
    a.closeLabel !== undefined
      ? `${a.label}, ${plural(days, "day")}${a.closeLabel}`
      : `${a.label} (${plural(days, "day")})`;
  const lines: EarningLine[] = [];
  COMPONENTS.forEach((component, i) => {
    const amount = parts[i] ?? 0n;
    if (amount === 0n) return;
    lines.push({
      code: "leave_deduction",
      label: `${label}, ${component.label.toLowerCase()}`,
      amountKobo: -amount,
      pensionable: component.pensionable,
      nhfBase: component.nhfBase,
      taxable: true,
      sources: [{ kind: "leave_request", id: a.requestId, from: a.from, to: a.to }],
    });
  });
  return {
    lines,
    days,
    rates: [...perRate.keys()],
    trace: {
      step: a.step,
      label,
      formula:
        "monthly gross x leave days ÷ rostered days in the cycle x (100 − pay percent)%, rounded once",
      inputs: {
        leave_days: days,
        rostered_days: a.rostered,
        pay_percent: a.percent,
        below_service: a.belowService ? 1 : 0,
        type: a.typeCode,
      },
      valueKobo: -total,
      ruleRef: a.belowService ? "leave.pay_below_service" : "leave.pay_percent",
    },
  };
}

/** The worker's earning lines for the cycle, with the trace (see the file header). */
export function computeEarnings(input: EarningsInput, policy: PayPolicy): EarningsResult {
  const { period, worker } = input;
  const holidays = new Set(input.holidays);
  const lines: EarningLine[] = [];
  const trace: TraceStep[] = [];
  const flags = new Set<EarningsFlag>();
  const usedRates = new Set<string>();
  const unrated = new Set<string>();

  // --- The rostered-day calendar -------------------------------------------------------------
  const calendar: CalendarDay[] = rosteredCalendar(period, worker, input.defaultWorkDays);
  const rostered = calendar.filter((d) => d.working).length;
  const employedWorking = calendar.filter((d) => d.working && d.employed);
  trace.push({
    step: "rostered_days",
    label: `${plural(rostered, "rostered working day")} in ${formatLeaveRange(period.start, period.end, false)}, ${employedWorking.length} while employed`,
    formula: "assigned shifts (leave removals included); else usual days; else company days",
    inputs: {
      cycle_days: calendar.length,
      rostered_days: rostered,
      employed_days: employedWorking.length,
    },
    valueKobo: null,
    ruleRef: "pay_policy.proration",
  });
  if (rostered === 0) flags.add("no_rostered_days");
  const workingOn = new Map(calendar.map((d) => [d.date, d.working]));
  if (
    calendar.some((d) => !d.employed) &&
    (worker.lastRostered !== null || worker.shifts.length > 0) &&
    outsidePattern(period, worker, input.defaultWorkDays).source === "company"
  ) {
    flags.add("roster_pattern_unknown");
  }
  const dayPolicy = (date: string): PayPolicy => {
    const on = input.policyOn?.(date) ?? {};
    return {
      ...policy,
      overtimeMultiplierBps: on.overtimeMultiplierBps ?? policy.overtimeMultiplierBps,
      offDayPaidMinutes: on.offDayPaidMinutes ?? policy.offDayPaidMinutes,
    };
  };

  for (const day of employedWorking) {
    if (!versionOn(worker.payRates, day.date)) unrated.add(day.date);
  }

  // --- Monthly salary ------------------------------------------------------------------------
  const monthlyRates = worker.payRates.filter((r) => r.payType === "monthly");
  const employedAll =
    worker.startDate <= period.start && (worker.endDate === null || worker.endDate >= period.end);
  const wholeCycleRate = employedAll
    ? (monthlyRates.find(
        (r) =>
          r.effectiveFrom <= period.start &&
          (r.effectiveTo === null || r.effectiveTo >= period.end),
      ) ?? null)
    : null;

  for (const rate of monthlyRates) {
    const [from, to] = clampRange(
      maxDate(rate.effectiveFrom, worker.startDate),
      minDate(rate.effectiveTo, worker.endDate),
      period.start,
      period.end,
    );
    // No rostered working days in the cycle: no salary at all (flagged no_rostered_days).
    if (from > to || rostered === 0) continue;
    let total: Kobo;
    let parts: Kobo[];
    let days: number;
    let formula: string;
    if (wholeCycleRate) {
      if (rate.id !== wholeCycleRate.id) continue;
      days = rostered;
      total = monthlyGross(rate);
      parts = componentAmounts(rate);
      formula = "monthly gross (employed the whole cycle on one pay rate)";
    } else {
      days = employedWorking.filter(
        (d) => versionOn(worker.payRates, d.date)?.id === rate.id,
      ).length;
      if (days === 0) continue;
      total = roundHalfUp(monthlyGross(rate) * BigInt(days), BigInt(rostered));
      parts = allocateKobo(total, componentAmounts(rate));
      formula = "monthly gross x rostered employed days ÷ rostered days in the cycle, rounded once";
    }
    usedRates.add(rate.id);
    const range = formatLeaveRange(from, to, false);
    const share = wholeCycleRate ? range : `${range} (${days} of ${rostered} days)`;
    COMPONENTS.forEach((component, i) => {
      const amount = parts[i] ?? 0n;
      if (amount === 0n) return;
      lines.push({
        code: component.code,
        label: `${component.label}, ${share}`,
        amountKobo: amount,
        pensionable: component.pensionable,
        nhfBase: component.nhfBase,
        taxable: true,
        sources: [{ kind: "pay_rate", id: rate.id, from, to }],
      });
    });
    trace.push({
      step: "salary",
      label: `Salary, ${share}`,
      formula,
      inputs: {
        monthly_gross_kobo: monthlyGross(rate).toString(),
        employed_rostered_days: days,
        rostered_days: rostered,
        basic_kobo: rate.basic.toString(),
        housing_kobo: rate.housing.toString(),
        transport_kobo: rate.transport.toString(),
        other_allowances_kobo: rate.otherAllowances.toString(),
      },
      valueKobo: total,
      ruleRef: "pay_policy.proration",
    });
  }

  // --- Worked days: daily and hourly pay, overtime, off days, public holidays ----------------
  const allDays = groupByDate(worker.lines);
  const extra = extraShiftDates(allDays, policy.workDaysPerWeek);
  interface Bucket {
    code: EarningCode;
    rate: PayRateInput | null;
    value: Fraction;
    minutes: number;
    days: number;
    sources: PaySourceRef[];
    periodStart?: string;
    policy: PayPolicy;
  }
  const buckets = new Map<string, Bucket>();
  const addTo = (
    key: string,
    seed: Omit<Bucket, "value" | "minutes" | "days" | "sources">,
    c: Contribution,
    day: DayLines,
    paidAsOffDay = false,
  ) => {
    const bucket = buckets.get(key) ?? { ...seed, value: ZERO, minutes: 0, days: 0, sources: [] };
    bucket.value = add(bucket.value, c.value);
    bucket.minutes += c.minutes;
    bucket.days += c.days;
    for (const id of day.lineIds) {
      if (!bucket.sources.some((s) => s.kind === "timesheet_line" && s.id === id)) {
        bucket.sources.push({
          kind: "timesheet_line",
          id,
          workDate: day.date,
          ...(paidAsOffDay ? { offDay: true } : {}),
        });
      }
    }
    buckets.set(key, bucket);
  };

  const cycleDays = [...allDays.values()]
    .filter((d) => d.date >= period.start && d.date <= period.end)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const day of cycleDays) {
    const rate = versionOn(worker.payRates, day.date);
    if (!rate) {
      unrated.add(day.date);
      continue;
    }
    usedRates.add(rate.id);
    // A no-shift day is an off day only when the calendar has it off: a clock-in on a fallback
    // working day is covered by salary (its overtime minutes are still paid).
    const offDay = (!day.anyShift && !workingOn.get(day.date)) || extra.has(day.date);
    const p = dayPolicy(day.date);
    for (const c of dayContributions(day, rate, offDay, holidays.has(day.date), p)) {
      addTo(
        `${c.code}|${rate.id}|${p.overtimeMultiplierBps}|${p.offDayPaidMinutes}`,
        { code: c.code, rate, policy: p },
        c,
        day,
        offDay && rate.payType === "monthly",
      );
    }
  }

  // --- Arrears: days from posted cycles approved after posting -------------------------------
  const arrearsDays = groupByDate(worker.arrears);
  const arrearsWeek = new Map(worker.arrears.map((a) => [a.workDate, a]));
  // Off days owed per ISO week: approved shift days past work_days_per_week, less the off days the
  // original run already paid for that week. The latest-ranked arrears days of the week carry
  // them, so a late-approved Monday in a six-shift week still brings the week's off day.
  const arrearsOffDays = new Set<string>();
  const byWeek = new Map<string, ArrearsDayInput[]>();
  for (const a of worker.arrears) {
    if (!a.hasShift || a.workedMinutes + a.otMinutes <= 0) continue;
    const key = weekKey(a.workDate);
    if (!byWeek.get(key)?.some((x) => x.workDate === a.workDate)) {
      byWeek.set(key, [...(byWeek.get(key) ?? []), a]);
    }
  }
  for (const days of byWeek.values()) {
    const first = days[0]!;
    const owed = Math.max(0, first.weekShiftDays - policy.workDaysPerWeek - first.weekOffDaysPaid);
    days
      .sort((x, y) => y.weekShiftRank - x.weekShiftRank || y.workDate.localeCompare(x.workDate))
      .slice(0, owed)
      .forEach((d) => arrearsOffDays.add(d.workDate));
  }
  for (const day of [...arrearsDays.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const meta = arrearsWeek.get(day.date);
    const rate = versionOn(worker.payRates, day.date);
    if (!meta || !rate) {
      unrated.add(day.date);
      continue;
    }
    usedRates.add(rate.id);
    // (The earlier cycle's calendar isn't gathered, so a no-shift arrears day is an off day.)
    const offDay = !day.anyShift || arrearsOffDays.has(day.date);
    const p = dayPolicy(day.date);
    for (const c of dayContributions(day, rate, offDay, holidays.has(day.date), p)) {
      addTo(
        `arrears|${meta.periodStart}`,
        { code: "arrears", rate: null, periodStart: meta.periodStart, policy: p },
        c,
        day,
        offDay && rate.payType === "monthly",
      );
    }
  }

  for (const bucket of buckets.values()) {
    const amount = roundFraction(bucket.value);
    if (bucket.code === "arrears") {
      const start = bucket.periodStart!;
      const end = periodEnd(start);
      const label = `Arrears, ${formatLeaveRange(start, end, false)}, approved after posting (${plural(bucket.days, "day")})`;
      lines.push({
        code: "arrears",
        label,
        amountKobo: amount,
        pensionable: false,
        nhfBase: false,
        taxable: true,
        sources: bucket.sources,
      });
      trace.push({
        step: "arrears",
        label,
        formula: "each day by the day rules at the pay rate on that day, rounded once",
        inputs: { days: bucket.days, minutes: bucket.minutes, exact_kobo: koboText(bucket.value) },
        valueKobo: amount,
        ruleRef: "earnings.arrears",
      });
      continue;
    }
    const rate = bucket.rate!;
    const code = bucket.code as Contribution["code"];
    const policy = bucket.policy;
    const label =
      code === "daily_pay"
        ? `Daily pay, ${plural(bucket.days, "day")} at ${formatNaira(rate.dailyRate)}`
        : code === "off_day"
          ? `Off-day work, ${plural(bucket.days, "day")} of ${formatMinutes(policy.offDayPaidMinutes)} at ${hourlyLabel(rate, policy, true)}`
          : `${BUCKET_LABEL[code]}, ${formatMinutes(bucket.minutes)} at ${hourlyLabel(rate, policy, code !== "hourly_pay")}`;
    lines.push({
      code,
      label,
      amountKobo: amount,
      pensionable: false,
      nhfBase: false,
      taxable: true,
      sources: bucket.sources,
    });
    trace.push({
      step: code,
      label,
      formula:
        code === "daily_pay"
          ? "daily rate x days worked"
          : code === "hourly_pay"
            ? "worked minutes x hourly rate ÷ 60"
            : "minutes x normal hourly rate x multiplier ÷ 60, rounded once",
      inputs: {
        minutes: bucket.minutes,
        days: bucket.days,
        multiplier_bps: policy.overtimeMultiplierBps,
        exact_kobo: koboText(bucket.value),
        pay_rate_from: rate.effectiveFrom,
      },
      valueKobo: amount,
      ruleRef: `pay_policy.${code}`,
    });
  }

  // --- Leave: unpaid and part-paid days ------------------------------------------------------
  let leaveDeducted = 0;
  for (const leave of worker.leave) {
    if (leave.payPercent === null) {
      flags.add("leave_pay_missing");
      continue;
    }
    const percent = leave.payBelowService ? 0 : leave.payPercent;
    const [from, to] = clampRange(leave.startDate, leave.endDate, period.start, period.end);
    if (from > to || percent >= 100) continue;
    const what = percent === 0 ? "Unpaid leave" : `Leave paid at ${percent}%`;
    const out = leaveDeduction({
      requestId: leave.requestId,
      typeCode: leave.typeCode,
      counting: leave.counting,
      percent,
      belowService: leave.payBelowService === true,
      from,
      to,
      employedWorking,
      rostered,
      holidays,
      payRates: worker.payRates,
      label: `${what}, ${formatLeaveRange(from, to, false)}`,
      step: "leave_deduction",
    });
    if (!out) continue;
    leaveDeducted += out.days;
    lines.push(...out.lines);
    trace.push(out.trace);
  }

  // --- Leave arrears: approved after its period was posted (slice 5.7c) ---------------------
  const deductions: DeductionLine[] = [];
  for (const leave of worker.leaveArrears ?? []) {
    if (leave.payPercent === null) {
      flags.add("leave_pay_missing");
      continue;
    }
    const percent = leave.payBelowService ? 0 : leave.payPercent;
    if (percent >= 100 || leave.from > leave.to) continue;
    // The posted period's own calendar: the worker's shifts then, else their usual days.
    const earlier = rosteredCalendar(
      { start: leave.periodStart, end: leave.periodEnd },
      { ...worker, shifts: leave.shifts },
      input.defaultWorkDays,
    ).filter((d) => d.working && d.employed);
    const what = percent === 0 ? "Unpaid leave" : `Leave paid at ${percent}%`;
    const range = `${what} in ${formatLeaveRange(leave.periodStart, leave.periodEnd, false)}, approved after posting (${formatLeaveRange(leave.from, leave.to, false)}`;
    const source: PaySourceRef = {
      kind: "leave_request",
      id: leave.requestId,
      from: leave.from,
      to: leave.to,
    };
    const out = leaveDeduction({
      requestId: leave.requestId,
      typeCode: leave.typeCode,
      counting: leave.counting,
      percent,
      belowService: leave.payBelowService === true,
      from: leave.from,
      to: leave.to,
      employedWorking: earlier,
      rostered: leave.rosteredDays,
      holidays,
      payRates: worker.payRates,
      label: range,
      closeLabel: ")",
      step: "leave_arrears",
      // Never more days than the posted payslip's base (money review L6).
      maxDays: leave.rosteredDays,
    });
    if (!out) {
      // Nothing to deduct (no working days left in the range, or no base): recorded at ₦0 with
      // its days, so the leave isn't looked at again every run (money review L5).
      deductions.push({
        code: "leave_arrears",
        label: `${range}, no working days to deduct)`,
        amountKobo: 0n,
        sources: [source],
      });
      continue;
    }
    for (const r of out.rates) usedRates.add(r);
    const total = -out.lines.reduce((n, l) => n + l.amountKobo, 0n);
    deductions.push({
      code: "leave_arrears",
      label: out.trace.label,
      amountKobo: total,
      sources: [source],
    });
    trace.push({
      ...out.trace,
      formula: `${out.trace.formula}; recovered after tax (RULES_NIGERIA open point 5)`,
      valueKobo: total,
    });
  }

  // --- Leave refunds: cancelled after a posted payslip deducted it (slice 5.7c) -------------
  for (const refund of worker.leaveRefunds ?? []) {
    const range = formatLeaveRange(refund.periodStart, refund.periodEnd, false);
    const days = formatLeaveRange(refund.from, refund.to, false);
    let total = 0n;
    for (const line of refund.lines) {
      // Each line is paid back as it was posted (never more, never less): a leave deduction's
      // earning line with its bases; an after-tax leave arrears line outside tax and pension.
      const afterTax = line.code === "leave_arrears";
      // An after-tax arrears line is refunded in full, what it took plus what it carried, so the
      // carried rest still collected nets to ₦0 for the cancelled days.
      const amount = afterTax ? (line.wantedKobo ?? line.amountKobo) : -line.amountKobo;
      if (amount <= 0n) continue;
      const component = afterTax ? null : componentOf(line.label);
      total += amount;
      lines.push({
        code: "leave_refund",
        label: `Leave refund in ${range}, cancelled after posting (${days})${component ? `, ${component.label.toLowerCase()}` : afterTax ? ", taken after tax" : ""}`,
        amountKobo: amount,
        pensionable: afterTax ? false : line.pensionable,
        nhfBase: component?.nhfBase ?? false,
        taxable: afterTax ? false : line.taxable,
        sources: [{ kind: "leave_refund", id: refund.requestId, from: refund.from, to: refund.to }],
      });
    }
    if (total === 0n) continue;
    trace.push({
      step: "leave_refund",
      label: `Leave refund in ${range}, cancelled after posting (${days})`,
      formula: "what the posted payslip's leave deduction took, line by line",
      inputs: { lines: refund.lines.length, refunded_kobo: total.toString() },
      valueKobo: total,
      ruleRef: "earnings.leave_refund",
    });
  }

  // --- Flags ---------------------------------------------------------------------------------
  const noShowDates = worker.noShowDates.filter((d) => d >= period.start && d <= period.end);
  if (noShowDates.length > 0) flags.add("no_show_days");
  if (worker.openLineCount > 0) flags.add("open_timesheet_days");
  if (unrated.size > 0) flags.add("no_pay_rate");

  lines.sort((a, b) => ORDER[a.code] - ORDER[b.code]);
  return {
    workerId: worker.workerId,
    lines,
    deductions,
    trace,
    flags: [...flags].sort(),
    days: {
      cycle: calendar.length,
      rostered,
      employedRostered: employedWorking.length,
      leaveDeducted,
      noShowDates,
      unratedDates: [...unrated].sort(),
    },
    payRateIds: [...usedRates].sort(),
  };
}
