import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatDate } from "@/lib/dates";
import { formatLeaveRange } from "@/lib/leave/requests";
import { formatNaira, parseNairaToKobo, toKobo, type Kobo } from "@/lib/money";
import { PAYROLL_READERS } from "@/lib/pay-access";
import type { RunTotals } from "@/lib/payroll/run";
import type { ManagerRole } from "@/lib/roles";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

import { calculateRun, checkInputsForApproval, saveCalculation, type RunCalculation } from "./run";
import { loadLastPostedRun, loadRun, type PayrollRunRow } from "./run-data";

/**
 * The payroll run's writes (slices 5.2 and 5.3; docs/PHASE_5.md "Roles and access"): owner and hr
 * prepare, recalculate, adjust, acknowledge and submit; owner and finance return or approve a
 * submitted run, never someone who prepared or changed it (rule 10, checked in SQL against
 * private.payroll_run_touchers). Admins, ops managers and line managers see nothing. Every write
 * is one SQL function called as the user, which checks the role again; the calculation runs here
 * on the server and is saved with `save_payroll_results` (the secret key), never sent by the
 * client. Approval first re-gathers the inputs on the server and records their hash
 * (`checkInputsForApproval`); the database refuses an approval whose inputs changed. Every money
 * write has a preview (src/server/capabilities/payroll-previews.ts). Module: payroll.
 */

type Client = SupabaseClient<Database>;

export { PAYROLL_READERS };
export const PAYROLL_PREPARERS = ["owner", "hr"] as const satisfies readonly ManagerRole[];
export const PAYROLL_APPROVERS = ["owner", "finance"] as const satisfies readonly ManagerRole[];

export function canPreparePayroll(role: ManagerRole): boolean {
  return (PAYROLL_PREPARERS as readonly ManagerRole[]).includes(role);
}

export function canDecidePayroll(role: ManagerRole): boolean {
  return (PAYROLL_APPROVERS as readonly ManagerRole[]).includes(role);
}

const reload = "Reload the page and try again";
const isoDate = z.iso.date("Choose a date");
const text = (max: number, what: string) => {
  const message = `${what} in up to ${max} characters, with no web addresses`;
  return z
    .string(message)
    .trim()
    .min(1, message)
    .max(max, message)
    .refine((v) => !/[\u0001-\u001f\u007f-\u009f<>]/.test(v), message)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), message);
};
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");

export const runIdSchema = z.object({ runId: z.uuid(reload) });

export const createRunSchema = z.object({
  periodStart: isoDate,
  payDate: z
    .union([isoDate, z.literal("")])
    .optional()
    .transform((v) => (v ? v : null)),
});

const amountMessage = "Enter an amount above ₦0, like 15000 or 15,000.50";
export const adjustmentSchema = z.object({
  runId: z.uuid(reload),
  workerId: z.uuid("Choose a worker"),
  kind: z.enum(["earning", "deduction"], "Choose an earning or a deduction"),
  label: text(80, "Name the item"),
  amount: z
    .string(amountMessage)
    .trim()
    .transform((v, ctx): Kobo => {
      try {
        const kobo = parseNairaToKobo(v);
        if (kobo <= 0n || kobo > 100_000_000_000n) throw new RangeError("out of range");
        return kobo;
      } catch {
        ctx.addIssue({ code: "custom", message: amountMessage });
        return z.NEVER;
      }
    }),
  pensionable: checkbox,
  instalments: z.coerce
    .number("Instalments are 1 to 60")
    .int("Instalments are 1 to 60")
    .min(1, "Instalments are 1 to 60")
    .max(60, "Instalments are 1 to 60")
    .default(1),
  reason: text(500, "Give a reason"),
});

export const carryInstalmentSchema = z.object({
  runId: z.uuid(reload),
  seriesId: z.uuid(reload),
});

export const removeAdjustmentSchema = z.object({
  adjustmentId: z.uuid(reload),
  reason: text(500, "Give a reason"),
});

export const acknowledgeSchema = z.object({
  runId: z.uuid(reload),
  anomalyIds: z
    .array(z.uuid(reload), "Choose at least one anomaly")
    .min(1, "Choose at least one anomaly")
    .max(5000),
});

export const returnRunSchema = z.object({
  runId: z.uuid(reload),
  reason: text(500, "Say why"),
});

