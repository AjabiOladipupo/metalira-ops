/**
 * Slice 4.1: proration for joiners, entitlement version planning (rule 3), the working week and
 * copying holidays. Mirrors of the SQL rules in 20261121110000_leave_setup.sql.
 */
import { describe, expect, it } from "vitest";

import {
  changeDateChoices,
  formatLeaveDays,
  formatLeavePay,
  formatWorkDays,
  isAllowedChangeDate,
  normaliseWorkDays,
  planEntitlementChange,
  planHolidayCopy,
  prorateEntitlement,
  versionOn,
  type EntitlementVersion,
} from "@/lib/leave/entitlements";

describe("prorateEntitlement", () => {
  it("gives the full figure to anyone who started by 1 January", () => {
    expect(prorateEntitlement(15, "2020-03-01", 2026)).toBe(15);
    expect(prorateEntitlement(15, "2026-01-01", 2026)).toBe(15);
  });

  it("gives nothing to a start after the year", () => {
    expect(prorateEntitlement(15, "2027-01-01", 2026)).toBe(0);
  });

  it("prorates by days left in the year, half up once", () => {
    // 1 Jul 2026: 184 days left of 365. 15 x 184 / 365 = 7.56, so 8.
    expect(prorateEntitlement(15, "2026-07-01", 2026)).toBe(8);
    // 31 Dec: 1 day. 15 / 365 = 0.04, so 0.
    expect(prorateEntitlement(15, "2026-12-31", 2026)).toBe(0);
    // 2 Jul: 183 days. 12 x 183 / 365 = 6.02, so 6.
    expect(prorateEntitlement(12, "2026-07-02", 2026)).toBe(6);
  });

  it("rounds an exact half up", () => {
    // 2028 has 366 days. From 2 Jul 2028: 183 days left. 1 x 183 / 366 = 0.5, so 1.
    expect(prorateEntitlement(1, "2028-07-02", 2028)).toBe(1);
    // From 3 Jul: 182 days, 0.497, so 0.
    expect(prorateEntitlement(1, "2028-07-03", 2028)).toBe(0);
  });

  it("refuses fractional or negative days", () => {
    expect(() => prorateEntitlement(1.5, "2026-07-01", 2026)).toThrow(RangeError);
    expect(() => prorateEntitlement(-1, "2026-07-01", 2026)).toThrow(RangeError);
  });
});

const v = (
  id: string,
  from: string,
  to: string | null,
  days: number,
  extra: Partial<EntitlementVersion> = {},
): EntitlementVersion => ({
  id,
  effectiveFrom: from,
  effectiveTo: to,
  daysPerYear: days,
  carryOverCapDays: null,
  payPercent: 100,
  payMinServiceMonths: null,
  ...extra,
});

const values = (days: number) => ({
  daysPerYear: days,
  carryOverCapDays: null,
  payPercent: 100,
  payMinServiceMonths: null,
});

describe("change dates", () => {
  const today = "2026-11-21";

  it("offers tomorrow and the next 1 January", () => {
    expect(changeDateChoices(today)).toEqual({ tomorrow: "2026-11-22", nextJanuary: "2027-01-01" });
  });

  it("allows only tomorrow or a future 1 January", () => {
    expect(isAllowedChangeDate("2026-11-22", today)).toBe(true);
    expect(isAllowedChangeDate("2027-01-01", today)).toBe(true);
    expect(isAllowedChangeDate("2028-01-01", today)).toBe(true);
    expect(isAllowedChangeDate("2026-11-21", today)).toBe(false);
    expect(isAllowedChangeDate("2026-11-23", today)).toBe(false);
    expect(isAllowedChangeDate("2026-01-01", today)).toBe(false);
  });
});

