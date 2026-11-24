import "server-only";

import { formatDate } from "@/lib/dates";
import { TAX_ADVISER_LINE } from "@/lib/payroll/rule-set";
import type { ruleSetVersionSchema } from "@/lib/payroll/rule-set-form";
import { fromPayrollRulesDbError } from "@/server/payroll/rule-sets";
import { previewRuleSetVersion, type RuleSetVersionPreview } from "@/server/payroll/rule-sets-data";
import { previewMakeBankFile, type makeBankFileSchema } from "@/server/payroll/payouts";
import { previewRelease, type releaseRunSchema } from "@/server/payroll/release";
import {
  previewAcknowledge,
  previewAddAdjustment,
  previewApprove,
  previewCarryInstalment,
  previewCreateRun,
  previewRecalculate,
  previewRemoveAdjustment,
  previewReturn,
  previewSubmit,
  type acknowledgeSchema,
  type adjustmentSchema,
  type carryInstalmentSchema,
  type createRunSchema,
  type removeAdjustmentSchema,
  type returnRunSchema,
  type runIdSchema,
} from "@/server/payroll/runs";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * Previews for payroll's money writes (slice 5.0 onwards). Each runs the SQL function's own dry
 * run, so the confirm step shows exactly what the change does. No personal data is involved.
 */

const figures = (n: number) => `${n} ${n === 1 ? "figure" : "figures"}`;

export function describeRuleSetVersion(result: RuleSetVersionPreview): CapabilityPreview {
  const from = formatDate(result.effectiveFrom);
  if (result.unchanged) {
    return {
      summary: `Nothing changes: these figures equal ${result.beforeName}.`,
      changes: [],
    };
  }
  let summary = `${result.name} changes ${figures(result.changes.length)} from ${from}`;
  summary += result.beforeName ? `, after ${result.beforeName}.` : ".";
  if (result.replaces.length > 0) {
    summary += ` It replaces ${result.replaces.map((r) => `${r.name} (from ${formatDate(r.effectiveFrom)})`).join(", ")}.`;
  }
  summary += ` A run uses the version in force on its pay date, so runs paid before ${from} keep the rules in force then. ${TAX_ADVISER_LINE}`;
  return {
    summary,
    changes: result.changes.map((c) => ({
      label: c.label,
      ...(c.before !== null ? { before: c.before } : {}),
      after: c.after ?? "Removed",
    })),
  };
}

export const previewAddRuleSetVersion: PreviewFn<typeof ruleSetVersionSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const { data: result, error } = await previewRuleSetVersion(supabase, organisationId, data);
  if (error) fromPayrollRulesDbError(error);
  return describeRuleSetVersion(result!);
};

// ---------------------------------------------------------------------------
// The payroll run (slice 5.2): each preview works the change out without writing.
// ---------------------------------------------------------------------------

export const previewCreatePayrollRun: PreviewFn<typeof createRunSchema> = (ctx) =>
  previewCreateRun(ctx, ctx.data);
export const previewRecalculatePayrollRun: PreviewFn<typeof runIdSchema> = (ctx) =>
  previewRecalculate(ctx, ctx.data);
export const previewAddPayrollAdjustment: PreviewFn<typeof adjustmentSchema> = (ctx) =>
  previewAddAdjustment(ctx, ctx.data);
export const previewCarryPayrollInstalment: PreviewFn<typeof carryInstalmentSchema> = (ctx) =>
  previewCarryInstalment(ctx, ctx.data);
export const previewRemovePayrollAdjustment: PreviewFn<typeof removeAdjustmentSchema> = (ctx) =>
  previewRemoveAdjustment(ctx, ctx.data);
export const previewAcknowledgePayrollAnomalies: PreviewFn<typeof acknowledgeSchema> = (ctx) =>
  previewAcknowledge(ctx, ctx.data);
export const previewSubmitPayrollRun: PreviewFn<typeof runIdSchema> = (ctx) =>
  previewSubmit(ctx, ctx.data);
export const previewReturnPayrollRun: PreviewFn<typeof returnRunSchema> = (ctx) =>
  previewReturn(ctx, ctx.data);
export const previewApprovePayrollRun: PreviewFn<typeof runIdSchema> = (ctx) =>
  previewApprove(ctx, ctx.data);

// ---------------------------------------------------------------------------
// The bank file and release (slice 5.4)
// ---------------------------------------------------------------------------

export const previewMakePayrollBankFile: PreviewFn<typeof makeBankFileSchema> = (ctx) =>
  previewMakeBankFile(ctx, ctx.data);
export const previewReleasePayrollRun: PreviewFn<typeof releaseRunSchema> = (ctx) =>
  previewRelease(ctx, ctx.data);