/** Rule 10's refusal, as the approver reads it. */
export const TWO_PERSON_MESSAGE =
  "You prepared or changed this run, so a different person must approve it. Ask Finance or another owner.";

/** The refusal when the inputs changed after the run was worked out (decision 7). */
export const INPUTS_CHANGED_MESSAGE =
  "Something this run was worked out from has changed since (a timesheet day, a pay rate, leave or bank details). Return it to HR to recalculate.";

/** Database refusals in plain English. */
export function fromPayrollRunDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "MLPRE") throw new MutationError("invalid", TWO_PERSON_MESSAGE);
  if (error.code === "42501") {
    throw new MutationError(
      "forbidden",
      "Your role can't do this in payroll. HR or the owner prepares; Finance or the owner decides.",
    );
  }
  if (error.code === "P0002")
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  if (/^MLPR[46ABCDF]$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code})`);
}

export async function draftRun(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<PayrollRunRow> {
  const run = await loadRun(supabase, organisationId, runId);
  if (!run) throw new MutationError("invalid", "That payroll run wasn't found. Reload the page.");
  if (run.status !== "draft") {
    throw new MutationError("invalid", "This run isn't a draft, so it can't change.");
  }
  return run;
}

export const targetOf = (run: PayrollRunRow) => ({
  runId: run.id,
  periodStart: run.periodStart,
  payDate: run.payDate,
  ruleSetId: run.ruleSetId,
});

/** Recalculates a draft and saves it over the old results. */
export async function recalculateAndSave(
  ctx: Pick<MutationContext, "supabase" | "organisationId" | "userId">,
  run: PayrollRunRow,
): Promise<RunCalculation> {
  const calc = await calculateRun(ctx.supabase, ctx.organisationId, targetOf(run));
  try {
    await saveCalculation(ctx.organisationId, run.id, ctx.userId, calc);
  } catch (error) {
    const e = error as { code?: string; detail?: string };
    if (e.code && /^MLPR[CD]$/.test(e.code)) {
      throw new MutationError("invalid", e.detail ?? "The run changed. Reload the page.");
    }
    if (e.code === "MLPR6") {
      // The database refused figures the engine produced: nothing was saved.
      throw new MutationError(
        "invalid",
        `The new figures didn't pass the database's payroll checks, so nothing was saved (${e.detail ?? "invariant"}). Reload and recalculate; if it happens again, tell Metalira support.`,
      );
    }
    throw error;
  }
  return calc;
}

// ---------------------------------------------------------------------------
// Previews (the confirm step; the registry's preview)
// ---------------------------------------------------------------------------

const money = (k: Kobo) => formatNaira(k, { whole: k % 100n === 0n });

function totalsChanges(before: RunTotals | null, after: RunTotals): CapabilityPreview["changes"] {
  const row = (label: string, pick: (t: RunTotals) => Kobo) => ({
    label,
    ...(before ? { before: money(pick(before)) } : {}),
    after: money(pick(after)),
  });
  return [
    {
      label: "Workers",
      ...(before ? { before: String(before.workerCount) } : {}),
      after: String(after.workerCount),
    },
    row("Gross pay", (t) => t.grossKobo),
    row("PAYE", (t) => t.payeKobo),
    row("Employee pension", (t) => t.pensionEmployeeKobo),
    row("Net pay", (t) => t.netKobo),
    row("Employer cost", (t) => t.employerCostKobo),
  ];
}

const blockingOf = (calc: RunCalculation) =>
  calc.anomalies.filter((a) => a.severity === "blocking").length;

export async function previewCreateRun(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof createRunSchema>,
): Promise<CapabilityPreview> {
  const { data: period, error } = await ctx.supabase.rpc("payroll_period", {
    p_organisation_id: ctx.organisationId,
    p_date: data.periodStart,
  });
  if (error) fromPayrollRunDbError(error);
  const p = period?.[0];
  if (!p || p.period_start !== data.periodStart) {
    throw new MutationError("invalid", "Choose a pay period by its first day.");
  }
  const payDate = data.payDate ?? p.pay_date;
  const calc = await calculateRun(ctx.supabase, ctx.organisationId, {
    runId: null,
    periodStart: p.period_start,
    payDate,
    ruleSetId: null,
  });
  const last = await loadLastPostedRun(ctx.supabase, ctx.organisationId, p.period_start);
  const range = formatLeaveRange(p.period_start, p.period_end);
  return {
    summary: `Prepares ${range} for ${calc.totals.workerCount} ${calc.totals.workerCount === 1 ? "worker" : "workers"}, paid ${formatDate(payDate)}, with ${calc.ruleSet.name}: net pay ${money(calc.totals.netKobo)}, ${calc.anomalies.length} anomalies (${blockingOf(calc)} blocking). ${last ? `Compared with ${formatLeaveRange(last.periodStart, last.periodEnd)}.` : "No earlier posted run to compare with."}`,
    changes: totalsChanges(last?.totals ?? null, calc.totals),
  };
}

export async function previewRecalculate(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof runIdSchema>,
): Promise<CapabilityPreview> {
  const run = await draftRun(ctx.supabase, ctx.organisationId, data.runId);
  const calc = await calculateRun(ctx.supabase, ctx.organisationId, targetOf(run));
  const same = calc.inputsSha256 === run.inputsSha256;
  return {
    summary: `${same ? "Nothing in the inputs changed since the last calculation." : "The inputs changed since the last calculation."} Net pay ${money(run.totals.netKobo)} becomes ${money(calc.totals.netKobo)} for ${calc.totals.workerCount} workers; ${calc.anomalies.length} anomalies (${blockingOf(calc)} blocking).`,
    changes: totalsChanges(run.calculatedAt ? run.totals : null, calc.totals),
  };
}

function workerNet(calc: RunCalculation, workerId: string): Kobo | null {
  return calc.workers.find((w) => w.workerId === workerId)?.payslip.netKobo ?? null;
}

export async function previewAddAdjustment(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof adjustmentSchema>,
): Promise<CapabilityPreview> {
  const run = await draftRun(ctx.supabase, ctx.organisationId, data.runId);
  const options = { workerIds: [data.workerId], itfApplies: run.itfApplies };
  const extra = {
    id: "00000000-0000-4000-8000-000000000000",
    workerId: data.workerId,
    kind: data.kind,
    label: data.label,
    amountKobo: data.amount,
    pensionable: data.kind === "earning" && data.pensionable,
    taxable: data.kind === "earning",
    instalmentNumber: 1,
    instalmentCount: data.instalments,
  } as const;
  const [before, after] = await Promise.all([
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), options),
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), {
      ...options,
      extraAdjustments: [extra],
    }),
  ]);
  const b = workerNet(before, data.workerId);
  const a = workerNet(after, data.workerId);
  const what = data.kind === "earning" ? "an earning" : "a deduction";
  return {
    summary: `Adds ${what} of ${money(data.amount)} (${data.label}${data.instalments > 1 ? `, 1 of ${data.instalments}` : ""}): this worker's net pay ${b === null ? "can't be worked out yet" : money(b)} becomes ${a === null ? "something that can't be worked out" : money(a)}. The run is recalculated.`,
    changes: [
      {
        label: "Net pay",
        ...(b !== null ? { before: money(b) } : {}),
        after: a === null ? "Can't be worked out" : money(a),
      },
    ],
  };
}

