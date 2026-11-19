/** Slice 2.4: contract, rate card and WHT input, as the forms send it. */
import { describe, expect, it } from "vitest";

import { clientTaxSchema } from "@/server/business/schemas";
import {
  createContractSchema,
  saveRateCardSchema,
  toSla,
  updateContractSchema,
} from "@/server/business/contract-schemas";

const CLIENT = "6f1c1d7e-0b8a-4a4e-9a52-3f5d2b7c9e10";
const SITE = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

const base = {
  clientId: CLIENT,
  name: "Apapa guarding",
  type: "manned_post",
  startDate: "2026-12-01",
  billingFrequency: "monthly",
};

describe("createContractSchema", () => {
  it("parses a contract with its sites, SLA and WHT", () => {
    const parsed = createContractSchema.parse({
      ...base,
      reference: "",
      endDate: "",
      vatApplies: "on",
      coverageTargetBps: "98.5",
      responseMinutes: "30",
      slaNotes: "Relief within 2 hours",
      siteIds: [SITE, SITE],
    });
    expect(parsed).toMatchObject({
      reference: null,
      endDate: null,
      vatApplies: true,
      coverageTargetBps: 9850,
      responseMinutes: 30,
      siteIds: [SITE],
    });
    expect(toSla(parsed)).toEqual({
      coverage_target_bps: 9850,
      response_minutes: 30,
      notes: "Relief within 2 hours",
    });
  });

  it("refuses bad types, dates, references, WHT and SLA values", () => {
    const issues = (input: Record<string, unknown>) =>
      createContractSchema.safeParse({ ...base, ...input }).error?.issues.map((i) => i.path[0]);
    expect(issues({ type: "milestone" })).toEqual(["type"]);
    expect(issues({ endDate: "2026-11-30" })).toEqual(["endDate"]);
    expect(issues({ startDate: "1 Dec" })).toEqual(["startDate"]);
    expect(issues({ startDate: "2026-02-31" })).toEqual(["startDate"]);
    expect(issues({ reference: "CTR 7" })).toEqual(["reference"]);
    expect(issues({ coverageTargetBps: "101" })).toEqual(["coverageTargetBps"]);
    expect(issues({ responseMinutes: "0" })).toEqual(["responseMinutes"]);
    expect(issues({ name: "<script>" })).toEqual(["name"]);
  });

  it("leaves VAT off when the box is unticked and the update needs a contract id", () => {
    expect(createContractSchema.parse(base).vatApplies).toBe(false);
    expect(updateContractSchema.safeParse(base).success).toBe(false);
  });
});

describe("saveRateCardSchema", () => {
  const card = (lines: unknown) => ({
    contractId: CLIENT,
    effectiveFrom: "2027-01-01",
    lines: JSON.stringify(lines),
  });
  const day = {
    role: "Guard",
    band: "Day",
    unit: "shift",
    rate: "12,500",
    otRate: "1,600",
    otMultiplier: "1.5",
  };

  it("turns typed lines into kobo, to the kobo", () => {
    const parsed = saveRateCardSchema.parse(
      card([day, { ...day, band: "Night", rate: "15000.50", otRate: "1,900" }]),
    );
    expect(
      parsed.lines.map((l) => [l.rateKobo, l.otRateKobo, l.otMultiplierBps, l.whtRateBps]),
    ).toEqual([
      [1_250_000n, 160_000n, 15_000, 200],
      [1_500_050n, 190_000n, 15_000, 200],
    ]);
  });

  it("refuses no lines, a bad line, a duplicate key and junk", () => {
    const message = (input: unknown) =>
      saveRateCardSchema.safeParse(input).error?.issues[0]?.message;
    expect(message(card([]))).toBe("Add at least one rate line");
    expect(message({ ...card([day]), lines: "not json" })).toBe("Add at least one rate line");
    expect(message(card([day, { ...day, rate: "0" }]))).toMatch(/^Line 2: Enter a rate/);
    expect(message(card([day, { ...day, role: "guard", band: "DAY" }]))).toBe(
      "Guard · Day (shift) is on the card twice. Give each role and band one rate.",
    );
  });
});

describe("clientTaxSchema", () => {
  it("takes the WHT expectation, the VAT box and an optional reason", () => {
    expect(
      clientTaxSchema.parse({ clientId: CLIENT, deductsWht: "not_deducted", withholdsVat: "on" }),
    ).toEqual({ clientId: CLIENT, deductsWht: "not_deducted", withholdsVat: true, reason: null });
    expect(clientTaxSchema.safeParse({ clientId: CLIENT, deductsWht: "sometimes" }).success).toBe(
      false,
    );
  });
});
