import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { formatLeaveRange } from "@/lib/leave/requests";
import { formatNaira, parseNairaToKobo, type Kobo } from "@/lib/money";
import { negatedTotals } from "@/lib/payroll/reversal";
import type { RunTotals } from "@/lib/payroll/run";
import { runMonth } from "@/lib/payroll/run-format";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";

import { calculateRun } from "./run";
import { loadRun, type PayrollRunRow } from "./run-data";
import {
  draftRun,
  fromPayrollRunDbError,
  PAYROLL_APPROVERS,
  PAYROLL_PREPARERS,
  recalculateAndSave,
  targetOf,
} from "./runs";

/**
 * Payroll reversal and corrections (slice 5.7a; migration 20261122180000).
 *
 * - "Reverse this run": owner or finance ask for an approved run that isn't released to be
 *   reversed, with a reason. The database makes a reversal run with a copy of every payslip and
 *   line (sign -1, so it sums to minus the run) and it waits for a second person.
 * - "Approve the reversal": owner or finance, never the person who asked (rule 10, checked in SQL
 *   against private.payroll_run_touchers). In one transaction the run's bank file is voided, the
 *   run becomes Reversed, its timesheet days, leave and adjustments are payable again, its
 *   statutory remittances are voided and the period reopens. "Decline" is 5.2's Return.
 * - "Correct a released payslip": owner or hr add an earning or deduction to a later draft run
 *   naming the released payslip it corrects.
 * Every write is one SQL function called as the user; every money write has a preview. Lira never
 * reverses, approves or corrects payroll (agent: false). Module: payroll.
 */

const reload = "Reload the page and try again";
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

export const PAYROLL_REVERSERS = PAYROLL_APPROVERS;

export const reverseRunSchema = z.object({
  runId: z.uuid(reload),
  reason: text(500, "Say why the run is reversed"),
  notUploaded: checkbox,
});

export const approveReversalSchema = z.object({
  runId: z.uuid(reload),
  notUploaded: checkbox,
});

const amountMessage = "Enter an amount above ₦0, like 15000 or 15,000.50";
export const correctionSchema = z.object({
  runId: z.uuid(reload),
  payslipId: z.uuid("Choose the payslip it corrects"),
  kind: z.enum(["earning", "deduction"], "Choose an earning or a deduction"),
  label: text(80, "Name the correction"),
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
  reason: text(500, "Give a reason"),
});

/** Rule 10's refusal for a reversal, as the approver reads it. */
export const REVERSAL_TWO_PERSON_MESSAGE =
  "You asked for this reversal, so a different person must approve it. Ask Finance or another owner.";

export const DOWNLOADED_MESSAGE =
  "The bank file was downloaded. Confirm it wasn't uploaded to the bank, or the money may be paid.";

/** Database refusals in plain English. */
export function fromReversalDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "MLRV4") throw new MutationError("invalid", REVERSAL_TWO_PERSON_MESSAGE);
  if (error.code === "MLRV5") {
    throw new MutationError("invalid", DOWNLOADED_MESSAGE, { notUploaded: DOWNLOADED_MESSAGE });
  }
  if (/^MLRV[1236789A]$/.test(error.code)) throw new MutationError("invalid", error.message);
  if (error.code === "42501") {
    throw new MutationError(
      "forbidden",
      "Only Finance or an owner reverses payroll; HR or an owner adds corrections.",
    );
  }
  fromPayrollRunDbError(error);
}

const money = (k: Kobo) => formatNaira(k, { whole: k % 100n === 0n });

function negativeChanges(totals: RunTotals): CapabilityPreview["changes"] {
  const t = negatedTotals(totals);
  return [
    { label: "Workers", after: String(t.workerCount) },
    { label: "Gross pay", after: money(t.grossKobo) },
    { label: "PAYE", after: money(t.payeKobo) },
    { label: "Pension (8% + 10%)", after: money(t.pensionEmployeeKobo + t.pensionEmployerKobo) },
    { label: "NHF", after: money(t.nhfKobo) },
    { label: "NSITF and ITF", after: money(t.nsitfKobo + t.itfKobo) },
    { label: "Net pay", after: money(t.netKobo) },
    { label: "Employer cost", after: money(t.employerCostKobo) },
  ];
}

async function mustLoad(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  runId: string,
): Promise<PayrollRunRow> {
  const run = await loadRun(ctx.supabase, ctx.organisationId, runId);
  if (!run) throw new MutationError("invalid", "That payroll run wasn't found. Reload the page.");
  return run;
}