export async function previewRemoveAdjustment(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof removeAdjustmentSchema>,
): Promise<CapabilityPreview> {
  const { data: adj, error } = await ctx.supabase
    .from("payroll_adjustments")
    .select("id, run_id, worker_id, label")
    .eq("organisation_id", ctx.organisationId)
    .eq("id", data.adjustmentId)
    .maybeSingle();
  if (error) fromPayrollRunDbError(error);
  if (!adj) throw new MutationError("invalid", "That adjustment wasn't found. Reload the page.");
  const run = await draftRun(ctx.supabase, ctx.organisationId, adj.run_id);
  const options = { workerIds: [adj.worker_id], itfApplies: run.itfApplies };
  const [before, after] = await Promise.all([
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), options),
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), {
      ...options,
      withoutAdjustmentIds: [adj.id],
    }),
  ]);
  const b = workerNet(before, adj.worker_id);
  const a = workerNet(after, adj.worker_id);
  return {
    summary: `Removes ${adj.label}: this worker's net pay ${b === null ? "can't be worked out" : money(b)} becomes ${a === null ? "something that can't be worked out" : money(a)}. The run is recalculated.`,
    changes: [
      {
        label: "Net pay",
        ...(b !== null ? { before: money(b) } : {}),
        after: a === null ? "Can't be worked out" : money(a),
      },
    ],
  };
}

