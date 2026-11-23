/**
 * Settings > Payroll rules > Add a version (slice 5.0): the form's fields become the same jsonb
 * the database stores, rates and amounts parse exactly, and bad input is refused per field.
 */
import { describe, expect, it } from "vitest";

import {
  bpsToPercentText,
  parseMultiplierToBps,
  parsePercentToBps,
  ruleSetFormValues,
  ruleSetVersionSchema,
} from "@/lib/payroll/rule-set-form";
import { NTA_2025_V1, ruleSetPolicyJson, ruleSetRulesJson } from "@/lib/payroll/rule-set";

const base: Record<string, string> = {
  ...ruleSetFormValues(NTA_2025_V1),
  name: "NTA 2025 v2",
  effectiveFrom: "2027-01-01",
  reason: "Tax adviser's advice of 3 Dec 2026",
  sourceLabel: "",
};

describe("rates and amounts", () => {
  it("parses percentages to whole basis points", () => {
    expect(["0", "2.5", "15", "0.75", "100", "12.34%"].map(parsePercentToBps)).toEqual([
      0, 250, 1500, 75, 10_000, 1234,
    ]);
    expect(["", "100.01", "1.234", "-1", "abc", "1e2"].map(parsePercentToBps)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect([0, 250, 1500, 75].map(bpsToPercentText)).toEqual(["0", "2.5", "15", "0.75"]);
  });

  it("parses the overtime multiplier", () => {
    expect(["1", "1.5", "1.25", "5"].map(parseMultiplierToBps)).toEqual([
      10_000, 15_000, 12_500, 50_000,
    ]);
    expect(["0.5", "5.1", "x"].map(parseMultiplierToBps)).toEqual([null, null, null]);
  });
});

describe("the add-a-version form", () => {
  it("gives back the version it was filled from", () => {
    const parsed = ruleSetVersionSchema.parse(base);
    expect(parsed.rules).toEqual(ruleSetRulesJson(NTA_2025_V1.rules));
    expect(parsed.policy).toEqual(ruleSetPolicyJson(NTA_2025_V1.policy));
    expect(parsed.sourceLabel).toBeNull();
    expect(base.band1Width).toBe("2200000");
    expect(base.band5Width).toBeUndefined();
  });

  it("takes a changed rate and band width", () => {
    const parsed = ruleSetVersionSchema.parse({
      ...base,
      band1Rate: "16",
      band1Width: "2,500,000",
      nhfRate: "3",
    });
    expect(parsed.rules.paye_bands[1]).toEqual({ width_kobo: "250000000", rate_bps: 1600 });
    expect(parsed.rules.nhf.rate_bps).toBe(300);
  });

  it("refuses bad figures by field", () => {
    const result = ruleSetVersionSchema.safeParse({
      ...base,
      band2Rate: "101",
      band3Width: "0",
      rentReliefCap: "abc",
      itfMinStaff: "0",
      overtimeMultiplier: "0.5",
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => String(i.path[0]));
    for (const p of [
      "band2Rate",
      "band3Width",
      "rentReliefCap",
      "itfMinStaff",
      "overtimeMultiplier",
    ]) {
      expect(paths, p).toContain(p);
    }
    const text = ruleSetVersionSchema.safeParse({
      ...base,
      reason: " ",
      name: "See www.example.com",
    });
    expect(text.error!.issues.map((i) => String(i.path[0])).sort()).toEqual(["name", "reason"]);
  });

  it("refuses a form without its bands or bases", () => {
    expect(ruleSetVersionSchema.safeParse({ ...base, bandCount: "" }).success).toBe(false);
    expect(ruleSetVersionSchema.safeParse({ ...base, pensionBase: "basic,salary" }).success).toBe(
      false,
    );
    expect(ruleSetVersionSchema.safeParse({ ...base, publicHolidayMode: "double" }).success).toBe(
      false,
    );
  });
});
