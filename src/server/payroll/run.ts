import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { toKobo } from "@/lib/money";
import type { EmploymentType, PayslipResult } from "@/lib/payroll/contract";
import { computeEarnings, type DayPolicy, type EarningsResult } from "@/lib/payroll/earnings";
import {
  parseLeaveCorrections,
  parsePayrollInputs,
  type LeaveCorrections,
  type PayrollInputs,
} from "@/lib/payroll/inputs";
import { NTA_2025_V1, parseRuleSet, type RuleSet } from "@/lib/payroll/rule-set";
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
    previousSeries: [],
  };
  const { data: runs, error } = await supabase
    .from("payroll_runs")
    .select("id, kind, status, period_start, period_end")
    .eq("organisation_id", organisationId)
    .lt("period_start", periodStart)
    .order("period_start", { ascending: false })
    .limit(400);
  if (error) throw new Error(`Could not read earlier runs (${error.code})`);
  const all = runs ?? [];
  // The latest regular run of an earlier period, whatever its exact end (money review L-new-3).
  // A reversed run (slice 5.7a) gives way to its period's new run; with none, the reversed run
  // stands for the period and is not posted.
  const regular = all.filter((r) => r.kind === "regular");
  const top = regular[0]?.period_start;
  const atTop = regular.filter((r) => r.period_start === top);
  const prev = atTop.find((r) => r.status !== "reversed") ?? atTop[0];
  // A reversal run's copies never count as a worker's posted pay.
  const posted = all.filter((r) => POSTED.has(r.status) && r.kind !== "reversal");
  const order = new Map(posted.map((r, i) => [r.id, i] as const));
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
): Promise<OpenDaysAtSite[]> {
  const { data, error } = await supabase
    .from("timesheet_lines")
    .select("site_id, exceptions")
    .eq("organisation_id", organisationId)
    .gte("work_date", period.start)
    .lte("work_date", period.end)
    .in("status", ["pending", "disputed"])
    .limit(20000);
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

/** Slice 5.7c: the run's leave corrections (`payroll_leave_corrections`), as the signed-in user. */
async function loadLeaveCorrections(
  supabase: Client,
  organisationId: string,
  periodStart: string,
  workerIds: readonly string[],
  runId: string | null,
): Promise<{ raw: unknown; parsed: LeaveCorrections }> {
  const { data, error } = await supabase.rpc("payroll_leave_corrections", {
    p_organisation_id: organisationId,
    p_period_start: periodStart,
    p_worker_ids: [...workerIds],
    ...(runId ? { p_run_id: runId } : {}),
  });
  // The code only: the message can name the period or the company.
  if (error) throw new Error(`Could not read leave corrections (${error.code})`);
  return { raw: data, parsed: parseLeaveCorrections(data) };
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
  const workerArg = options.workerIds ? { p_worker_ids: [...options.workerIds] } : {};
  const { data: raw, error } = target.runId
    ? await supabase.rpc("payroll_run_inputs", {
        p_organisation_id: organisationId,
        p_period_start: target.periodStart,
        p_run_id: target.runId,
        ...workerArg,
      })
    : await supabase.rpc("payroll_inputs", {
        p_organisation_id: organisationId,
        p_period_start: target.periodStart,
        ...workerArg,
      });
  // The code only: the message can name the period or the company.
  if (error) throw new Error(`Could not read pay inputs (${error.code})`);
  const inputs: PayrollInputs = parsePayrollInputs(raw);
  const period = inputs.period;
  // Slice 5.7c: leave decided after its period was posted (arrears and refunds), read beside the
  // inputs as the same user and hashed with them.
  const corrections = await loadLeaveCorrections(
    supabase,
    organisationId,
    period.start,
    inputs.workers.map((w) => w.workerId),
    target.runId,
  );

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

  const workerIds = inputs.workers.map((w) => w.workerId);
  const [history, bank, openDays, carried] = await Promise.all([
    runHistory(supabase, organisationId, period.start, workerIds),
    checkBankDetails(organisationId, workerIds),
    options.workerIds ? Promise.resolve([]) : openDaysBySite(supabase, organisationId, period),
    carriedSeries(supabase, organisationId, target.runId),
  ]);
  const historyOf = (workerId: string) =>
    workerHistory(workerId, history.previous, history.latestPosted);

  // Earnings for everyone first; ITF depends on the run's levy base.
  const earnings = new Map<string, EarningsResult>();
  for (const w of inputs.workers) {
    earnings.set(
      w.workerId,
      computeEarnings(
        {
          period,
          holidays: inputs.holidays,
          defaultWorkDays: inputs.organisation.defaultWorkDays,
          worker: { ...w, ...corrections.parsed.byWorker.get(w.workerId) },
          policyOn,
        },
        policy,
      ),
    );
  }

  const compute = (itfApplies: boolean) => {
    const out = new Map<string, PayslipResult | null>();
    for (const w of inputs.workers) {
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
  const itfApplies =
    options.itfApplies ??
    itfAppliesTo(
      inputs.workers.flatMap((w) => {
        const s = slips.get(w.workerId);
        return s ? [{ employmentType: w.employmentType, grossKobo: s.grossKobo }] : [];
      }),
      rules,
    );
  if (itfApplies) slips = compute(true);

  const workers: WorkerResult[] = [];
  const failed: string[] = [];
  const anomalies: RunAnomaly[] = [];
  for (const w of inputs.workers) {
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
    anomalies.push(...previousPeriodAnomalies(history.previous));
    anomalies.push(
      ...recurringAnomalies(
        history.previousSeries.filter((x) => workerIds.includes(x.workerId)),
        carried,
      ),
    );
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
      // Present only when there is something to correct, so runs without corrections keep the
      // hash they had before slice 5.7c.
      ...(corrections.parsed.byWorker.size > 0 ? { leave_corrections: corrections.raw } : {}),
      adjustments: [...adjustments].sort((a, b) => a.id.localeCompare(b.id)),
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
