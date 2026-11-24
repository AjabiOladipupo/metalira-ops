/**
 * Pay inputs (slice 5.1, docs/PHASE_5.md "Inputs (5.1)"): the Zod parse of what
 * `public.payroll_inputs` returns, and the rostered-day calendar the earnings stage counts on.
 * Pure and isomorphic.
 *
 * Amounts arrive as strings of whole kobo and become `bigint` here; minutes and days are
 * integers. Nothing here carries a personal number: the database sends whether a TIN and an RSA
 * PIN are on file, never the numbers.
 */

import { z } from "zod";

import { addDays } from "@/lib/dates";
import { countLeaveDays, isoWeekday, spanDays } from "@/lib/leave/days";
import { toKobo, type Kobo } from "@/lib/money";

const isoDate = z.iso.date();
const minutes = z.number().int().min(0).max(1440);
const workDays = z.array(z.number().int().min(1).max(7));

const koboText = z
  .string()
  .regex(/^\d+$/, "Expected whole kobo")
  .transform((value): Kobo => toKobo(value));
const optionalKobo = koboText.nullable();

const payRateSchema = z
  .object({
    id: z.uuid(),
    pay_type: z.enum(["monthly", "daily", "hourly"]),
    currency: z.literal("NGN"),
    basic_kobo: optionalKobo,
    housing_kobo: optionalKobo,
    transport_kobo: optionalKobo,
    other_allowances_kobo: optionalKobo,
    daily_rate_kobo: optionalKobo,
    hourly_rate_kobo: optionalKobo,
    effective_from: isoDate,
    effective_to: isoDate.nullable(),
  })
  .transform((r) => ({
    id: r.id,
    payType: r.pay_type,
    basic: r.basic_kobo ?? 0n,
    housing: r.housing_kobo ?? 0n,
    transport: r.transport_kobo ?? 0n,
    otherAllowances: r.other_allowances_kobo ?? 0n,
    dailyRate: r.daily_rate_kobo ?? 0n,
    hourlyRate: r.hourly_rate_kobo ?? 0n,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  }));

const lineSchema = z
  .object({
    id: z.uuid(),
    work_date: isoDate,
    worked_minutes: minutes,
    ot_minutes: minutes,
    has_shift: z.boolean(),
    project_id: z.uuid().nullable(),
  })
  .transform((l) => ({
    id: l.id,
    workDate: l.work_date,
    workedMinutes: l.worked_minutes,
    otMinutes: l.ot_minutes,
    hasShift: l.has_shift,
    projectId: l.project_id,
  }));

const arrearsSchema = z
  .object({
    id: z.uuid(),
    work_date: isoDate,
    worked_minutes: minutes,
    ot_minutes: minutes,
    has_shift: z.boolean(),
    project_id: z.uuid().nullable(),
    period_start: isoDate,
    week_shift_rank: z.number().int().min(0).max(7),
    week_shift_days: z.number().int().min(0).max(7),
    week_off_days_paid: z.number().int().min(0).max(7),
  })
  .transform((l) => ({
    id: l.id,
    workDate: l.work_date,
    workedMinutes: l.worked_minutes,
    otMinutes: l.ot_minutes,
    hasShift: l.has_shift,
    projectId: l.project_id,
    periodStart: l.period_start,
    weekShiftRank: l.week_shift_rank,
    weekShiftDays: l.week_shift_days,
    weekOffDaysPaid: l.week_off_days_paid,
  }));

const leaveSchema = z
  .object({
    request_id: z.uuid(),
    type_code: z.string().min(1).max(40),
    counting: z.enum(["working_days", "calendar_days"]),
    start_date: isoDate,
    end_date: isoDate,
    pay_percent: z.number().int().min(0).max(100).nullable(),
    pay_below_service: z.boolean().nullable(),
  })
  .transform((q) => ({
    requestId: q.request_id,
    typeCode: q.type_code,
    counting: q.counting,
    startDate: q.start_date,
    endDate: q.end_date,
    payPercent: q.pay_percent,
    payBelowService: q.pay_below_service,
  }));

const workerSchema = z
  .object({
    worker_id: z.uuid(),
    employment_type: z.enum(["permanent", "contract", "casual", "daily"]),
    start_date: isoDate,
    end_date: isoDate.nullable(),
    status: z.string(),
    usual_work_days: workDays.nullable(),
    statutory: z.object({
      tax_state: z.string().nullable(),
      pfa_name: z.string().nullable(),
      nhf_opt_in: z.boolean(),
      annual_rent_declared_kobo: optionalKobo,
      has_tin: z.boolean(),
      has_rsa_pin: z.boolean(),
    }),
    pay_rates: z.array(payRateSchema),
    shifts: z.array(z.object({ date: isoDate, on_leave: z.boolean() })),
    last_rostered: isoDate.nullable(),
    lines: z.array(lineSchema),
    arrears: z.array(arrearsSchema),
    no_show_dates: z.array(isoDate),
    open_line_count: z.number().int().min(0),
    leave: z.array(leaveSchema),
  })
  .transform((w) => ({
    workerId: w.worker_id,
    employmentType: w.employment_type,
    startDate: w.start_date,
    endDate: w.end_date,
    status: w.status,
    usualWorkDays: w.usual_work_days,
    statutory: {
      taxState: w.statutory.tax_state,
      pfaName: w.statutory.pfa_name,
      nhfOptIn: w.statutory.nhf_opt_in,
      annualRentKobo: w.statutory.annual_rent_declared_kobo ?? 0n,
      hasTin: w.statutory.has_tin,
      hasRsaPin: w.statutory.has_rsa_pin,
    },
    payRates: w.pay_rates,
    shifts: w.shifts.map((s) => ({ date: s.date, onLeave: s.on_leave })),
    lastRostered: w.last_rostered,
    lines: w.lines,
    arrears: w.arrears,
    noShowDates: w.no_show_dates,
    openLineCount: w.open_line_count,
    leave: w.leave,
  }));

