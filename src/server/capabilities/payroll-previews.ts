import "server-only";

import { formatDate } from "@/lib/dates";
import { TAX_ADVISER_LINE } from "@/lib/payroll/rule-set";
import type { ruleSetVersionSchema } from "@/lib/payroll/rule-set-form";
import { fromPayrollRulesDbError } from "@/server/payroll/rule-sets";
import { previewRuleSetVersion, type RuleSetVersionPreview } from "@/server/payroll/rule-sets-data";

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
