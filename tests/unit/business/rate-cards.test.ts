/**
 * Slice 2.4: the pure rate card library (src/lib/rate-cards.ts). Dating rules match the
 * database functions (migration 20261119130000); amounts are bigint kobo, to the kobo.
 */
import { describe, expect, it } from "vitest";

import { parseNairaToKobo } from "@/lib/money";
import {
  diffRateLines,
  findRateLine,
  formatMultiplier,
  formatPercentBps,
  formatRateSummary,
  missingRateKeys,
  overtimeFromMultiplier,
  parseMultiplierBps,
  parsePercentBps,
  parseRateKobo,
  parseRateLine,
  planCancelVersion,
  planNewVersion,
  previewRateChange,
  rateCardInForce,
  toRateLineInput,
  toRateLinePayload,
  versionIsFrozen,
  versionState,
  type RateCardVersion,
  type RateLine,
} from "@/lib/rate-cards";

const line = (over: Partial<RateLine> = {}): RateLine => ({
  role: "Guard",
  band: "Day",
  unit: "shift",
  rateKobo: 1_250_000n,
  currency: "NGN",
  otRateKobo: null,
  otMultiplierBps: 15_000,
  serviceType: "services",
  whtRateBps: 200,
  ...over,
});

const DAY = line();
const NIGHT = line({ band: "Night", rateKobo: 1_500_000n });

const v1: RateCardVersion = {
  id: "v1",
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
  note: null,
  lines: [DAY, NIGHT],
};

const ACTIVE = { status: "active" as const, startDate: "2026-11-01", endDate: null };
const DRAFT = { ...ACTIVE, status: "draft" as const };

describe("kobo parsing on rate lines", () => {
  it("round-trips 12,500 and 12500.50 to the kobo", () => {
    expect(parseRateKobo("12,500")).toBe(1_250_000n);
    expect(parseRateKobo("12500.50")).toBe(1_250_050n);
    expect(parseRateKobo("₦15,000")).toBe(1_500_000n);
    const parsed = parseRateLine({
      role: "Guard",
      band: "Day",
      unit: "shift",
      rate: "12500.50",
      otRate: "1,600",
      otMultiplier: "1.5",
      serviceType: "services",
      whtRate: "",
    });
    expect(parsed.ok && parsed.line.rateKobo).toBe(1_250_050n);
    if (!parsed.ok) throw new Error("expected a line");
    expect(toRateLineInput(parsed.line).rate).toBe("12500.50");
    expect(parseNairaToKobo(toRateLineInput(parsed.line).rate)).toBe(1_250_050n);
    expect(toRateLinePayload(parsed.line)).toEqual({
      role: "Guard",
      band: "Day",
      unit: "shift",
      rate_kobo: "1250050",
      ot_rate_kobo: "160000",
      ot_multiplier_bps: 15_000,
      service_type: "services",
      wht_rate_bps: 200,
    });
  });

  it("refuses zero, negatives, three decimals, over ₦1bn and junk", () => {
    for (const bad of ["0", "-5", "12.505", "1,000,000,000.01", "12,50", "abc", ""]) {
      expect(parseRateKobo(bad), bad).toBeNull();
    }
    expect(parseRateKobo("1,000,000,000")).toBe(100_000_000_000n);
  });

  it("checks every field of a typed line", () => {
    const base = {
      role: "Guard",
      band: "",
      unit: "shift",
      rate: "12500",
      otRate: "",
      otMultiplier: "",
      serviceType: "",
      whtRate: "",
    };
    expect(parseRateLine(base)).toMatchObject({
      ok: true,
      line: { band: "standard", otMultiplierBps: null },
    });
    expect(parseRateLine({ ...base, role: " " })).toMatchObject({ ok: false, field: "role" });
    expect(parseRateLine({ ...base, role: "<b>" })).toMatchObject({ ok: false, field: "role" });
    expect(parseRateLine({ ...base, unit: "day" })).toMatchObject({ ok: false, field: "unit" });
    expect(parseRateLine({ ...base, otRate: "x" })).toMatchObject({ ok: false, field: "otRate" });
    expect(parseRateLine({ ...base, otMultiplier: "4" })).toMatchObject({
      ok: false,
      field: "otMultiplier",
    });
    expect(parseRateLine({ ...base, otRate: "1,600" })).toMatchObject({
      ok: true,
      line: { otRateKobo: 160_000n },
    });
  });

  it("parses and prints multipliers and percentages without floats", () => {
    expect(parseMultiplierBps("1.5")).toBe(15_000);
    expect(parseMultiplierBps("1.25x")).toBe(12_500);
    expect(parseMultiplierBps("2×")).toBe(20_000);
    expect(parseMultiplierBps("0.5")).toBeNull();
    expect(parseMultiplierBps("3.01")).toBeNull();
    expect(formatMultiplier(15_000)).toBe("1.5×");
    expect(formatMultiplier(12_500)).toBe("1.25×");
    expect(formatMultiplier(20_000)).toBe("2×");
    expect(parsePercentBps("5")).toBe(500);
    expect(parsePercentBps("7.5%")).toBe(750);
    expect(parsePercentBps("20")).toBe(2000);
    expect(parsePercentBps("20.01")).toBeNull();
    expect(formatPercentBps(500)).toBe("5%");
    expect(formatPercentBps(750)).toBe("7.5%");
    expect(formatPercentBps(0)).toBe("0%");
  });
});

