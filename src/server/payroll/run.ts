import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { toKobo } from "@/lib/money";
import type { EmploymentType, PayslipResult } from "@/lib/payroll/contract";
import { computeEarnings, type DayPolicy, type EarningsResult } from "@/lib/payroll/earnings";
import { parsePayrollInputs, type PayrollInputs } from "@/lib/payroll/inputs";
import { adjustmentsOnlyEarnings, offCycleItf } from "@/lib/payroll/off-cycle";
import { NTA_2025_V1, parseRuleSet, type RuleSet } from "@/lib/payroll/rule-set";
import {
  isOffCycleReason,
  offCyclePaysFullPeriod,
  type OffCycleReason,
} from "@/lib/payroll/run-format";
import {
  canonicalJson,
  itfAppliesTo,
  previousPeriodAnomalies,
  recurringAnomalies,
  workerHistory,
  PayrollInputError,
  resultsPayload,
  runAnomalies,
  runTotals,
  workerAnomalies,
  workerPayslip,
  type OpenDaysAtSite,
  type PostedSlip,
  type PreviousPeriodRun,
  type RecurringSeries,
  type ResultsPayload,
  type RunAdjustment,
  type RunAnomaly,
  type RunTotals,
  type WorkerResult,
} from "@/lib/payroll/run";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database, Json } from "@/types/db";

import { checkBankDetails } from "./bank-checks";
import { payPolicyFor } from "./inputs";

/**
 * The payroll run's calculation (slice 5.2, docs/PHASE_5.md 5.2 "Server"). The server runs the
 * engine; the client never sends an amount.
 *
 * `calculateRun` gathers the inputs with the signed-in user's own client (payroll_inputs and the
 * run's reads check the role in the database), runs the earnings stage (5.1) and gross to net
 * (5.0) per worker with the one rule set the run snapshotted (decision 15) and the pay-policy
 * figures of the version in force on each day worked (arrears days included), works out the
 * anomalies, and hashes the canonical inputs (decision 7). It writes nothing, so it is also the
 * preview of "Recalculate" and of an adjustment.
 *
 * `saveCalculation` hands the results to `save_payroll_results` with the secret key (server
 * only), naming the signed-in user as the actor; the database checks every invariant again and
 * replaces the draft's payslips in one transaction.
 *
 * Off-cycle runs (slice 5.7b) use the same path: the run's chosen workers only; a final-pay or
 * missed-worker run pays their full period, a correction or one-off run only its adjustments; no
 * recurring-instalment or net-change checks; ITF follows the period's regular run. A regular run
 * leaves out workers a final-pay or missed-worker run of its period pays, so nobody is paid twice
 * (the database refuses a source paid twice either way, MLPRC).
 *
 * Nothing here logs pay, names or bank details; errors carry database codes only.
 */

type Client = SupabaseClient<Database>;

export interface RunTarget {
  /** Null for a run not created yet (the preview of "Prepare the run"). */
  runId: string | null;
  periodStart: string;
  payDate: string;
  /** The run's snapshotted rule set; null before the run exists (the one on the pay date). */
  ruleSetId: string | null;
  /**
   * An off-cycle run not created yet (the preview of "New off-cycle run"). For a saved run the
   * kind, reason and workers are read from the database instead.
   */
  offCycle?: OffCycleScope | null;
}

/** What an off-cycle run pays (slice 5.7b). */
export interface OffCycleScope {
  reason: OffCycleReason;
  workerIds: readonly string[];
}

export interface CalculateOptions {
  /** Only these workers (an adjustment's preview). */
  workerIds?: readonly string[];
  /** Adjustments not saved yet (an adjustment's preview). */
  extraAdjustments?: readonly RunAdjustment[];
  /** Leave out adjustments (a removal's preview). */
  withoutAdjustmentIds?: readonly string[];
  /** Use this ITF choice instead of working it out (a single worker's preview). */
  itfApplies?: boolean;
}

export interface RunCalculation {
  period: { start: string; end: string; payDate: string };
  ruleSet: { id: string | null; name: string };
  workers: WorkerResult[];
  /** Workers the engine refused (a blocking anomaly each). */
  failed: string[];
  anomalies: RunAnomaly[];
  totals: RunTotals;
  itfApplies: boolean;
  inputsSha256: string;
  payload: ResultsPayload;
}