/** The series' latest instalment in an earlier run (what "Carry next instalment" continues). */
async function lastInstalment(
  supabase: Client,
  organisationId: string,
  run: PayrollRunRow,
  seriesId: string,
) {
  const { data, error } = await supabase
    .from("payroll_adjustments")
    .select(
      "worker_id, kind, label, amount_kobo::text, instalment_number, instalment_count, payroll_runs!payroll_adjustments_run_fkey ( period_start )",
    )
    .eq("organisation_id", organisationId)
    .eq("series_id", seriesId)
    .order("instalment_number", { ascending: false });
  if (error) fromPayrollRunDbError(error);
  return (
    (data ?? []).find(
      (a) => a.payroll_runs !== null && a.payroll_runs.period_start < run.periodStart,
    ) ?? null
  );
}

export async function previewCarryInstalment(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof carryInstalmentSchema>,
): Promise<CapabilityPreview> {
  const run = await draftRun(ctx.supabase, ctx.organisationId, data.runId);
  const last = await lastInstalment(ctx.supabase, ctx.organisationId, run, data.seriesId);
  if (!last)
    throw new MutationError("invalid", "That recurring item wasn't found. Reload the page.");
  if (last.instalment_number >= last.instalment_count) {
    throw new MutationError("invalid", "Every instalment of that item is already paid.");
  }
  const amount = money(toKobo(last.amount_kobo));
  const next = last.instalment_number + 1;
  return {
    summary: `Carries instalment ${next} of ${last.instalment_count} of ${last.label} (${last.kind === "deduction" ? "a deduction" : "an earning"} of ${amount}) onto this run, in the same series, so it is never deducted twice. The run is recalculated.`,
    changes: [{ label: last.label, after: `${amount} · ${next} of ${last.instalment_count}` }],
  };
}

export async function previewSubmit(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof runIdSchema>,
): Promise<CapabilityPreview> {
  const run = await draftRun(ctx.supabase, ctx.organisationId, data.runId);
  const { data: anomalies, error } = await ctx.supabase
    .from("payroll_anomalies")
    .select("severity, acknowledged_at")
    .eq("organisation_id", ctx.organisationId)
    .eq("run_id", run.id);
  if (error) fromPayrollRunDbError(error);
  const all = anomalies ?? [];
  const blocking = all.filter((a) => a.severity === "blocking").length;
  const acked = all.filter((a) => a.acknowledged_at !== null).length;
  const t = run.totals;
  return {
    summary: `Submits ${formatLeaveRange(run.periodStart, run.periodEnd)} to Finance: net pay ${money(t.netKobo)} to ${t.workerCount} workers; ${acked} of ${all.length} anomalies acknowledged${blocking > 0 ? `, ${blocking} blocking` : ""}. A different person in Finance must approve before any payment file is released.`,
    changes: [
      { label: "Net pay", after: money(t.netKobo) },
      { label: "PAYE", after: money(t.payeKobo) },
      { label: "Pension (8% + 10%)", after: money(t.pensionEmployeeKobo + t.pensionEmployerKobo) },
      { label: "NSITF and ITF", after: money(t.nsitfKobo + t.itfKobo) },
      { label: "Anomalies acknowledged", after: `${acked} of ${all.length}` },
    ],
  };
}

export async function previewReturn(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof returnRunSchema>,
): Promise<CapabilityPreview> {
  const run = await loadRun(ctx.supabase, ctx.organisationId, data.runId);
  if (!run) throw new MutationError("invalid", "That payroll run wasn't found. Reload the page.");
  if (run.kind === "reversal") {
    return {
      summary: `Declines the reversal of ${formatLeaveRange(run.periodStart, run.periodEnd)}: "${data.reason}". The run stays approved; a new reversal can be asked for.`,
      changes: [{ label: "Reversal", before: "Waiting for approval", after: "Declined" }],
    };
  }
  return {
    summary: `Returns ${formatLeaveRange(run.periodStart, run.periodEnd)} to HR as a draft: "${data.reason}". Nothing is paid.`,
    changes: [{ label: "Status", before: "Waiting for approval", after: "Draft" }],
  };
}

