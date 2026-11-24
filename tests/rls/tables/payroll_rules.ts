/**
 * Isolation registry for slice 5.0 (tax rule sets). Rows are seeded with the secret key, which
 * may insert a company's first version; signed-in roles have no write grants (the SQL functions
 * write), and the guard refuses changes to a version in force.
 */
import { NTA_2025_V1, ruleSetPolicyJson, ruleSetRulesJson } from "@/lib/payroll/rule-set";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "tax_rule_sets",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const { error } = await admin.from("tax_rule_sets").insert({
        organisation_id: side.orgId,
        name: NTA_2025_V1.name,
        effective_from: "2026-01-01",
        rules: ruleSetRulesJson(NTA_2025_V1.rules),
        policy: ruleSetPolicyJson(NTA_2025_V1.policy),
        reason: "Isolation seed",
      });
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("tax_rule_sets")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("effective_from")
        .limit(1)
        .single();
      if (error) throw new Error(error.message);
      return data.id;
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      name: "Attack",
      effective_from: "2099-01-01",
      rules: ruleSetRulesJson(NTA_2025_V1.rules),
      policy: ruleSetPolicyJson(NTA_2025_V1.policy),
      reason: "Attack",
    }),
    patch: { name: "Changed" },
  },
];