describe("dating", () => {
  const v2: RateCardVersion = { ...v1, id: "v2", effectiveFrom: "2027-01-01", effectiveTo: null };
  const closedV1 = { ...v1, effectiveTo: "2026-12-31" };

  it("finds the version in force", () => {
    expect(rateCardInForce([closedV1, v2], "2026-12-31")?.id).toBe("v1");
    expect(rateCardInForce([closedV1, v2], "2027-01-01")?.id).toBe("v2");
    expect(rateCardInForce([closedV1, v2], "2026-10-31")).toBeNull();
  });

  it("closes the previous version the day before (Change rates from 1 Jan)", () => {
    expect(planNewVersion([v1], "2027-01-01", "2026-11-19", ACTIVE)).toEqual({
      ok: true,
      closes: {
        id: "v1",
        effectiveFrom: "2026-11-01",
        effectiveToBefore: null,
        effectiveToAfter: "2026-12-31",
      },
      starts: { effectiveFrom: "2027-01-01", effectiveTo: null },
    });
  });

  it("refuses an overlap: a version from that date or later exists", () => {
    const plan = planNewVersion([closedV1, v2], "2026-12-15", "2026-11-19", ACTIVE);
    expect(plan).toEqual({
      ok: false,
      reason: "A rate card from this date or later already exists. Cancel it first.",
    });
    expect(planNewVersion([v1], "2026-11-01", "2026-11-19", ACTIVE).ok).toBe(false);
  });

  it("freezes the past on a live contract, but not on a draft", () => {
    expect(planNewVersion([v1], "2026-11-18", "2026-11-19", ACTIVE)).toEqual({
      ok: false,
      reason: "A rate change starts today or later.",
    });
    expect(planNewVersion([v1], "2026-11-19", "2026-11-19", ACTIVE).ok).toBe(true);
    expect(planNewVersion([v1], "2026-11-18", "2026-11-19", DRAFT).ok).toBe(true);
    expect(versionIsFrozen(v1, "2026-11-19", "active")).toBe(true);
    expect(versionIsFrozen(v2, "2026-11-19", "active")).toBe(false);
    expect(versionIsFrozen(v1, "2026-11-19", "draft")).toBe(false);
    expect(versionState(closedV1, "2027-01-02")).toBe("ended");
    expect(versionState(v2, "2026-11-19")).toBe("scheduled");
    expect(versionState(v1, "2026-11-19")).toBe("in_force");
  });

  it("keeps new versions inside the contract and refuses ended contracts", () => {
    const ending = { ...ACTIVE, endDate: "2026-12-31" };
    expect(planNewVersion([v1], "2027-01-01", "2026-11-19", ending).ok).toBe(false);
    expect(
      planNewVersion([v1], "2027-01-01", "2026-11-19", { ...ACTIVE, status: "ended" }).ok,
    ).toBe(false);
    expect(planNewVersion([], "2027-01-01", "2026-11-19", ACTIVE)).toEqual({
      ok: false,
      reason: "This contract has no rate card yet. Add the first one.",
    });
  });

  it("cancels only the latest scheduled version and reopens the one before it", () => {
    expect(planCancelVersion([closedV1, v2], "v2", "2026-11-19", ACTIVE)).toEqual({
      ok: true,
      reopens: { id: "v1", effectiveToAfter: null },
    });
    expect(planCancelVersion([closedV1, v2], "v1", "2026-11-19", ACTIVE).ok).toBe(false);
    expect(planCancelVersion([closedV1, v2], "v2", "2027-01-01", ACTIVE)).toEqual({
      ok: false,
      reason: "This rate card is already in force and can't be cancelled.",
    });
    expect(planCancelVersion([v1], "v1", "2026-10-01", ACTIVE).ok).toBe(false);
    expect(planCancelVersion([v1], "v1", "2026-11-19", DRAFT)).toEqual({ ok: true, reopens: null });
  });
});

