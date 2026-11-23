import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { LAGOS_TIME_ZONE, todayIn } from "@/lib/dates";
import {
  NTA_2025_V1,
  NTA_2025_V1_EFFECTIVE_FROM,
  NTA_2025_V1_SOURCE,
  diffRuleSets,
  parseRuleSet,
  type FigureChange,
  type RuleSet,
} from "@/lib/payroll/rule-set";
import type { RuleSetVersionInput } from "@/lib/payroll/rule-set-form";
import type { Database, Json } from "@/types/db";

/**
 * Reads for Settings > Payroll rules (slice 5.0), under RLS as the signed-in member (owner, hr
 * and finance read; everyone else gets no rows), and the dry run behind "Add a version". The
 * dry run calls the same SQL function as the write with `p_dry_run`, so the preview and the
 * change can't disagree.
 */

type Client = SupabaseClient<Database>;

export interface RuleSetVersion {
  /** Null for the starting values a company has before its first version is saved. */
  id: string | null;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  ruleSet: RuleSet;
  sourceLabel: string | null;
  reason: string | null;
  adviserConfirmedAt: string | null;
  adviserNote: string | null;
  createdAt: string | null;
}

export interface PayrollRules {
  today: string;
  /** False until the company's first version is saved (the starting values are shown). */
  stored: boolean;
  /** The version in force today. */
  inForce: RuleSetVersion;
  /** Versions starting after today, soonest first. */
  scheduled: RuleSetVersion[];
  /** Versions that ended, latest first. */
  earlier: RuleSetVersion[];
  /** The newest version (scheduled or in force): what a new version starts from. */
  latest: RuleSetVersion;
}

const TEMPLATE: RuleSetVersion = {
  id: null,
  name: NTA_2025_V1.name,
  effectiveFrom: NTA_2025_V1_EFFECTIVE_FROM,
  effectiveTo: null,
  ruleSet: NTA_2025_V1,
  sourceLabel: NTA_2025_V1_SOURCE,
  reason: null,
  adviserConfirmedAt: null,
  adviserNote: null,
  createdAt: null,
};

async function companyToday(supabase: Client, organisationId: string): Promise<string> {
  const { data, error } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the company (${error.code})`);
  return todayIn(data?.timezone ?? LAGOS_TIME_ZONE);
}

/** The company's payroll rules: the version in force, scheduled ones and earlier ones. */
export async function loadPayrollRules(
  supabase: Client,
  organisationId: string,
): Promise<PayrollRules> {
  const [today, rows] = await Promise.all([
    companyToday(supabase, organisationId),
    supabase
      .from("tax_rule_sets")
      .select(
        "id, name, effective_from, effective_to, rules, policy, source_label, reason, adviser_confirmed_at, adviser_note, created_at",
      )
      .eq("organisation_id", organisationId)
      .order("effective_from", { ascending: true }),
  ]);
  if (rows.error) throw new Error(`Could not load the payroll rules (${rows.error.code})`);

  const versions: RuleSetVersion[] = rows.data.map((r) => ({
    id: r.id,
    name: r.name,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    ruleSet: parseRuleSet(r.name, r.rules, r.policy),
    sourceLabel: r.source_label,
    reason: r.reason,
    adviserConfirmedAt: r.adviser_confirmed_at,
    adviserNote: r.adviser_note,
    createdAt: r.created_at,
  }));
  if (versions.length === 0) {
    return {
      today,
      stored: false,
      inForce: TEMPLATE,
      scheduled: [],
      earlier: [],
      latest: TEMPLATE,
    };
  }
  const inForce =
    versions.find(
      (v) => v.effectiveFrom <= today && (v.effectiveTo === null || v.effectiveTo >= today),
    ) ??
    // Every company's first version starts 1 Jan 2026, so this only happens before then.
    versions[0]!;
  return {
    today,
    stored: true,
    inForce,
    scheduled: versions.filter((v) => v.effectiveFrom > today),
    earlier: versions.filter((v) => v.effectiveTo !== null && v.effectiveTo < today).reverse(),
    latest: versions.at(-1)!,
  };
}

export interface RuleSetVersionPreview {
  name: string;
  effectiveFrom: string;
  unchanged: boolean;
  /** The version the new one follows. */
  beforeName: string;
  changes: FigureChange[];
  /** Scheduled versions the new one replaces. */
  replaces: { name: string; effectiveFrom: string }[];
}

interface DryRunResult {
  name: string;
  effective_from: string;
  unchanged: boolean;
  before: { name: string; rules: Json; policy: Json } | null;
  after: { rules: Json; policy: Json };
  replaces: { name: string; effective_from: string }[];
}

/** Turns add_tax_rule_set_version's result into the preview (figures that change). */
export function toRuleSetVersionPreview(raw: unknown): RuleSetVersionPreview {
  const r = raw as DryRunResult;
  const after = parseRuleSet(r.name, r.after.rules, r.after.policy);
  const before = r.before ? parseRuleSet(r.before.name, r.before.rules, r.before.policy) : null;
  return {
    name: r.name,
    effectiveFrom: r.effective_from,
    unchanged: r.unchanged,
    beforeName: before?.name ?? "",
    changes: before ? diffRuleSets(before, after) : [],
    replaces: r.replaces.map((x) => ({ name: x.name, effectiveFrom: x.effective_from })),
  };
}

/** The dry run of a new version: what will change, writing nothing. */
export async function previewRuleSetVersion(
  supabase: Client,
  organisationId: string,
  data: RuleSetVersionInput,
): Promise<{ data: RuleSetVersionPreview | null; error: PostgrestError | null }> {
  const { data: result, error } = await supabase.rpc("add_tax_rule_set_version", {
    p_organisation_id: organisationId,
    p_name: data.name,
    p_rules: data.rules as unknown as Json,
    p_policy: data.policy as unknown as Json,
    p_effective_from: data.effectiveFrom,
    p_reason: data.reason,
    p_source_label: data.sourceLabel ?? undefined,
    p_dry_run: true,
  });
  if (error) return { data: null, error };
  return { data: toRuleSetVersionPreview(result), error: null };
}

/** For the registry's summary read: counts and figures, no names of people. */
export async function loadPayrollRulesSummary(supabase: Client, organisationId: string) {
  const rules = await loadPayrollRules(supabase, organisationId);
  return {
    inForce: {
      name: rules.inForce.name,
      effectiveFrom: rules.inForce.effectiveFrom,
      adviserConfirmed: rules.inForce.adviserConfirmedAt !== null,
      saved: rules.stored,
    },
    scheduled: rules.scheduled.map((v) => ({ name: v.name, effectiveFrom: v.effectiveFrom })),
    earlierCount: rules.earlier.length,
  };
}