/** What else reversing touches: the active bank file (downloaded?) and the remittances. */
async function sideEffects(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  runId: string,
): Promise<{ file: boolean; downloaded: boolean; remittances: number; paid: number }> {
  const [batch, downloads, rems] = await Promise.all([
    ctx.supabase
      .from("payout_batches")
      .select("id")
      .eq("organisation_id", ctx.organisationId)
      .eq("run_id", runId)
      .eq("status", "active")
      .maybeSingle(),
    ctx.supabase.rpc("payout_file_downloads", {
      p_organisation_id: ctx.organisationId,
      p_run_id: runId,
    }),
    ctx.supabase
      .from("statutory_remittances")
      .select("id")
      .eq("organisation_id", ctx.organisationId)
      .eq("run_id", runId),
  ]);
  if (batch.error) fromReversalDbError(batch.error);
  if (downloads.error) fromReversalDbError(downloads.error);
  if (rems.error) fromReversalDbError(rems.error);
  const remIds = (rems.data ?? []).map((r) => r.id);
  let paid = 0;
  if (remIds.length > 0) {
    const { data: pays, error } = await ctx.supabase
      .from("statutory_payments")
      .select("id, entry, remittance_id, voids_payment_id")
      .eq("organisation_id", ctx.organisationId)
      .in("remittance_id", remIds);
    if (error) fromReversalDbError(error);
    const voided = new Set(
      (pays ?? []).flatMap((p) => (p.voids_payment_id ? [p.voids_payment_id] : [])),
    );
    paid = new Set(
      (pays ?? [])
        .filter((p) => p.entry === "payment" && !voided.has(p.id))
        .map((p) => p.remittance_id),
    ).size;
  }
  const activeId = batch.data?.id ?? null;
  return {
    file: activeId !== null,
    downloaded: activeId !== null && (downloads.data ?? []).some((d) => d.batch_id === activeId),
    remittances: remIds.length,
    paid,
  };
}

function effectsText(e: Awaited<ReturnType<typeof sideEffects>>): string {
  const parts: string[] = [];
  if (e.file) {
    parts.push(
      e.downloaded
        ? "Its bank file is voided; it was downloaded, so confirm it wasn't uploaded to the bank."
        : "Its bank file is voided.",
    );
  }
  if (e.remittances > 0) {
    parts.push(
      `${e.remittances} statutory ${e.remittances === 1 ? "remittance is" : "remittances are"} voided${e.paid > 0 ? `; ${e.paid} already ${e.paid === 1 ? "has a payment" : "have payments"} recorded, kept as evidence for a refund or an offset` : ""}.`,
    );
  }
  return parts.join(" ");
}

/** "Reverse this run": the negative totals and what reversing does, before anything is saved. */
export async function previewReverse(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof reverseRunSchema>,
): Promise<CapabilityPreview> {
  const run = await mustLoad(ctx, data.runId);
  if (run.status === "released") {
    throw new MutationError(
      "invalid",
      "This run is released: the money has gone. Correct it in a later run instead.",
    );
  }
  if (run.status !== "approved" || run.kind === "reversal") {
    throw new MutationError("invalid", "Only an approved run that isn't released is reversed.");
  }
  const effects = await sideEffects(ctx, run.id);
  if (effects.downloaded && !data.notUploaded) {
    throw new MutationError("invalid", DOWNLOADED_MESSAGE, { notUploaded: DOWNLOADED_MESSAGE });
  }
  const t = run.totals;
  return {
    summary:
      `Asks to reverse ${runMonth(run.periodEnd)} (${formatLeaveRange(run.periodStart, run.periodEnd)}): a reversal of ${t.workerCount} ${t.workerCount === 1 ? "payslip" : "payslips"}, net pay ${money(-t.netKobo)}, waits for a second person in Finance. Once approved the run is Reversed, its timesheet days, leave and adjustments are payable again and the period reopens. ${effectsText(effects)} Reason: "${data.reason}".`.trim(),
    changes: negativeChanges(t),
  };
}

async function reversalInReview(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  runId: string,
): Promise<{ reversal: PayrollRunRow; original: PayrollRunRow }> {
  const reversal = await mustLoad(ctx, runId);
  if (reversal.kind !== "reversal" || !reversal.reversesRunId) {
    throw new MutationError("invalid", "That run isn't a reversal. Reload the page.");
  }
  if (reversal.status !== "review") {
    throw new MutationError(
      "invalid",
      "This reversal isn't waiting for approval. Reload the page.",
    );
  }
  const original = await mustLoad(ctx, reversal.reversesRunId);
  return { reversal, original };
}

/** "Approve the reversal": refused up front to whoever asked for it; the negative totals. */
export async function previewApproveReversal(
  ctx: Pick<MutationContext, "supabase" | "organisationId" | "userId">,
  data: z.output<typeof approveReversalSchema>,
): Promise<CapabilityPreview> {
  const { reversal, original } = await reversalInReview(ctx, data.runId);
  if ([reversal.preparedBy, reversal.submittedBy, reversal.calculatedBy].includes(ctx.userId)) {
    throw new MutationError("invalid", REVERSAL_TWO_PERSON_MESSAGE);
  }
  if (original.status === "released") {
    throw new MutationError(
      "invalid",
      "The run was released: the money has gone. Decline this reversal and correct it in a later run.",
    );
  }
  const effects = await sideEffects(ctx, original.id);
  if (effects.downloaded && !data.notUploaded) {
    throw new MutationError("invalid", DOWNLOADED_MESSAGE, { notUploaded: DOWNLOADED_MESSAGE });
  }
  const t = reversal.totals;
  return {
    summary:
      `Approves the reversal of ${runMonth(original.periodEnd)}: ${t.workerCount} ${t.workerCount === 1 ? "payslip" : "payslips"}, net pay ${money(-t.netKobo)}. ${runMonth(original.periodEnd)} becomes Reversed, its timesheet days, leave and adjustments are payable again and ${formatLeaveRange(original.periodStart, original.periodEnd)} reopens for a new run. ${effectsText(effects)}`.trim(),
    changes: negativeChanges(t),
  };
}