describe("rate keys", () => {
  it("finds lines by role, band and unit, ignoring case", () => {
    expect(findRateLine(v1, { role: "guard", band: "NIGHT", unit: "shift" })).toBe(NIGHT);
    expect(findRateLine(v1, { role: "Guard", band: "Night", unit: "hour" })).toBeNull();
  });

  it("reports a missing key once", () => {
    const keys = [
      { role: "Guard", band: "Day", unit: "shift" as const },
      { role: "Supervisor", band: "standard", unit: "shift" as const },
      { role: "supervisor", band: "Standard", unit: "shift" as const },
    ];
    expect(missingRateKeys(keys, v1)).toEqual([keys[1]]);
    expect(missingRateKeys(keys, null)).toHaveLength(2);
  });
});

describe("summary text", () => {
  it("shows no overtime for a multiplier without its hourly rate", () => {
    expect(formatRateSummary([DAY, NIGHT])).toBe("₦12,500 day · ₦15,000 night shift · WHT 2%");
  });

  it("names the hourly overtime rate when the lines have one", () => {
    const withOt = [
      line({ otRateKobo: 160_000n }),
      line({ band: "Night", rateKobo: 1_500_000n, otRateKobo: 160_000n }),
    ];
    expect(formatRateSummary(withOt)).toBe(
      "₦12,500 day · ₦15,000 night shift · overtime ₦1,600 an hour · WHT 2%",
    );
    const differ = [
      line({ otRateKobo: 160_000n }),
      line({ band: "Night", rateKobo: 1_500_000n, otRateKobo: 190_050n }),
    ];
    expect(formatRateSummary(differ)).toBe(
      "₦12,500 day (overtime ₦1,600 an hour) · ₦15,000 night shift (overtime ₦1,900.50 an hour) · WHT 2%",
    );
  });

  it("handles one standard line, several roles, kobo and no lines", () => {
    expect(
      formatRateSummary([
        line({ role: "Supervisor", band: "standard", rateKobo: 1_800_000n, otMultiplierBps: null }),
      ]),
    ).toBe("₦18,000 a shift · WHT 2%");
    expect(
      formatRateSummary([
        line({ otMultiplierBps: null }),
        line({
          role: "Cleaner",
          band: "standard",
          unit: "visit",
          rateKobo: 450_050n,
          otMultiplierBps: null,
        }),
      ]),
    ).toBe("₦12,500 guard day shift · ₦4,500.50 cleaner visit · WHT 2%");
    expect(formatRateSummary([])).toBe("No rates yet");
  });
});

describe("preview of a rate change", () => {
  it("says what closes, what starts and which lines change", () => {
    const next = [
      line({ rateKobo: 1_300_000n }),
      NIGHT,
      line({ role: "Supervisor", band: "standard", rateKobo: 1_800_000n }),
    ];
    const diff = diffRateLines(v1.lines, next);
    expect(diff.unchanged).toBe(1);
    expect(diff.changes.map((c) => c.kind)).toEqual(["changed", "added"]);

    const preview = previewRateChange([v1], "2027-01-01", "2026-11-19", ACTIVE, next);
    expect(preview.ok).toBe(true);
    expect(preview.summary).toBe(
      "Changes 2 lines from 1 Jan 2027; 1 line stays the same. The current rates end on 31 Dec 2026.",
    );
    expect(preview.changes).toContainEqual({
      label: "Current rates",
      before: "No end date",
      after: "End on 31 Dec 2026",
    });
    expect(preview.changes).toContainEqual({
      label: "Guard · Day (shift)",
      before: "₦12,500 a shift, WHT 2%",
      after: "₦13,000 a shift, WHT 2%",
    });
    const removed = diffRateLines(v1.lines, [DAY]);
    expect(removed.changes).toEqual([{ key: NIGHT, kind: "removed", before: NIGHT, after: null }]);
  });

  it("carries the database's refusal as the summary", () => {
    const preview = previewRateChange([v1], "2026-11-01", "2026-11-19", ACTIVE, [DAY]);
    expect(preview).toEqual({
      ok: false,
      summary: "A rate card from this date or later already exists. Cancel it first.",
      changes: [],
    });
  });
});