interface Version {
  id: string;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  set: RuleSet;
  rules: Json;
  policy: Json;
}

const inForce = (versions: readonly Version[], date: string) =>
  versions.find(
    (v) => v.effectiveFrom <= date && (v.effectiveTo === null || v.effectiveTo >= date),
  ) ?? null;

async function ruleSetVersions(supabase: Client, organisationId: string): Promise<Version[]> {
  const { data, error } = await supabase
    .from("tax_rule_sets")
    .select("id, name, effective_from, effective_to, rules, policy")
    .eq("organisation_id", organisationId)
    .order("effective_from");
  if (error) throw new Error(`Could not read the payroll rules (${error.code})`);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    set: parseRuleSet(r.name, r.rules, r.policy),
    rules: r.rules,
    policy: r.policy,
  }));
}

async function runAdjustments(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<RunAdjustment[]> {
  const { data, error } = await supabase
    .from("payroll_adjustments")
    .select(
      "id, worker_id, kind, label, amount_kobo::text, pensionable, taxable, instalment_number, instalment_count, created_at",
    )
    .eq("organisation_id", organisationId)
    .eq("run_id", runId)
    .order("created_at")
    .order("id");
  if (error) throw new Error(`Could not read the run's adjustments (${error.code})`);
  return (data ?? []).map((a) => ({
    id: a.id,
    workerId: a.worker_id,
    kind: a.kind === "deduction" ? "deduction" : "earning",
    label: a.label,
    amountKobo: toKobo(a.amount_kobo),
    pensionable: a.pensionable,
    taxable: a.taxable,
    instalmentNumber: a.instalment_number,
    instalmentCount: a.instalment_count,
  }));
}

interface History {
  previous: PreviousPeriodRun | null;
  previousRunId: string | null;
  latestPosted: Map<string, PostedSlip>;
  /** Workers with any posted payslip (a one-off run's included), for "first pay". */
  paidAny: Set<string>;
  /** Recurring series of the period before (to flag instalments not carried). */
  previousSeries: RecurringSeries[];
}

const POSTED = new Set(["approved", "released"]);

/**
 * What workers bring from earlier runs (money review M3): the regular run of the period just
 * before (its payslips when posted; a blocking anomaly when it isn't), and each worker's own
 * latest posted payslip for the carried deduction when they had none in the period before.
 */
async function runHistory(
  supabase: Client,
  organisationId: string,
  periodStart: string,
  workerIds: readonly string[],
): Promise<History> {
  const history: History = {
    previous: null,
    previousRunId: null,
    latestPosted: new Map(),
    paidAny: new Set(),
    previousSeries: [],
  };
  const { data: runs, error } = await supabase
    .from("payroll_runs")
    .select("id, kind, status, period_start, period_end, off_cycle_reason")
    .eq("organisation_id", organisationId)
    .lt("period_start", periodStart)
    .order("period_start", { ascending: false })
    .limit(400);
  if (error) throw new Error(`Could not read earlier runs (${error.code})`);
  const all = runs ?? [];
  // The latest regular run of an earlier period, whatever its exact end (money review L-new-3).
  const prev = all.find((r) => r.kind === "regular");
  const posted = all.filter((r) => POSTED.has(r.status));
  const postedIds = new Set(posted.map((r) => r.id));
  // The carried deduction comes from runs that pay a worker's period (regular, final pay, missed
  // worker): a correction or one-off run never takes or settles one (slice 5.7b).
  const carrying = posted.filter(
    (r) =>
      r.kind === "regular" ||
      (r.kind === "off_cycle" &&
        isOffCycleReason(r.off_cycle_reason) &&
        offCyclePaysFullPeriod(r.off_cycle_reason)),
  );
  const order = new Map(carrying.map((r, i) => [r.id, i] as const));
  const prevSlips = new Map<string, PostedSlip>();
  const ranks = new Map<string, number>();

  const ids = [...new Set([...posted.map((r) => r.id), ...(prev ? [prev.id] : [])])];
  if (ids.length > 0 && workerIds.length > 0) {
    for (let i = 0; i < workerIds.length; i += 200) {
      const chunk = workerIds.slice(i, i + 200);
      const { data, error: slipError } = await supabase
        .from("payslips")
        .select("run_id, worker_id, net_kobo::text, carried_forward_kobo::text")
        .eq("organisation_id", organisationId)
        .in("run_id", ids)
        .in("worker_id", chunk);
      if (slipError) throw new Error(`Could not read earlier payslips (${slipError.code})`);
      for (const s of data ?? []) {
        const slip = {
          netKobo: toKobo(s.net_kobo),
          carriedForwardKobo: toKobo(s.carried_forward_kobo),
        };
        if (prev && s.run_id === prev.id) prevSlips.set(s.worker_id, slip);
        if (postedIds.has(s.run_id)) history.paidAny.add(s.worker_id);
        const rank = order.get(s.run_id);
        if (rank === undefined) continue;
        if (rank < (ranks.get(s.worker_id) ?? Infinity)) {
          ranks.set(s.worker_id, rank);
          history.latestPosted.set(s.worker_id, slip);
        }
      }
    }
  }

  if (prev) {
    history.previousRunId = prev.id;
    history.previous = {
      periodStart: prev.period_start,
      posted: POSTED.has(prev.status),
      slips: prevSlips,
    };
    const { data: series, error: seriesError } = await supabase
      .from("payroll_adjustments")
      .select("series_id, worker_id, instalment_number, instalment_count")
      .eq("organisation_id", organisationId)
      .eq("run_id", prev.id);
    if (seriesError) throw new Error(`Could not read earlier adjustments (${seriesError.code})`);
    history.previousSeries = (series ?? []).map((x) => ({
      seriesId: x.series_id,
      workerId: x.worker_id,
      instalmentNumber: x.instalment_number,
      instalmentCount: x.instalment_count,
    }));
  }
  return history;
}

/** Series this run already carries (to compare with the period before's). */
async function carriedSeries(
  supabase: Client,
  organisationId: string,
  runId: string | null,
): Promise<Set<string>> {
  if (!runId) return new Set();
  const { data, error } = await supabase
    .from("payroll_adjustments")
    .select("series_id")
    .eq("organisation_id", organisationId)
    .eq("run_id", runId);
  if (error) throw new Error(`Could not read the run's adjustments (${error.code})`);
  return new Set((data ?? []).map((x) => x.series_id));
}

/** Pending and disputed timesheet days in the period, by site ("5 timesheets still block"). */
async function openDaysBySite(
  supabase: Client,
  organisationId: string,
  period: { start: string; end: string },
  workerIds: readonly string[] | null = null,
): Promise<OpenDaysAtSite[]> {
  if (workerIds !== null && workerIds.length === 0) return [];
  let query = supabase
    .from("timesheet_lines")
    .select("site_id, exceptions")
    .eq("organisation_id", organisationId)
    .gte("work_date", period.start)
    .lte("work_date", period.end)
    .in("status", ["pending", "disputed"]);
  if (workerIds !== null) query = query.in("worker_id", [...workerIds]);
  const { data, error } = await query.limit(20000);
  if (error) throw new Error(`Could not read open timesheet days (${error.code})`);
  const bySite = new Map<string, { days: number; reasons: Set<string> }>();
  for (const l of data ?? []) {
    const key = l.site_id ?? "";
    const entry = bySite.get(key) ?? { days: 0, reasons: new Set<string>() };
    entry.days += 1;
    for (const e of l.exceptions ?? []) entry.reasons.add(e);
    bySite.set(key, entry);
  }
  return [...bySite.entries()].map(([siteId, e]) => ({
    siteId: siteId === "" ? null : siteId,
    days: e.days,
    reasons: [...e.reasons],
  }));
}

/** A saved run's kind and, for an off-cycle run, its reason and workers (slice 5.7b). */
async function runScope(
  supabase: Client,
  organisationId: string,
  target: RunTarget,
): Promise<OffCycleScope | null> {
  if (!target.runId) return target.offCycle ?? null;
  const { data: run, error } = await supabase
    .from("payroll_runs")
    .select("kind, off_cycle_reason")
    .eq("organisation_id", organisationId)
    .eq("id", target.runId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the run (${error.code})`);
  if (!run) throw new Error("The run wasn't found");
  if (run.kind !== "off_cycle") return null;
  if (!isOffCycleReason(run.off_cycle_reason)) throw new Error("The off-cycle run has no reason");
  const { data: rows, error: workerError } = await supabase
    .from("payroll_run_workers")
    .select("worker_id")
    .eq("organisation_id", organisationId)
    .eq("run_id", target.runId)
    .order("worker_id")
    .limit(500);
  if (workerError) throw new Error(`Could not read the run's workers (${workerError.code})`);
  return { reason: run.off_cycle_reason, workerIds: (rows ?? []).map((r) => r.worker_id) };
}

/**
 * Workers a final-pay or missed-worker run of this period pays (not discarded, not reversed): a
 * regular run leaves them out, so their period is paid once (slice 5.7b).
 */
async function paidOffCycle(
  supabase: Client,
  organisationId: string,
  periodStart: string,
): Promise<string[]> {
  const { data: runs, error } = await supabase
    .from("payroll_runs")
    .select("id, status, off_cycle_reason, discarded_at")
    .eq("organisation_id", organisationId)
    .eq("kind", "off_cycle")
    .eq("period_start", periodStart);
  if (error) throw new Error(`Could not read off-cycle runs (${error.code})`);
  const ids = (runs ?? [])
    .filter(
      (r) =>
        r.discarded_at === null &&
        r.status !== "reversed" &&
        isOffCycleReason(r.off_cycle_reason) &&
        offCyclePaysFullPeriod(r.off_cycle_reason),
    )
    .map((r) => r.id);
  if (ids.length === 0) return [];
  const { data: rows, error: workerError } = await supabase
    .from("payroll_run_workers")
    .select("worker_id")
    .eq("organisation_id", organisationId)
    .in("run_id", ids)
    .limit(5000);
  if (workerError) throw new Error(`Could not read off-cycle workers (${workerError.code})`);
  return [...new Set((rows ?? []).map((r) => r.worker_id))].sort();
}

/** The company's regular runs' ITF choices, for an off-cycle run (slice 5.7b). */
async function regularItf(
  supabase: Client,
  organisationId: string,
  periodStart: string,
): Promise<{ periodStart: string; itfApplies: boolean; calculated: boolean }[]> {
  const { data, error } = await supabase
    .from("payroll_runs")
    .select("period_start, itf_applies, calculated_at")
    .eq("organisation_id", organisationId)
    .eq("kind", "regular")
    .lte("period_start", periodStart)
    .order("period_start", { ascending: false })
    .limit(24);
  if (error) throw new Error(`Could not read regular runs (${error.code})`);
  return (data ?? []).map((r) => ({
    periodStart: r.period_start,
    itfApplies: r.itf_applies,
    calculated: r.calculated_at !== null,
  }));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Works out the run without saving it (see the file header). */
export async function calculateRun(
  supabase: Client,
  organisationId: string,
  target: RunTarget,
  options: CalculateOptions = {},
): Promise<RunCalculation> {
  const offCycle = await runScope(supabase, organisationId, target);
  const fullPay = offCycle !== null && offCyclePaysFullPeriod(offCycle.reason);
  const adjustmentsOnly = offCycle !== null && !fullPay;
  // An off-cycle run reads its chosen workers only (and a preview's worker within them).
  const scopedWorkers = offCycle
    ? options.workerIds
      ? options.workerIds.filter((id) => offCycle.workerIds.includes(id))
      : [...offCycle.workerIds]
    : options.workerIds
      ? [...options.workerIds]
      : null;
  const workerArg = scopedWorkers ? { p_worker_ids: scopedWorkers } : {};
  const [{ data: raw, error }, excluded] = await Promise.all([
    target.runId
      ? supabase.rpc("payroll_run_inputs", {
          p_organisation_id: organisationId,
          p_period_start: target.periodStart,
          p_run_id: target.runId,
          ...workerArg,
        })
      : supabase.rpc("payroll_inputs", {
          p_organisation_id: organisationId,
          p_period_start: target.periodStart,
          ...workerArg,
        }),
    offCycle ? Promise.resolve([]) : paidOffCycle(supabase, organisationId, target.periodStart),
  ]);
  // The code only: the message can name the period or the company.
  if (error) throw new Error(`Could not read pay inputs (${error.code})`);
  const parsed: PayrollInputs = parsePayrollInputs(raw);
  // A regular run leaves out workers a final-pay or missed-worker run of the period pays.
  const leftOut = new Set(excluded);
  const inputs: PayrollInputs =
    leftOut.size > 0
      ? { ...parsed, workers: parsed.workers.filter((w) => !leftOut.has(w.workerId)) }
      : parsed;
  const period = inputs.period;

  // Decision 15: one rule set for the whole run, the version in force on the pay date.
  const versions = await ruleSetVersions(supabase, organisationId);
  const runVersion = target.ruleSetId
    ? (versions.find((v) => v.id === target.ruleSetId) ?? null)
    : inForce(versions, target.payDate);
  if (target.ruleSetId && !runVersion) throw new Error("The run's rule set wasn't found");
  const rules = runVersion?.set ?? NTA_2025_V1;
  const ruleSetId = runVersion?.id ?? null;
  // The pay-policy figures of the version in force on each day worked (arrears included).
  const policyOn = (date: string): DayPolicy => {
    const v = inForce(versions, date);
    return v
      ? {
          overtimeMultiplierBps: v.set.policy.overtimeMultiplierBps,
          offDayPaidMinutes: v.set.policy.offDayPaidMinutes,
        }
      : {};
  };
  const policy = payPolicyFor(inputs, {
    overtimeMultiplierBps: rules.policy.overtimeMultiplierBps,
    offDayPaidMinutes: rules.policy.offDayPaidMinutes,
  });

  const removed = new Set(options.withoutAdjustmentIds ?? []);
  const adjustments = [
    ...(target.runId ? await runAdjustments(supabase, organisationId, target.runId) : []),
    ...(options.extraAdjustments ?? []),
  ].filter((a) => !removed.has(a.id));

  // A correction or one-off run pays only workers with an item on it.
  const withItems = new Set(adjustments.map((a) => a.workerId));
  const runWorkers = adjustmentsOnly
    ? inputs.workers.filter((w) => withItems.has(w.workerId))
    : inputs.workers;
  const workerIds = runWorkers.map((w) => w.workerId);
  const [history, bank, openDays, carried, regulars] = await Promise.all([
    runHistory(supabase, organisationId, period.start, workerIds),
    checkBankDetails(organisationId, workerIds),
    options.workerIds || adjustmentsOnly
      ? Promise.resolve([])
      : openDaysBySite(supabase, organisationId, period, offCycle ? workerIds : null),
    carriedSeries(supabase, organisationId, target.runId),
    offCycle ? regularItf(supabase, organisationId, period.start) : Promise.resolve([]),
  ]);
  const historyOf = (workerId: string) => {
    const h = workerHistory(workerId, history.previous, history.latestPosted);
    const paidBefore = h.paidBefore || history.paidAny.has(workerId);
    // Off-cycle: no net-change check; a correction or one-off run never takes a carried deduction.
    if (!offCycle) return { ...h, paidBefore };
    return {
      previousNetKobo: null,
      carriedKobo: adjustmentsOnly ? 0n : h.carriedKobo,
      paidBefore,
    };
  };

  // Earnings for everyone first; ITF depends on the run's levy base.
  const earnings = new Map<string, EarningsResult>();
  for (const w of runWorkers) {
    const e = computeEarnings(
      {
        period,
        holidays: inputs.holidays,
        defaultWorkDays: inputs.organisation.defaultWorkDays,
        worker: w,
        policyOn,
      },
      policy,
    );
    earnings.set(w.workerId, adjustmentsOnly ? adjustmentsOnlyEarnings(e) : e);
  }

  const compute = (itfApplies: boolean) => {
    const out = new Map<string, PayslipResult | null>();
    for (const w of runWorkers) {
      try {
        out.set(
          w.workerId,
          workerPayslip(
            {
              employmentType: w.employmentType as EmploymentType,
              earnings: earnings.get(w.workerId)!,
              adjustments: adjustments.filter((a) => a.workerId === w.workerId),
              nhfOptIn: w.statutory.nhfOptIn,
              annualRentKobo: w.statutory.annualRentKobo,
              carriedDeductionKobo: historyOf(w.workerId).carriedKobo,
            },
            rules,
            { itfApplies, ruleSetId: ruleSetId ?? "starting values, not yet saved" },
          ),
        );
      } catch (e) {
        if (!(e instanceof PayrollInputError)) throw e;
        out.set(w.workerId, null);
      }
    }
    return out;
  };

  let slips = compute(false);
  const ownItf = itfAppliesTo(
    runWorkers.flatMap((w) => {
      const s = slips.get(w.workerId);
      return s ? [{ employmentType: w.employmentType, grossKobo: s.grossKobo }] : [];
    }),
    rules,
  );
  // An off-cycle run follows the ITF choice of the period's regular run (slice 5.7b).
  const itfFrom = offCycle ? offCycleItf(regulars, period.start, ownItf) : null;
  const itfApplies = options.itfApplies ?? itfFrom?.itfApplies ?? ownItf;
  if (itfApplies) slips = compute(true);

  const workers: WorkerResult[] = [];
  const failed: string[] = [];
  const anomalies: RunAnomaly[] = [];
  for (const w of runWorkers) {
    const slip = slips.get(w.workerId) ?? null;
    const e = earnings.get(w.workerId)!;
    if (slip) {
      workers.push({
        workerId: w.workerId,
        employmentType: w.employmentType,
        taxState: w.statutory.taxState,
        pfaName: w.statutory.pfaName,
        earnings: e,
        payslip: slip,
      });
    } else {
      failed.push(w.workerId);
    }
    anomalies.push(
      ...workerAnomalies({
        workerId: w.workerId,
        employmentType: w.employmentType,
        startDate: w.startDate,
        endDate: w.endDate,
        period,
        taxState: w.statutory.taxState,
        pfaName: w.statutory.pfaName,
        hasRsaPin: w.statutory.hasRsaPin,
        earningsFlags: e.flags,
        noShowDates: e.days.noShowDates,
        payslip: slip,
        bank: bank.byWorker.get(w.workerId) ?? null,
        previousNetKobo: historyOf(w.workerId).previousNetKobo,
        paidBefore: historyOf(w.workerId).paidBefore,
        rules,
      }),
    );
    // A correction or one-off run can't carry a deduction to a later run: what it deducts must
    // fit what it pays (slice 5.7b).
    if (adjustmentsOnly && slip && slip.carriedForwardKobo > 0n) {
      anomalies.push({
        workerId: w.workerId,
        code: "calculation_failed",
        severity: "blocking",
        detail: { deduction_cut: true },
      });
    }
  }
  // An adjustment for a worker the inputs don't hold (left before the period, or not in a
  // one-worker preview's scope) blocks the run instead of stranding it (money review L-new-2).
  const inInputs = new Set(workerIds);
  for (const a of adjustments) {
    if (!inInputs.has(a.workerId) && !options.workerIds) {
      anomalies.push({
        workerId: a.workerId,
        code: "calculation_failed",
        severity: "blocking",
        detail: { adjustment_id: a.id },
      });
    }
  }
  anomalies.push(...runAnomalies(openDays, bank.shared));
  if (!options.workerIds) {
    // A correction or one-off run carries nothing from the period before.
    if (!adjustmentsOnly) anomalies.push(...previousPeriodAnomalies(history.previous));
    // Recurring instalments belong to the regular run.
    if (!offCycle) {
      anomalies.push(
        ...recurringAnomalies(
          history.previousSeries.filter((x) => workerIds.includes(x.workerId)),
          carried,
        ),
      );
    }
  }
  if (!bank.sharedCheck && workerIds.length > 0) {
    anomalies.push({
      workerId: null,
      code: "bank_shared_unchecked",
      severity: "warning",
      detail: {},
    });
  }

  // Decision 7: the canonical inputs, key order ignored. No personal numbers.
  const inputsSha256 = sha256(
    canonicalJson({
      v: 1,
      run: target.runId,
      period,
      pay_date: target.payDate,
      rule_set: runVersion
        ? { id: runVersion.id, rules: runVersion.rules, policy: runVersion.policy }
        : { id: null, name: NTA_2025_V1.name },
      versions: versions.map((v) => ({
        id: v.id,
        from: v.effectiveFrom,
        to: v.effectiveTo,
        policy: v.policy,
      })),
      inputs: raw,
      adjustments: [...adjustments].sort((a, b) => a.id.localeCompare(b.id)),
      ...(excluded.length > 0 ? { paid_off_cycle: excluded } : {}),
      ...(offCycle
        ? {
            off_cycle: {
              reason: offCycle.reason,
              workers: [...offCycle.workerIds].sort(),
              itf: itfFrom,
            },
          }
        : {}),
      bank: bank.fingerprint,
      previous: {
        run: history.previousRunId,
        posted: history.previous?.posted ?? null,
        workers: Object.fromEntries(
          workerIds.map((id) => {
            const h = historyOf(id);
            return [id, { net: h.previousNetKobo, carried: h.carriedKobo, paid: h.paidBefore }];
          }),
        ),
      },
    }),
  );

  const totals = runTotals(workers.map((w) => w.payslip));
  return {
    period,
    ruleSet: { id: ruleSetId, name: rules.name },
    workers,
    failed,
    anomalies,
    totals,
    itfApplies,
    inputsSha256,
    payload: resultsPayload(period, workers, anomalies, itfApplies),
  };
}

export interface SavedResults {
  payslips: number;
  anomalies: number;
}

/** Saves a calculation over the draft (the secret key; the database re-checks everything). */
export async function saveCalculation(
  organisationId: string,
  runId: string,
  actorId: string,
  calc: RunCalculation,
): Promise<SavedResults> {
  const admin = createAdminSupabase({ channel: "web" });
  const { data, error } = await admin.rpc("save_payroll_results", {
    p_organisation_id: organisationId,
    p_run_id: runId,
    p_actor: actorId,
    p_results: calc.payload as unknown as Json,
    p_inputs_sha256: calc.inputsSha256,
  });
  if (error) {
    const err = new Error(`Could not save the payroll results (${error.code})`) as Error & {
      code?: string;
      detail?: string;
    };
    err.code = error.code;
    err.detail = error.message;
    throw err;
  }
  const out = (data ?? {}) as { payslips?: number; anomalies?: number };
  return { payslips: out.payslips ?? 0, anomalies: out.anomalies ?? 0 };
}

export interface ApprovalCheck {
  checkId: string;
  matches: boolean;
  inputsSha256: string;
}

/**
 * Decision 7 (slice 5.3): re-gathers a submitted run's inputs as the approver (their own client,
 * so the database checks their role and session), hashes them with the engine's canonical form,
 * and records the hash with the secret key (`record_payroll_approval_check`, naming the approver).
 * `approve_payroll_run` then needs this check, by the same person, made in the last few minutes,
 * with the hash the run was submitted with. Nothing here changes the run.
 */
export async function checkInputsForApproval(
  supabase: Client,
  organisationId: string,
  run: { id: string; periodStart: string; payDate: string; ruleSetId: string },
  actorId: string,
): Promise<ApprovalCheck> {
  const admin = createAdminSupabase({ channel: "web" });
  // The database's clock before the read: approval refuses anything in the run's scope written
  // after it, which the read may have missed (money review M1).
  const clock = await admin.rpc("payroll_clock");
  if (clock.error || typeof clock.data !== "string") {
    throw new Error(`Could not read the database clock (${clock.error?.code ?? "no value"})`);
  }
  const calc = await calculateRun(supabase, organisationId, {
    runId: run.id,
    periodStart: run.periodStart,
    payDate: run.payDate,
    ruleSetId: run.ruleSetId,
  });
  const { data, error } = await admin.rpc("record_payroll_approval_check", {
    p_organisation_id: organisationId,
    p_run_id: run.id,
    p_actor: actorId,
    p_inputs_sha256: calc.inputsSha256,
    p_read_started_at: clock.data,
  });
  if (error) {
    const err = new Error(`Could not check the run's inputs (${error.code})`) as Error & {
      code?: string;
      detail?: string;
    };
    err.code = error.code;
    err.detail = error.message;
    throw err;
  }
  const out = (data ?? {}) as { check_id?: string; matches?: boolean };
  return {
    checkId: out.check_id ?? "",
    matches: out.matches === true,
    inputsSha256: calc.inputsSha256,
  };
}