/** "Correct a released payslip": this worker's net pay in the draft before and after. */
export async function previewCorrection(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof correctionSchema>,
): Promise<CapabilityPreview> {
  const run = await draftRun(ctx.supabase, ctx.organisationId, data.runId);
  const { data: slip, error } = await ctx.supabase
    .from("payslips")
    .select("id, worker_id, run_id")
    .eq("organisation_id", ctx.organisationId)
    .eq("id", data.payslipId)
    .maybeSingle();
  if (error) fromReversalDbError(error);
  if (!slip) throw new MutationError("invalid", "That payslip wasn't found. Reload the page.");
  const corrected = await mustLoad(ctx, slip.run_id);
  if (corrected.status !== "released" || corrected.kind === "reversal") {
    throw new MutationError("invalid", "A correction names a released payslip.");
  }
  const options = { workerIds: [slip.worker_id], itfApplies: run.itfApplies };
  const extra = {
    id: "00000000-0000-4000-8000-000000000000",
    workerId: slip.worker_id,
    kind: data.kind,
    label: data.label,
    amountKobo: data.amount,
    pensionable: data.kind === "earning" && data.pensionable,
    taxable: data.kind === "earning",
    instalmentNumber: 1,
    instalmentCount: 1,
  } as const;
  const [before, after] = await Promise.all([
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), options),
    calculateRun(ctx.supabase, ctx.organisationId, targetOf(run), {
      ...options,
      extraAdjustments: [extra],
    }),
  ]);
  const net = (calc: typeof before) =>
    calc.workers.find((w) => w.workerId === slip.worker_id)?.payslip.netKobo ?? null;
  const b = net(before);
  const a = net(after);
  const what = data.kind === "earning" ? "an earning" : "a deduction";
  return {
    summary: `Adds ${what} of ${money(data.amount)} (${data.label}) correcting the ${runMonth(corrected.periodEnd)} payslip: this worker's net pay ${b === null ? "can't be worked out yet" : money(b)} becomes ${a === null ? "something that can't be worked out" : money(a)}. The posted payslip stays as it is; the run is recalculated.`,
    changes: [
      {
        label: "Net pay",
        ...(b !== null ? { before: money(b) } : {}),
        after: a === null ? "Can't be worked out" : money(a),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const reverseRunSpec: MutationSpec<
  typeof reverseRunSchema,
  { runId: string; reversalRunId: string }
> = {
  module: "payroll",
  schema: reverseRunSchema,
  roles: PAYROLL_REVERSERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: reversalRunId, error } = await supabase.rpc("reverse_payroll_run", {
      p_organisation_id: organisationId,
      p_run_id: data.runId,
      p_reason: data.reason,
      p_not_uploaded: data.notUploaded,
    });
    if (error) fromReversalDbError(error);
    return { runId: data.runId, reversalRunId: reversalRunId! };
  },
};

export const approveReversalSpec: MutationSpec<
  typeof approveReversalSchema,
  { runId: string; originalRunId: string; decisionId: string }
> = {
  module: "payroll",
  schema: approveReversalSchema,
  roles: PAYROLL_REVERSERS,
  run: async (ctx) => {
    const { reversal, original } = await reversalInReview(ctx, ctx.data.runId);
    const { data: decisionId, error } = await ctx.supabase.rpc("approve_payroll_reversal", {
      p_organisation_id: ctx.organisationId,
      p_run_id: reversal.id,
      p_not_uploaded: ctx.data.notUploaded,
    });
    if (error) fromReversalDbError(error);
    return { runId: reversal.id, originalRunId: original.id, decisionId: decisionId! };
  },
};

export const addCorrectionSpec: MutationSpec<typeof correctionSchema, { runId: string }> = {
  module: "payroll",
  schema: correctionSchema,
  roles: PAYROLL_PREPARERS,
  run: async (ctx) => {
    const d = ctx.data;
    const { error } = await ctx.supabase.rpc("add_payroll_correction", {
      p_organisation_id: ctx.organisationId,
      p_run_id: d.runId,
      p_payslip_id: d.payslipId,
      p_kind: d.kind,
      p_label: d.label,
      // Whole kobo as text: no number ever holds kobo.
      p_amount_kobo: d.amount.toString(),
      p_pensionable: d.kind === "earning" && d.pensionable,
      p_reason: d.reason,
    });
    if (error) fromReversalDbError(error);
    const run = await draftRun(ctx.supabase, ctx.organisationId, d.runId);
    await recalculateAndSave(ctx, run);
    return { runId: d.runId };
  },
};