describe("overtime and the contract's end (money review)", () => {
  const typed = {
    role: "Guard",
    band: "Relief",
    rate: "1,500.50",
    otRate: "",
    otMultiplier: "1.5",
    serviceType: "",
    whtRate: "",
  };

  it("works out an hourly line's overtime rate from the multiplier, half up once", () => {
    expect(overtimeFromMultiplier(150_050n, 15_000)).toBe(225_075n);
    expect(overtimeFromMultiplier(1n, 15_000)).toBe(2n);
    expect(overtimeFromMultiplier(3n, 12_500)).toBe(4n);
    expect(parseRateLine({ ...typed, unit: "hour" })).toMatchObject({
      ok: true,
      line: { otRateKobo: 225_075n, otMultiplierBps: 15_000 },
    });
  });

  it("refuses a typed hourly overtime rate that disagrees with the multiplier, or one over ₦1bn", () => {
    expect(parseRateLine({ ...typed, unit: "hour", otRate: "2,250.75" })).toMatchObject({
      ok: true,
      line: { otRateKobo: 225_075n },
    });
    expect(parseRateLine({ ...typed, unit: "hour", otRate: "2,250" })).toMatchObject({
      ok: false,
      field: "otRate",
    });
    expect(
      parseRateLine({ ...typed, unit: "hour", rate: "900,000,000", otMultiplier: "1.5" }),
    ).toMatchObject({ ok: false, field: "otMultiplier" });
  });

  it("needs the hourly overtime rate on other units when a multiplier is given", () => {
    expect(parseRateLine({ ...typed, unit: "shift" })).toMatchObject({
      ok: false,
      field: "otRate",
    });
    expect(parseRateLine({ ...typed, unit: "shift", otRate: "1,600" })).toMatchObject({
      ok: true,
      line: { otRateKobo: 160_000n, otMultiplierBps: 15_000 },
    });
  });

  it("puts nothing in force after the contract ends, open version or not", () => {
    expect(rateCardInForce([v1], "2027-02-01", "2027-01-31")).toBeNull();
    expect(rateCardInForce([v1], "2027-01-31", "2027-01-31")?.id).toBe("v1");
  });

  it("sets WHT per line from the service type, and says it per line when lines differ", () => {
    const input = {
      role: "Supervisor",
      band: "",
      unit: "month",
      rate: "100,000",
      otRate: "",
      otMultiplier: "",
    };
    expect(parseRateLine({ ...input, serviceType: "services", whtRate: "" })).toMatchObject({
      ok: true,
      line: { serviceType: "services", whtRateBps: 200 },
    });
    expect(parseRateLine({ ...input, serviceType: "management_fee", whtRate: "" })).toMatchObject({
      ok: true,
      line: { whtRateBps: 500 },
    });
    expect(parseRateLine({ ...input, serviceType: "rent_hire", whtRate: "" })).toMatchObject({
      ok: true,
      line: { whtRateBps: 1000 },
    });
    expect(parseRateLine({ ...input, serviceType: "goods", whtRate: "7.5" })).toMatchObject({
      ok: true,
      line: { whtRateBps: 750 },
    });
    expect(parseRateLine({ ...input, serviceType: "lunch", whtRate: "" })).toMatchObject({
      ok: false,
      field: "serviceType",
    });
    expect(parseRateLine({ ...input, serviceType: "services", whtRate: "25" })).toMatchObject({
      ok: false,
      field: "whtRate",
    });

    const services = line({
      role: "Cleaner",
      band: "standard",
      unit: "month",
      rateKobo: 90_000_000n,
      otMultiplierBps: null,
    });
    const fee = line({
      role: "Management",
      band: "standard",
      unit: "month",
      rateKobo: 10_000_000n,
      otMultiplierBps: null,
      serviceType: "management_fee",
      whtRateBps: 500,
    });
    expect(formatRateSummary([services, fee])).toBe(
      "₦900,000 cleaner (WHT 2%) · ₦100,000 management month (WHT 5%)",
    );
    const diff = diffRateLines([services], [{ ...services, whtRateBps: 500 }]);
    expect(diff.changes.map((c) => c.kind)).toEqual(["changed"]);
  });
});
