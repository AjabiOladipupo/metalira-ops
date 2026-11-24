import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { addDays, formatDate } from "@/lib/dates";
import { formatNaira } from "@/lib/money";
import { TAX_ADVISER_LINE, type RuleSet } from "@/lib/payroll/rule-set";
import { ruleSetFormValues } from "@/lib/payroll/rule-set-form";
import { canEditPayrollRules } from "@/server/payroll/rule-sets";
import { loadPayrollRules } from "@/server/payroll/rule-sets-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../../_shell/slots";
import { AddVersionForm, type BandField } from "../_components/payroll-rules-forms";

export const metadata: Metadata = { title: "Add a version of the payroll rules" };

/** "NTA 2025 v1" → "NTA 2025 v2"; any other name gets " v2". */
function nextName(name: string): string {
  const match = /^(.*\bv)(\d+)$/.exec(name);
  if (match) return `${match[1]}${Number(match[2]) + 1}`;
  return `${name.slice(0, 56)} v2`;
}

/** The band rows of the form: "First band", "Next band (from ₦800,000)", "Above ₦50,000,000". */
function bandFields(set: RuleSet): BandField[] {
  const out: BandField[] = [];
  let lower = 0n;
  set.rules.payeBands.forEach((b, i) => {
    const open = b.widthKobo === null;
    const label = open
      ? `Above ${formatNaira(lower, { whole: true })}`
      : i === 0
        ? "First band"
        : `Next band (from ${formatNaira(lower, { whole: true })})`;
    if (b.widthKobo !== null) lower += b.widthKobo;
    out.push({ index: i, label, open });
  });
  return out;
}

async function AddVersion() {
  const ctx = await peoplePageContext();
  if (!canEditPayrollRules(ctx.role)) redirect("/app/settings/payroll");
  const rules = await loadPayrollRules(ctx.supabase, ctx.organisationId);
  const base = rules.latest;
  const tomorrow = addDays(rules.today, 1);
  const saved = {
    ...ruleSetFormValues(base.ruleSet),
    name: nextName(base.name),
    effectiveFrom: base.effectiveFrom >= tomorrow ? addDays(base.effectiveFrom, 1) : tomorrow,
    reason: "",
    sourceLabel: "",
  };
  const bands = bandFields(base.ruleSet);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        back={{ href: "/app/settings/payroll", label: "Payroll rules" }}
        eyebrow="Payroll rules"
        title="Add a version"
        description={`Starts from ${base.name} (${formatDate(base.effectiveFrom)}). Change the figures that change, then preview before saving.`}
      />
      <AddVersionForm
        saved={saved}
        bands={bands}
        minDate={tomorrow}
        adviserLine={TAX_ADVISER_LINE}
      />
    </div>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/settings/payroll/new">
      <AddVersion />
    </RouteGate>
  );
}
