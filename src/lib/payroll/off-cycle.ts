import type { EarningsResult } from "./earnings";
import { traceStep } from "./trace";

/**
 * Off-cycle runs (slice 5.7b, docs/PHASE_5.md "As built in 5.7b"). Pure.
 *
 * A final-pay or missed-worker run pays the worker's whole period through the same engine as a
 * regular run (salary prorated to the end date, timesheet days, leave, arrears). A correction or a
 * one-off run pays only the adjustments HR adds: its earnings stage is emptied here, so no salary,
 * timesheet or leave line (and no source the regular run pays) can reach its payslips. The
 * database refuses such a source on those runs too (MLOC6).
 */

/** The earnings stage of a correction or one-off run: no lines, only the days for the payslip. */
export function adjustmentsOnlyEarnings(e: EarningsResult): EarningsResult {
  return {
    workerId: e.workerId,
    lines: [],
    trace: [
      traceStep(
        "off_cycle",
        "Off-cycle payment",
        "Only the one-off items below are paid; salary, timesheet days and leave stay with the regular run",
        null,
        "PHASE_5 5.7b",
      ),
    ],
    flags: [],
    days: {
      cycle: e.days.cycle,
      rostered: e.days.rostered,
      employedRostered: e.days.employedRostered,
      leaveDeducted: 0,
      noShowDates: [],
      unratedDates: [],
    },
    payRateIds: [],
  };
}

/** A regular run of the company, as far as the off-cycle ITF choice needs it. */
export interface RegularRunItf {
  periodStart: string;
  itfApplies: boolean;
  calculated: boolean;
}

/**
 * ITF on an off-cycle run (open question 14 counts the levy base of the company's payroll, which a
 * run of one or two workers doesn't show): the choice of the regular run of the same period when
 * it has been worked out, else of the latest regular run worked out before it, else `fallback`
 * (the off-cycle run's own count, as a regular run would do).
 */
export function offCycleItf(
  regularRuns: readonly RegularRunItf[],
  periodStart: string,
  fallback: boolean,
): { itfApplies: boolean; fromPeriod: string | null } {
  const candidates = regularRuns
    .filter((r) => r.calculated && r.periodStart <= periodStart)
    .sort((a, b) => (a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : 0));
  const pick = candidates[0];
  return pick
    ? { itfApplies: pick.itfApplies, fromPeriod: pick.periodStart }
    : { itfApplies: fallback, fromPeriod: null };
}

/**
 * The earnings stage of a correction run (money review M2): only lines for timesheet days and
 * leave (the caller has already left out what another standing payslip pays), never a salary
 * line (a pay version's days). The database refuses a salary line or source on a correction too.
 */
export function correctionEarnings(e: EarningsResult): EarningsResult {
  const lines = e.lines.filter(
    (l) => l.sources.length > 0 && l.sources.every((s) => s.kind !== "pay_rate"),
  );
  return {
    workerId: e.workerId,
    lines,
    trace: [
      traceStep(
        "off_cycle",
        "Correction",
        "Pays approved days and leave no other payslip has paid, and the one-off items below; salary stays with the period's other runs",
        null,
        "PHASE_5 5.7b",
      ),
      ...e.trace,
    ],
    flags: [],
    days: { ...e.days, noShowDates: [], unratedDates: [] },
    payRateIds: e.payRateIds,
  };
}