/**
 * Who prepared or changed the run, as far as the signed-in approver can read it (the preparer, the
 * last recalculator, the submitters, adjusters and acknowledgers). The database checks the full
 * list (private.payroll_run_touchers, with every earlier recalculation from the audit log); this
 * only lets the preview say so before anything is worked out.
 */
async function visibleTouchers(
  supabase: Client,
  organisationId: string,
  run: PayrollRunRow,
): Promise<Set<string>> {
  const [adjustments, anomalies, decisions] = await Promise.all([
    supabase
      .from("payroll_adjustments")
      .select("created_by")
      .eq("organisation_id", organisationId)
      .eq("run_id", run.id),
    supabase
      .from("payroll_anomalies")
      .select("acknowledged_by")
      .eq("organisation_id", organisationId)
      .eq("run_id", run.id)
      .not("acknowledged_by", "is", null),
    supabase
      .from("payroll_run_decisions")
      .select("actor_id")
      .eq("organisation_id", organisationId)
      .eq("run_id", run.id)
      .eq("decision", "submitted"),
  ]);
  if (adjustments.error) fromPayrollRunDbError(adjustments.error);
  if (anomalies.error) fromPayrollRunDbError(anomalies.error);
  if (decisions.error) fromPayrollRunDbError(decisions.error);
  return new Set(
    [
      run.preparedBy,
      run.calculatedBy,
      run.submittedBy,
      ...(adjustments.data ?? []).map((a) => a.created_by),
      ...(anomalies.data ?? []).map((a) => a.acknowledged_by),
      ...(decisions.data ?? []).map((d) => d.actor_id),
    ].filter((id): id is string => typeof id === "string"),
  );
}

async function runInReview(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<PayrollRunRow> {
  const run = await loadRun(supabase, organisationId, runId);
  if (!run) throw new MutationError("invalid", "That payroll run wasn't found. Reload the page.");
  if (run.status !== "review") {
    throw new MutationError("invalid", "This run isn't waiting for approval. Reload the page.");
  }
  return run;
}

/**
 * "Approve": the control totals and every acknowledged anomaly, after re-gathering the inputs (as
 * approval does, without recording anything). Refused up front to someone who prepared or
 * changed the run, and when the inputs changed since it was worked out.
 */
export async function previewApprove(
  ctx: Pick<MutationContext, "supabase" | "organisationId" | "userId">,
  data: z.output<typeof runIdSchema>,
): Promise<CapabilityPreview> {
  const run = await runInReview(ctx.supabase, ctx.organisationId, data.runId);
  if ((await visibleTouchers(ctx.supabase, ctx.organisationId, run)).has(ctx.userId)) {
    throw new MutationError("invalid", TWO_PERSON_MESSAGE);
  }
  const [calc, anomalies] = await Promise.all([
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run)),
    ctx.supabase
      .from("payroll_anomalies")
      .select("code, acknowledged_at")
      .eq("organisation_id", ctx.organisationId)
      .eq("run_id", run.id),
  ]);
  if (anomalies.error) fromPayrollRunDbError(anomalies.error);
  if (calc.inputsSha256 !== run.inputsSha256) {
    throw new MutationError("invalid", INPUTS_CHANGED_MESSAGE);
  }
  const acked = (anomalies.data ?? []).filter((a) => a.acknowledged_at !== null);
  const byCode = new Map<string, number>();
  for (const a of acked) byCode.set(a.code, (byCode.get(a.code) ?? 0) + 1);
  const t = run.totals;
  const workers = `${t.workerCount} ${t.workerCount === 1 ? "worker" : "workers"}`;
  const ackText = `${acked.length} ${acked.length === 1 ? "anomaly was" : "anomalies were"} acknowledged by HR`;
  return {
    summary: `Approves ${formatLeaveRange(run.periodStart, run.periodEnd)}: net pay ${money(t.netKobo)} to ${workers}, paid ${formatDate(run.payDate)}. Nothing it was worked out from has changed. ${ackText}. Approving posts the payslips (they never change after) and locks the period's timesheets.`,
    changes: [
      { label: "Workers", after: String(t.workerCount) },
      { label: "Gross pay", after: money(t.grossKobo) },
      { label: "PAYE", after: money(t.payeKobo) },
      { label: "Pension (8% + 10%)", after: money(t.pensionEmployeeKobo + t.pensionEmployerKobo) },
      { label: "NHF", after: money(t.nhfKobo) },
      { label: "NSITF and ITF", after: money(t.nsitfKobo + t.itfKobo) },
      { label: "Net pay", after: money(t.netKobo) },
      { label: "Employer cost", after: money(t.employerCostKobo) },
      { label: "Anomalies acknowledged", after: String(acked.length) },
      ...[...byCode].map(([code, n]) => ({
        label: `Acknowledged: ${code.replace(/_/g, " ")}`,
        after: String(n),
      })),
    ],
  };
}