export const payrollInputsSchema = z
  .object({
    version: z.literal(1),
    organisation: z.object({
      pay_cycle_start_day: z.number().int().min(1).max(28),
      pay_day: z.number().int().min(1).max(31),
      standard_shift_minutes: z.number().int().min(1).max(1440),
      hourly_rate_divisor_days: z.number().int().min(1).max(31),
      work_days_per_week: z.number().int().min(1).max(7),
      default_work_days: workDays,
      shifts_enabled: z.boolean(),
    }),
    period: z.object({ start: isoDate, end: isoDate, pay_date: isoDate }),
    holidays: z.array(isoDate),
    workers: z.array(workerSchema),
  })
  .transform((x) => ({
    organisation: {
      payCycleStartDay: x.organisation.pay_cycle_start_day,
      payDay: x.organisation.pay_day,
      standardShiftMinutes: x.organisation.standard_shift_minutes,
      hourlyRateDivisorDays: x.organisation.hourly_rate_divisor_days,
      workDaysPerWeek: x.organisation.work_days_per_week,
      defaultWorkDays: x.organisation.default_work_days,
      shiftsEnabled: x.organisation.shifts_enabled,
    },
    period: { start: x.period.start, end: x.period.end, payDate: x.period.pay_date },
    holidays: x.holidays,
    workers: x.workers,
  }));

export type PayrollInputs = z.output<typeof payrollInputsSchema>;
export type WorkerPayInputs = PayrollInputs["workers"][number];
export type PayRateInput = WorkerPayInputs["payRates"][number];
export type TimesheetDayInput = WorkerPayInputs["lines"][number];
export type ArrearsDayInput = WorkerPayInputs["arrears"][number];
export type LeaveInput = WorkerPayInputs["leave"][number];

// ---------------------------------------------------------------------------
// Leave corrections (slice 5.7c): `public.payroll_leave_corrections`
// ---------------------------------------------------------------------------

const leaveArrearsSchema = z
  .object({
    request_id: z.uuid(),
    type_code: z.string().min(1).max(40),
    counting: z.enum(["working_days", "calendar_days"]),
    pay_percent: z.number().int().min(0).max(100).nullable(),
    pay_below_service: z.boolean().nullable(),
    period_start: isoDate,
    period_end: isoDate,
    from: isoDate,
    to: isoDate,
    rostered_days: z.number().int().min(0).max(62),
    shifts: z.array(z.object({ date: isoDate, on_leave: z.boolean() })),
  })
  .transform((q) => ({
    requestId: q.request_id,
    typeCode: q.type_code,
    counting: q.counting,
    payPercent: q.pay_percent,
    payBelowService: q.pay_below_service,
    periodStart: q.period_start,
    periodEnd: q.period_end,
    from: q.from,
    to: q.to,
    rosteredDays: q.rostered_days,
    shifts: q.shifts.map((s) => ({ date: s.date, onLeave: s.on_leave })),
  }));

const signedKobo = z
  .string()
  .regex(/^-?\d+$/, "Expected whole kobo")
  .transform((value): Kobo => BigInt(value));

const leaveRefundSchema = z
  .object({
    request_id: z.uuid(),
    from: isoDate,
    to: isoDate,
    period_start: isoDate,
    period_end: isoDate,
    lines: z
      .array(
        z.object({
          code: z.enum(["leave_deduction", "leave_arrears"]).default("leave_deduction"),
          label: z.string().min(1).max(300),
          amount_kobo: signedKobo,
          pensionable: z.boolean(),
          taxable: z.boolean(),
        }),
      )
      .min(1),
  })
  .transform((r) => ({
    requestId: r.request_id,
    from: r.from,
    to: r.to,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    lines: r.lines.map((l) => ({
      code: l.code,
      label: l.label,
      amountKobo: l.amount_kobo,
      pensionable: l.pensionable,
      taxable: l.taxable,
    })),
  }));

