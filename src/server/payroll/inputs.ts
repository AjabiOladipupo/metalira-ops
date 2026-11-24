import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { PAYROLL_READERS } from "@/lib/pay-access";
import {
  computeEarnings,
  POLICY_DEFAULTS,
  type EarningsResult,
  type PayPolicy,
} from "@/lib/payroll/earnings";
import { parsePayrollInputs, type PayrollInputs } from "@/lib/payroll/inputs";
import type { Database } from "@/types/db";

/**
 * Pay inputs for a cycle (slice 5.1, docs/PHASE_5.md "Inputs (5.1)"). One definer read,
 * `public.payroll_inputs` (owner, hr, finance or the secret key; 42501 otherwise), parsed with
 * Zod into bigint kobo. No screen yet: slice 5.2's run gathers these, runs the earnings stage
 * and then gross to net. Call with the signed-in user's own client so the database checks the
 * role; the summary carries counts only (no names, no amounts per person).
 */

export { PAYROLL_READERS };

type Client = SupabaseClient<Database>;

export interface PayPeriodRange {
  start: string;
  end: string;
  payDate: string;
}

/** The pay cycle holding `date` (start the 20th, end the 19th, paid on the 25th by default). */
export async function loadPayPeriod(
  supabase: Client,
  organisationId: string,
  date: string,
): Promise<PayPeriodRange> {
  const { data, error } = await supabase.rpc("payroll_period", {
    p_organisation_id: organisationId,
    p_date: date,
  });
  if (error) throw new Error(`Could not read the pay period (${error.code})`);
  const row = data?.[0];
  if (!row) throw new Error("No pay period for that date");
  return { start: row.period_start, end: row.period_end, payDate: row.pay_date };
}

/** Every worker's inputs for the cycle holding `date` (or only `workerIds`, 2000 at most). */
export async function loadPayInputs(
  supabase: Client,
  organisationId: string,
  date: string,
  workerIds?: readonly string[],
): Promise<PayrollInputs> {
  const period = await loadPayPeriod(supabase, organisationId, date);
  const { data, error } = await supabase.rpc("payroll_inputs", {
    p_organisation_id: organisationId,
    p_period_start: period.start,
    ...(workerIds ? { p_worker_ids: [...workerIds] } : {}),
  });
  // The code only: the message can name the period or the company.
  if (error) throw new Error(`Could not read pay inputs (${error.code})`);
  return parsePayrollInputs(data);
}

/**
 * The policy for the earnings stage from the company's settings. The overtime multiplier and the
 * off-day minutes come from the rule set's policy once slice 5.0's rule sets land (5.2 passes
 * them); until then the owner's starting values.
 */
export function payPolicyFor(
  inputs: PayrollInputs,
  rulePolicy: Partial<Pick<PayPolicy, "overtimeMultiplierBps" | "offDayPaidMinutes">> = {},
): PayPolicy {
  return {
    standardShiftMinutes: inputs.organisation.standardShiftMinutes,
    hourlyRateDivisorDays: inputs.organisation.hourlyRateDivisorDays,
    workDaysPerWeek: inputs.organisation.workDaysPerWeek,
    overtimeMultiplierBps:
      rulePolicy.overtimeMultiplierBps ?? POLICY_DEFAULTS.overtimeMultiplierBps,
    offDayPaidMinutes: rulePolicy.offDayPaidMinutes ?? POLICY_DEFAULTS.offDayPaidMinutes,
  };
}

/** The earnings stage for every worker in the inputs. */
export function earningsFor(
  inputs: PayrollInputs,
  policy: PayPolicy = payPolicyFor(inputs),
): EarningsResult[] {
  return inputs.workers.map((worker) =>
    computeEarnings(
      {
        period: inputs.period,
        holidays: inputs.holidays,
        defaultWorkDays: inputs.organisation.defaultWorkDays,
        worker,
      },
      policy,
    ),
  );
}

export interface PayInputsSummary {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  workers: number;
  monthlyWorkers: number;
  dailyWorkers: number;
  hourlyWorkers: number;
  workersWithoutPayRate: number;
  approvedDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
  openDays: number;
  noShowDays: number;
  approvedLeaveRequests: number;
  publicHolidays: number;
  arrearsDays: number;
}

/** Counts only: workers, days, minutes, leave and holidays. No names, no amounts. */
export function summarisePayInputs(inputs: PayrollInputs): PayInputsSummary {
  const { start, end } = inputs.period;
  const inCycle = (d: string) => d >= start && d <= end;
  let monthly = 0;
  let daily = 0;
  let hourly = 0;
  let unrated = 0;
  let approvedDays = 0;
  let worked = 0;
  let overtime = 0;
  let open = 0;
  let noShow = 0;
  let leave = 0;
  let arrears = 0;
  for (const w of inputs.workers) {
    const current = w.payRates.filter(
      (r) => r.effectiveFrom <= end && (r.effectiveTo === null || r.effectiveTo >= start),
    );
    const latest = current.at(-1);
    if (!latest) unrated += 1;
    else if (latest.payType === "monthly") monthly += 1;
    else if (latest.payType === "daily") daily += 1;
    else hourly += 1;
    const lines = w.lines.filter((l) => inCycle(l.workDate));
    approvedDays += new Set(lines.map((l) => l.workDate)).size;
    for (const l of lines) {
      worked += l.workedMinutes;
      overtime += l.otMinutes;
    }
    open += w.openLineCount;
    noShow += w.noShowDates.length;
    leave += w.leave.length;
    arrears += w.arrears.length;
  }
  return {
    periodStart: start,
    periodEnd: end,
    payDate: inputs.period.payDate,
    workers: inputs.workers.length,
    monthlyWorkers: monthly,
    dailyWorkers: daily,
    hourlyWorkers: hourly,
    workersWithoutPayRate: unrated,
    approvedDays,
    workedMinutes: worked,
    overtimeMinutes: overtime,
    openDays: open,
    noShowDays: noShow,
    approvedLeaveRequests: leave,
    publicHolidays: inputs.holidays.filter(inCycle).length,
    arrearsDays: arrears,
  };
}

/** The summary of a cycle's pay inputs, for the capability registry and 5.2's run screen. */
export async function loadPayInputsSummary(
  supabase: Client,
  organisationId: string,
  date: string,
): Promise<PayInputsSummary> {
  return summarisePayInputs(await loadPayInputs(supabase, organisationId, date));
}
