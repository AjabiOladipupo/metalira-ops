import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { ruleSetVersionSchema } from "@/lib/payroll/rule-set-form";
import type { ManagerRole } from "@/lib/roles";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";
import type { Json } from "@/types/db";

import {
  previewRuleSetVersion,
  toRuleSetVersionPreview,
  type RuleSetVersionPreview,
} from "./rule-sets-data";

/**
 * Tax rule sets (slice 5.0; docs/PHASE_5.md "Roles and access"): owner, hr and finance read;
 * owner and hr add a dated version with a reason (never a past one); only an owner records the
 * tax adviser's confirmation. Admins and ops managers see no payroll. Every write is one SQL
 * function called as the user, which checks the role again, audited by the row trigger and a
 * named event. Registered in src/server/capabilities/registry.ts. Module: payroll.
 */

export const PAYROLL_RULES_READERS = [
  "owner",
  "hr",
  "finance",
] as const satisfies readonly ManagerRole[];
export const PAYROLL_RULES_WRITERS = ["owner", "hr"] as const satisfies readonly ManagerRole[];
export const PAYROLL_RULES_CONFIRMERS = ["owner"] as const satisfies readonly ManagerRole[];

export function canEditPayrollRules(role: ManagerRole): boolean {
  return (PAYROLL_RULES_WRITERS as readonly ManagerRole[]).includes(role);
}

export function canConfirmPayrollRules(role: ManagerRole): boolean {
  return (PAYROLL_RULES_CONFIRMERS as readonly ManagerRole[]).includes(role);
}

/** Database refusals in plain English. */
export function fromPayrollRulesDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Only an owner or HR can change the payroll rules.");
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  }
  if (error.code === "MLPR7") {
    throw new MutationError("invalid", error.message, { effectiveFrom: error.message });
  }
  if (error.code === "23514") {
    throw new MutationError(
      "invalid",
      "The figures aren't complete or aren't in range. Check them and try again.",
    );
  }
  if (/^MLPR[89]$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  if (error.code === "23P01") {
    throw new MutationError(
      "invalid",
      "Someone changed the payroll rules at the same time. Reload and try again.",
    );
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

/** The preview of "Add a version" (the dry run), for the confirm step. */
export const previewRuleSetVersionSpec: MutationSpec<
  typeof ruleSetVersionSchema,
  RuleSetVersionPreview
> = {
  module: "payroll",
  schema: ruleSetVersionSchema,
  roles: PAYROLL_RULES_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: preview, error } = await previewRuleSetVersion(supabase, organisationId, data);
    if (error) fromPayrollRulesDbError(error);
    return preview!;
  },
};

/** Adds a dated version of the payroll rules from tomorrow or later. */
export const addRuleSetVersionSpec: MutationSpec<
  typeof ruleSetVersionSchema,
  RuleSetVersionPreview
> = {
  module: "payroll",
  schema: ruleSetVersionSchema,
  roles: PAYROLL_RULES_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("add_tax_rule_set_version", {
      p_organisation_id: organisationId,
      p_name: data.name,
      p_rules: data.rules as unknown as Json,
      p_policy: data.policy as unknown as Json,
      p_effective_from: data.effectiveFrom,
      p_reason: data.reason,
      p_source_label: data.sourceLabel ?? undefined,
      p_dry_run: false,
    });
    if (error) fromPayrollRulesDbError(error);
    return toRuleSetVersionPreview(result);
  },
};

const noteMessage =
  "Say who confirmed the figures and when, in up to 500 characters, with no web addresses";

export const confirmRuleSetSchema = z.object({
  /** Empty for the starting values not yet saved: they are saved first, then confirmed. */
  ruleSetId: z
    .union([z.uuid("Reload the page and try again"), z.literal("")])
    .optional()
    .transform((v) => (v ? v : null)),
  note: z
    .string(noteMessage)
    .trim()
    .min(1, noteMessage)
    .max(500, noteMessage)
    .refine((v) => !/[\u0001-\u001f\u007f-\u009f<>]/.test(v), noteMessage)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), noteMessage),
});

/**
 * Records the tax adviser's confirmation of a version, once (owner only). The starting values are
 * saved as the company's first version first when they haven't been yet.
 */
export const confirmRuleSetSpec: MutationSpec<typeof confirmRuleSetSchema, void> = {
  module: "payroll",
  schema: confirmRuleSetSchema,
  roles: PAYROLL_RULES_CONFIRMERS,
  run: async ({ supabase, organisationId, data }) => {
    let ruleSetId = data.ruleSetId;
    if (!ruleSetId) {
      const ensured = await supabase.rpc("ensure_tax_rule_set", {
        p_organisation_id: organisationId,
      });
      if (ensured.error) fromPayrollRulesDbError(ensured.error);
      if (!ensured.data)
        throw new MutationError("invalid", "No version is in force yet. Reload the page.");
      ruleSetId = ensured.data;
    }
    const { error } = await supabase.rpc("confirm_tax_rule_set", {
      p_organisation_id: organisationId,
      p_rule_set_id: ruleSetId,
      p_note: data.note,
    });
    if (error) {
      if (error.code === "42501") {
        throw new MutationError(
          "forbidden",
          "Only an owner can record the tax adviser's confirmation.",
        );
      }
      fromPayrollRulesDbError(error);
    }
  },
};