describe("planEntitlementChange", () => {
  const today = "2026-11-21";

  it("starts a type's first version on 1 January this year", () => {
    expect(planEntitlementChange([], values(15), "2027-01-01", today)).toEqual({
      kind: "first",
      effectiveFrom: "2026-01-01",
    });
  });

  it("closes the version in force the day before the change", () => {
    const plan = planEntitlementChange(
      [v("a", "2026-01-01", null, 15)],
      values(18),
      "2027-01-01",
      today,
    );
    expect(plan).toMatchObject({
      kind: "change",
      effectiveFrom: "2027-01-01",
      closes: { id: "a", effectiveTo: "2026-12-31" },
      replaces: [],
    });
  });

  it("closes today for a change from tomorrow", () => {
    const plan = planEntitlementChange(
      [v("a", "2026-01-01", null, 15)],
      values(18),
      "2026-11-22",
      today,
    );
    expect(plan).toMatchObject({ closes: { id: "a", effectiveTo: "2026-11-21" } });
  });

  it("replaces a scheduled version from the same date or later", () => {
    const versions = [v("a", "2026-01-01", "2026-12-31", 15), v("b", "2027-01-01", null, 18)];
    const plan = planEntitlementChange(versions, values(20), "2027-01-01", today);
    if (plan.kind !== "change") throw new Error("expected a change");
    expect(plan.closes).toEqual({ id: "a", effectiveTo: "2026-12-31" });
    expect(plan.replaces.map((r) => r.id)).toEqual(["b"]);

    const earlier = planEntitlementChange(versions, values(20), "2026-11-22", today);
    if (earlier.kind !== "change") throw new Error("expected a change");
    expect(earlier.replaces.map((r) => r.id)).toEqual(["b"]);
    expect(earlier.closes).toEqual({ id: "a", effectiveTo: "2026-11-21" });
  });

  it("changes nothing when the values match and nothing is scheduled", () => {
    const plan = planEntitlementChange(
      [v("a", "2026-01-01", null, 15)],
      values(15),
      "2027-01-01",
      today,
    );
    expect(plan.kind).toBe("unchanged");
  });

  it("counts a pay change as a change", () => {
    const plan = planEntitlementChange(
      [v("a", "2026-01-01", null, 84, { payPercent: 50, payMinServiceMonths: 6 })],
      { daysPerYear: 84, carryOverCapDays: null, payPercent: 100, payMinServiceMonths: null },
      "2027-01-01",
      today,
    );
    expect(plan.kind).toBe("change");
  });

  it("refuses today, or a date that isn't tomorrow or 1 January", () => {
    const versions = [v("a", "2026-01-01", null, 15)];
    expect(() => planEntitlementChange(versions, values(18), "2026-11-21", today)).toThrow(
      RangeError,
    );
    expect(() => planEntitlementChange(versions, values(18), "2026-12-01", today)).toThrow(
      RangeError,
    );
  });

  it("finds the version in force on a date", () => {
    const versions = [v("a", "2026-01-01", "2026-12-31", 15), v("b", "2027-01-01", null, 18)];
    expect(versionOn(versions, "2026-11-21")?.id).toBe("a");
    expect(versionOn(versions, "2027-03-01")?.id).toBe("b");
    expect(versionOn(versions, "2025-12-31")).toBeNull();
  });
});

describe("formatting", () => {
  it("writes days and weeks", () => {
    expect(formatLeaveDays(15, "working_days")).toBe("15 working days");
    expect(formatLeaveDays(1, "working_days")).toBe("1 working day");
    expect(formatLeaveDays(84, "calendar_days")).toBe("84 calendar days (12 weeks)");
  });

  it("writes pay", () => {
    expect(formatLeavePay(true, 100, null)).toBe("Full pay");
    expect(formatLeavePay(true, 50, 6)).toBe("50% pay after 6 months' service");
    expect(formatLeavePay(false, 100, null)).toBe("No pay");
  });
});

describe("working week", () => {
  it("normalises ISO weekdays", () => {
    expect(normaliseWorkDays([5, 1, 3, 1])).toEqual([1, 3, 5]);
    expect(normaliseWorkDays([])).toBeNull();
    expect(normaliseWorkDays([0, 1])).toBeNull();
    expect(normaliseWorkDays([8])).toBeNull();
  });

  it("reads as a range when it is one", () => {
    expect(formatWorkDays([1, 2, 3, 4, 5])).toBe("Mon to Fri");
    expect(formatWorkDays([1, 2, 3, 4, 5, 6])).toBe("Mon to Sat");
    expect(formatWorkDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatWorkDays([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
  });
});

describe("planHolidayCopy", () => {
  it("copies same day and month, skipping taken dates and 29 Feb in a common year", () => {
    const plan = planHolidayCopy(
      [
        { date: "2028-10-01", name: "Independence Day" },
        { date: "2028-02-29", name: "Leap day" },
        { date: "2028-01-01", name: "New Year's Day" },
      ],
      [{ date: "2029-01-01", name: "New Year" }],
      2029,
    );
    expect(plan.copied).toEqual([{ date: "2029-10-01", name: "Independence Day" }]);
    expect(plan.skipped).toEqual([
      { date: "2029-01-01", name: "New Year's Day", reason: "Already a holiday: New Year" },
      { date: "2028-02-29", name: "Leap day", reason: "29 Feb isn't in 2029" },
    ]);
  });
});