export function previewAcknowledge(
  _ctx: unknown,
  data: z.output<typeof acknowledgeSchema>,
): CapabilityPreview {
  const n = data.anomalyIds.length;
  return {
    summary: `Acknowledges ${n} ${n === 1 ? "anomaly" : "anomalies"}. Open timesheet days are paid next run; Finance sees every acknowledgement when approving.`,
    changes: [{ label: "Acknowledged", after: String(n) }],
  };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export interface CreatedRun {
  runId: string;
  calculated: boolean;
}

/** Creates the period's run and calculates it. */
export const createRunSpec: MutationSpec<typeof createRunSchema, CreatedRun> = {
  module: "payroll",
  schema: createRunSchema,
  roles: PAYROLL_PREPARERS,
  run: async (ctx) => {
    const { data: runId, error } = await ctx.supabase.rpc("create_payroll_run", {
      p_organisation_id: ctx.organisationId,
      p_period_start: ctx.data.periodStart,
      ...(ctx.data.payDate ? { p_pay_date: ctx.data.payDate } : {}),
    });
    if (error) fromPayrollRunDbError(error);
    const run = await loadRun(ctx.supabase, ctx.organisationId, runId!);
    if (!run) return { runId: runId!, calculated: false };
    try {
      await recalculateAndSave(ctx, run);
      return { runId: run.id, calculated: true };
    } catch (e) {
      // The run exists, empty and marked for recalculation; the screen offers Recalculate.
      console.error("payroll.first_calculation_failed:", e instanceof Error ? e.name : "unknown");
      return { runId: run.id, calculated: false };
    }
  },
};

export const recalculateRunSpec: MutationSpec<typeof runIdSchema, { runId: string }> = {
  module: "payroll",
  schema: runIdSchema,
  roles: PAYROLL_PREPARERS,
  run: async (ctx) => {
    const run = await draftRun(ctx.supabase, ctx.organisationId, ctx.data.runId);
    await recalculateAndSave(ctx, run);
    return { runId: run.id };
  },
};

export const addAdjustmentSpec: MutationSpec<typeof adjustmentSchema, { runId: string }> = {
  module: "payroll",
  schema: adjustmentSchema,
  roles: PAYROLL_PREPARERS,
  run: async (ctx) => {
    const d = ctx.data;
    const { error } = await ctx.supabase.rpc("add_payroll_adjustment", {
      p_organisation_id: ctx.organisationId,
      p_run_id: d.runId,
      p_worker_id: d.workerId,
      p_kind: d.kind,
      p_label: d.label,
      // Whole kobo as text: no number ever holds kobo.
      p_amount_kobo: d.amount.toString(),
      p_pensionable: d.kind === "earning" && d.pensionable,
      p_taxable: d.kind === "earning",
      p_instalments: d.instalments,
      p_reason: d.reason,
    });
    if (error) fromPayrollRunDbError(error);
    const run = await draftRun(ctx.supabase, ctx.organisationId, d.runId);
    await recalculateAndSave(ctx, run);
    return { runId: d.runId };
  },
};

export const carryInstalmentSpec: MutationSpec<typeof carryInstalmentSchema, { runId: string }> = {
  module: "payroll",
  schema: carryInstalmentSchema,
  roles: PAYROLL_PREPARERS,
  run: async (ctx) => {
    const { error } = await ctx.supabase.rpc("carry_payroll_instalment", {
      p_organisation_id: ctx.organisationId,
      p_run_id: ctx.data.runId,
      p_series_id: ctx.data.seriesId,
    });
    if (error) fromPayrollRunDbError(error);
    const run = await draftRun(ctx.supabase, ctx.organisationId, ctx.data.runId);
    await recalculateAndSave(ctx, run);
    return { runId: run.id };
  },
};

export const removeAdjustmentSpec: MutationSpec<typeof removeAdjustmentSchema, { runId: string }> =
  {
    module: "payroll",
    schema: removeAdjustmentSchema,
    roles: PAYROLL_PREPARERS,
    run: async (ctx) => {
      const { data: adj, error: readError } = await ctx.supabase
        .from("payroll_adjustments")
        .select("run_id")
        .eq("organisation_id", ctx.organisationId)
        .eq("id", ctx.data.adjustmentId)
        .maybeSingle();
      if (readError) fromPayrollRunDbError(readError);
      if (!adj)
        throw new MutationError("invalid", "That adjustment wasn't found. Reload the page.");
      const { error } = await ctx.supabase.rpc("remove_payroll_adjustment", {
        p_organisation_id: ctx.organisationId,
        p_adjustment_id: ctx.data.adjustmentId,
        p_reason: ctx.data.reason,
      });
      if (error) fromPayrollRunDbError(error);
      const run = await draftRun(ctx.supabase, ctx.organisationId, adj.run_id);
      await recalculateAndSave(ctx, run);
      return { runId: adj.run_id };
    },
  };

export const acknowledgeSpec: MutationSpec<typeof acknowledgeSchema, number> = {
  module: "payroll",
  schema: acknowledgeSchema,
  roles: PAYROLL_PREPARERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: count, error } = await supabase.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: organisationId,
      p_run_id: data.runId,
      p_anomaly_ids: data.anomalyIds,
    });
    if (error) fromPayrollRunDbError(error);
    return count ?? 0;
  },
};

