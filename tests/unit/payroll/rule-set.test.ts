/**
 * Slice 5.0: the starting rule set NTA_2025_V1 equals docs/RULES_NIGERIA.md figure by figure
 * (the doc is read here, as tests/unit/leave/presets.test.ts reads its tables), the jsonb shape
 * round-trips and refuses bad documents, and the figures read as Settings shows them. The
 * database's private.tax_rule_set_template() is compared with the same object in
 * tests/rls/tax-rule-sets.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseNairaToKobo } from "@/lib/money";
import {
  diffRuleSets,
  formatBps,
  formatMultiplier,
  NTA_2025_V1,
  NTA_2025_V1_EFFECTIVE_FROM,
  parseRuleSet,
  payPolicyJsonSchema,
  ruleSetFigures,
  ruleSetPolicyJson,
  ruleSetRulesJson,
  TAX_ADVISER_LINE,
  taxRulesJsonSchema,
  type RuleSet,
} from "@/lib/payroll/rule-set";

const doc = readFileSync(path.join(process.cwd(), "docs", "RULES_NIGERIA.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);

function section(heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

const pct = (text: string) => Math.round(Number(text.replace("%", "")) * 100);

describe("NTA 2025 v1 equals docs/RULES_NIGERIA.md", () => {
  const rules = NTA_2025_V1.rules;

  it("PAYE bands", () => {
    const paye = section("## PAYE (Nigeria Tax Act 2025, from 1 Jan 2026)");
    expect(NTA_2025_V1_EFFECTIVE_FROM).toBe("2026-01-01");
    const rows = paye
      .split("\n")
      .filter((l) => /^\| (First|Next|Above) /.test(l))
      .map((l) =>
        l
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    expect(rows).toHaveLength(6);
    rows.forEach(([band, rate], i) => {
      const amount = parseNairaToKobo(band!.replace(/^(First|Next|Above) /, ""));
      const b = rules.payeBands[i]!;
      expect(b.rateBps, band).toBe(pct(rate!));
      if (band!.startsWith("Above")) {
        expect(b.widthKobo).toBeNull();
        const below = rules.payeBands.slice(0, i).reduce((s, x) => s + (x.widthKobo ?? 0n), 0n);
        expect(below).toBe(amount);
      } else {
        expect(b.widthKobo).toBe(amount);
      }
    });
  });

  it("rent relief, pension, NHF, NSITF and ITF", () => {
    expect(section("## PAYE")).toContain(
      "Rent relief = 20% of annual rent declared, capped at ₦500,000.",
    );
    expect(rules.rentRelief).toEqual({ rateBps: 2000, capKobo: parseNairaToKobo("500,000") });
    expect(section("## Pension (PRA 2014)")).toContain(
      "Employee 8%, employer 10% of basic + housing + transport.",
    );
    expect(rules.pension).toEqual({
      employeeBps: 800,
      employerBps: 1000,
      base: ["basic", "housing", "transport"],
    });
    expect(section("## NHF")).toContain("2.5% of basic, only where `nhf_opt_in` is true");
    expect(rules.nhf).toEqual({ rateBps: 250, base: ["basic"] });
    const levies = section("## Employer levies");
    expect(levies).toContain("NSITF: 1% of total monthly payroll.");
    expect(rules.nsitf).toEqual({ rateBps: 100 });
    expect(levies).toContain("ITF: 1% of annual payroll, for employers with 5+ staff");
    expect(rules.itf).toEqual({ rateBps: 100, minStaff: 5 });
  });

  it("pay policy and daily workers", () => {
    const policy = section("## Pay policy (set by the owner, 15 Nov 2026)");
    expect(policy).toContain("paid at the worker's normal hourly rate (multiplier 1.0×)");
    expect(NTA_2025_V1.policy.overtimeMultiplierBps).toBe(10_000);
    expect(policy).toContain("paid one overtime shift of 8 hours at the overtime rate");
    expect(NTA_2025_V1.policy.offDayPaidMinutes).toBe(480);
    expect(policy).toContain(
      "No PAYE, no pension, no NSITF, no ITF, and they are left out of the employer levy base",
    );
    expect(rules.dailyWorkersExempt).toBe(true);
  });

  it("marks every figure for the tax adviser", () => {
    expect(TAX_ADVISER_LINE).toBe("Confirm with a tax adviser before the first live payroll.");
    for (const heading of ["## PAYE", "## Pension", "## NHF", "## Employer levies"]) {
      expect(section(heading)).toMatch(/\*\*Confirm/);
    }
  });
});

describe("the jsonb shape", () => {
  it("round-trips through parseRuleSet", () => {
    const rules = ruleSetRulesJson(NTA_2025_V1.rules);
    const policy = ruleSetPolicyJson(NTA_2025_V1.policy);
    expect(rules.paye_bands[0]).toEqual({ width_kobo: "80000000", rate_bps: 0 });
    expect(rules.paye_bands[5]).toEqual({ width_kobo: null, rate_bps: 2500 });
    expect(parseRuleSet("NTA 2025 v1", JSON.parse(JSON.stringify(rules)), policy)).toEqual(
      NTA_2025_V1,
    );
  });

  it("refuses bad documents", () => {
    const good = ruleSetRulesJson(NTA_2025_V1.rules);
    const bad = (patch: (r: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      patch(copy);
      return taxRulesJsonSchema.safeParse(copy).success;
    };
    expect(bad(() => undefined)).toBe(true);
    expect(bad((r) => ((r.paye_bands as { width_kobo: unknown }[])[5]!.width_kobo = "1"))).toBe(
      false,
    );
    expect(bad((r) => ((r.paye_bands as { width_kobo: unknown }[])[2]!.width_kobo = null))).toBe(
      false,
    );
    expect(bad((r) => ((r.paye_bands as { width_kobo: unknown }[])[1]!.width_kobo = "0"))).toBe(
      false,
    );
    expect(
      bad((r) => ((r.paye_bands as { width_kobo: unknown }[])[1]!.width_kobo = 220000000)),
    ).toBe(false);
    expect(bad((r) => ((r.paye_bands as { rate_bps: unknown }[])[1]!.rate_bps = 10_001))).toBe(
      false,
    );
    expect(bad((r) => ((r.paye_bands as { rate_bps: unknown }[])[1]!.rate_bps = 15.5))).toBe(false);
    expect(
      bad((r) => (r.pension = { employee_bps: 800, employer_bps: 1000, base: ["basic", "basic"] })),
    ).toBe(false);
    expect(bad((r) => (r.extra = 1))).toBe(false);
    expect(bad((r) => delete r.itf)).toBe(false);
    expect(
      payPolicyJsonSchema.safeParse({
        ...ruleSetPolicyJson(NTA_2025_V1.policy),
        overtime_multiplier_bps: 9_000,
      }).success,
    ).toBe(false);
  });
});

describe("figures as Settings shows them", () => {
  it("reads every figure", () => {
    expect(ruleSetFigures(NTA_2025_V1).map((f) => [f.label, f.value])).toEqual([
      ["PAYE on the first ₦800,000", "0%"],
      ["PAYE on the next ₦2,200,000", "15%"],
      ["PAYE on the next ₦9,000,000", "18%"],
      ["PAYE on the next ₦13,000,000", "21%"],
      ["PAYE on the next ₦25,000,000", "23%"],
      ["PAYE above ₦50,000,000", "25%"],
      ["Rent relief", "20% of declared annual rent, capped at ₦500,000"],
      ["Employee pension", "8% of basic + housing + transport"],
      ["Employer pension", "10% of basic + housing + transport"],
      ["NHF", "2.5% of basic, only for workers who opted in"],
      ["NSITF", "1% of monthly payroll"],
      ["ITF", "1% of payroll, accrued monthly, for 5 or more staff"],
      ["Daily workers", "No PAYE, pension, NHF, NSITF or ITF; left out of the levy base"],
      ["Overtime rate", "1.0× the normal hourly rate"],
      ["Off-day work", "8 h at the overtime rate"],
      ["Public-holiday work", "Every minute worked, at the overtime rate, on top of normal pay"],
    ]);
  });

  it("formats rates exactly", () => {
    expect([formatBps(0), formatBps(250), formatBps(1500), formatBps(75), formatBps(1234)]).toEqual(
      ["0%", "2.5%", "15%", "0.75%", "12.34%"],
    );
    expect([formatMultiplier(10_000), formatMultiplier(15_000), formatMultiplier(12_500)]).toEqual([
      "1.0×",
      "1.5×",
      "1.25×",
    ]);
  });

  it("lists only the figures that change", () => {
    const next: RuleSet = structuredClone(NTA_2025_V1);
    next.rules.payeBands[1]!.rateBps = 1600;
    next.rules.nsitf.rateBps = 150;
    expect(diffRuleSets(NTA_2025_V1, next)).toEqual([
      { label: "PAYE on the next ₦2,200,000", before: "15%", after: "16%" },
      { label: "NSITF", before: "1% of monthly payroll", after: "1.5% of monthly payroll" },
    ]);
    expect(diffRuleSets(NTA_2025_V1, structuredClone(NTA_2025_V1))).toEqual([]);
  });
});
