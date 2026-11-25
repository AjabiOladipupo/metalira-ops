import { NTA_2025_V1, ruleSetPolicyJson, ruleSetRulesJson } from "@/lib/payroll/rule-set";

import type { Client } from "./supabase";

/**
 * Slice 5.9a: gives a company NTA 2025 v1 as its rule set (from 1 Jan 2026) instead of the
 * starting version, NTA 2025 v2 (the tax adviser's). For suites written against v1's figures
 * that test something else (arrears, refunds, carried deductions): a dated rule set a company may
 * hold, so they keep testing what they test. The secret key may insert a company's first version.
 */
export async function giveRuleSetV1(admin: Client, orgId: string): Promise<void> {
  const { error } = await admin.from("tax_rule_sets").insert({
    organisation_id: orgId,
    name: NTA_2025_V1.name,
    effective_from: "2026-01-01",
    rules: ruleSetRulesJson(NTA_2025_V1.rules),
    policy: ruleSetPolicyJson(NTA_2025_V1.policy),
    reason: "Written against NTA 2025 v1",
  });
  if (error) throw new Error(`giveRuleSetV1: ${error.message}`);
}