export const submitRunSpec: MutationSpec<
  typeof runIdSchema,
  { runId: string; decisionId: string }
> = {
  module: "payroll",
  schema: runIdSchema,
  roles: PAYROLL_PREPARERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: decisionId, error } = await supabase.rpc("submit_payroll_run", {
      p_organisation_id: organisationId,
      p_run_id: data.runId,
    });
    if (error) fromPayrollRunDbError(error);
    return { runId: data.runId, decisionId: decisionId! };
  },
};

export const returnRunSpec: MutationSpec<
  typeof returnRunSchema,
  { runId: string; decisionId: string }
> = {
  module: "payroll",
  schema: returnRunSchema,
  roles: PAYROLL_APPROVERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: decisionId, error } = await supabase.rpc("return_payroll_run", {
      p_organisation_id: organisationId,
      p_run_id: data.runId,
      p_reason: data.reason,
    });
    if (error) fromPayrollRunDbError(error);
    return { runId: data.runId, decisionId: decisionId! };
  },
};

/**
 * Approves a submitted run (owner or finance; never someone who prepared or changed it): the
 * server re-gathers the inputs as the approver and records their hash, then the database approves
 * only when that hash is the one the run was worked out with (decision 7). Posting: the payslips
 * never change after, and the period's timesheets lock.
 */
export const approveRunSpec: MutationSpec<
  typeof runIdSchema,
  { runId: string; decisionId: string }
> = {
  module: "payroll",
  schema: runIdSchema,
  roles: PAYROLL_APPROVERS,
  run: async (ctx) => {
    const run = await runInReview(ctx.supabase, ctx.organisationId, ctx.data.runId);
    if ((await visibleTouchers(ctx.supabase, ctx.organisationId, run)).has(ctx.userId)) {
      throw new MutationError("invalid", TWO_PERSON_MESSAGE);
    }
    try {
      await checkInputsForApproval(ctx.supabase, ctx.organisationId, run, ctx.userId);
    } catch (error) {
      const e = error as { code?: string };
      if (e.code === "MLPRD" || e.code === "P0002") {
        throw new MutationError("invalid", "This run isn't waiting for approval. Reload the page.");
      }
      if (e.code === "42501") {
        throw new MutationError("forbidden", "Only Finance or an owner approves payroll.");
      }
      throw error;
    }
    const { data: decisionId, error } = await ctx.supabase.rpc("approve_payroll_run", {
      p_organisation_id: ctx.organisationId,
      p_run_id: run.id,
    });
    if (error) {
      // MLPRF says which: the inputs changed since HR worked the run out ("return it to HR"), or
      // something changed while this approval ran ("try again").
      if (error.code === "MLPRF") throw new MutationError("invalid", error.message);
      fromPayrollRunDbError(error);
    }
    return { runId: run.id, decisionId: decisionId! };
  },
};