export const leaveCorrectionsSchema = z
  .object({
    version: z.literal(1),
    period: z.object({ start: isoDate, end: isoDate }),
    workers: z.array(
      z.object({
        worker_id: z.uuid(),
        leave_arrears: z.array(leaveArrearsSchema),
        leave_refunds: z.array(leaveRefundSchema),
      }),
    ),
  })
  .transform((x) => ({
    period: x.period,
    byWorker: new Map(
      x.workers.map((w) => [
        w.worker_id,
        { leaveArrears: w.leave_arrears, leaveRefunds: w.leave_refunds },
      ]),
    ),
  }));

export type LeaveCorrections = z.output<typeof leaveCorrectionsSchema>;
export type LeaveArrearsInput = z.output<typeof leaveArrearsSchema>;
export type LeaveRefundInput = z.output<typeof leaveRefundSchema>;

/** Parses `public.payroll_leave_corrections`'s jsonb; throws a ZodError when the shape is wrong. */
export function parseLeaveCorrections(raw: unknown): LeaveCorrections {
  return leaveCorrectionsSchema.parse(raw);
}

export interface PayPeriod {
  start: string;
  end: string;
  payDate: string;
}

/** Parses `public.payroll_inputs`'s jsonb; throws a ZodError when the shape is wrong. */
export function parsePayrollInputs(raw: unknown): PayrollInputs {
  return payrollInputsSchema.parse(raw);
}

export interface CalendarDay {
  date: string;
  /** A rostered working day by the 4.4 rule (see `rosteredCalendar`). */
  working: boolean;
  /** Inside the worker's employment (start date to end date). */
  employed: boolean;
}

export interface CalendarInput {
  startDate: string;
  endDate: string | null;
  usualWorkDays: readonly number[] | null;
  shifts: readonly { date: string; onLeave: boolean }[];
  lastRostered: string | null;
}

/**
 * Each day of the cycle, working or off (docs/PHASE_5.md decision 4, the 4.4 counter in
 * src/lib/leave/days.ts): a day with an assigned shift, including one approved leave removed, is
 * a working day; on or before the worker's last rostered day a day without a shift is an off
 * day; after it, the worker's usual days (else the company's default days) stand in. Public
 * holidays stay working days (a monthly worker keeps full pay for an unworked rostered holiday,
 * open question 1).
 *
 * Days outside the worker's employment have no roster, so the worker's own weekly pattern stands
 * in there (`outsidePattern`): the weekdays of their shifts in complete ISO weeks of the cycle
 * they were rostered for while employed, else their usual days, else the company's. The full cycle's count then follows the worker's own week whether they
 * joined, left or stayed.
 */
export interface OutsidePattern {
  workDays: number[];
  /** Where the weekdays came from: the worker's shifts, their usual days, or the company's. */
  source: "roster" | "usual" | "company";
}

/**
 * The worker's own weekly pattern for days outside their employment (see `rosteredCalendar`).
 * Only complete ISO weeks count: Monday to Sunday inside the cycle, inside the employment, and on
 * or before the last rostered day, so a partial week (a joiner's first days, a leaver's last)
 * never makes a pattern of its own.
 */
export function outsidePattern(
  period: Pick<PayPeriod, "start" | "end">,
  worker: CalendarInput,
  defaultWorkDays: readonly number[],
): OutsidePattern {
  const pattern = new Set<number>();
  if (worker.lastRostered !== null) {
    const span = spanDays(period.start, period.end);
    for (let i = 0; i < span; i += 1) {
      const monday = addDays(period.start, i);
      if (isoWeekday(monday) !== 1) continue;
      const sunday = addDays(monday, 6);
      const complete =
        sunday <= period.end &&
        monday >= worker.startDate &&
        (worker.endDate === null || sunday <= worker.endDate) &&
        sunday <= worker.lastRostered;
      if (!complete) continue;
      for (const s of worker.shifts) {
        if (s.date >= monday && s.date <= sunday) pattern.add(isoWeekday(s.date));
      }
    }
  }
  if (pattern.size > 0) {
    return { workDays: [...pattern].sort((a, b) => a - b), source: "roster" };
  }
  if (worker.usualWorkDays) return { workDays: [...worker.usualWorkDays], source: "usual" };
  return { workDays: [...defaultWorkDays], source: "company" };
}

export function rosteredCalendar(
  period: Pick<PayPeriod, "start" | "end">,
  worker: CalendarInput,
  defaultWorkDays: readonly number[],
): CalendarDay[] {
  const days = spanDays(period.start, period.end);
  const usual = worker.usualWorkDays ?? defaultWorkDays;
  const outside = outsidePattern(period, worker, defaultWorkDays).workDays;
  const shifts = worker.shifts.map((s) => ({ date: s.date, site: "" }));
  const holidays = new Set<string>();
  const out: CalendarDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(period.start, i);
    const employed =
      date >= worker.startDate && (worker.endDate === null || date <= worker.endDate);
    const working =
      countLeaveDays(date, date, "working_days", {
        workDays: employed ? usual : outside,
        lastRostered: employed ? worker.lastRostered : null,
        holidays,
        shifts: employed ? shifts : [],
      }).days === 1;
    out.push({ date, working, employed });
  }
  return out;
}
