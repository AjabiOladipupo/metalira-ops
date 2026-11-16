import { describe, expect, it } from "vitest";

import {
  currentPayVersion,
  decodeLineManager,
  encodeLineManager,
  initials,
  isMapped,
  matchesPeopleSearch,
  payHeadline,
  payVersionState,
  type PayAmounts,
} from "@/lib/people";

const W = "b0000000-0000-4000-8000-000000000002";
const M = "c0000000-0000-4000-8000-000000000003";

const none: Omit<PayAmounts, "payType"> = {
  basic: null,
  housing: null,
  transport: null,
  otherAllowances: null,
  dailyRate: null,
  hourlyRate: null,
};

describe("mapping status", () => {
  it("needs a department, a line manager and a site; projects are optional", () => {
    expect(isMapped({ departmentId: "d", hasLineManager: true, siteIds: ["s"] })).toBe(true);
    expect(isMapped({ departmentId: null, hasLineManager: true, siteIds: ["s"] })).toBe(false);
    expect(isMapped({ departmentId: "d", hasLineManager: false, siteIds: ["s"] })).toBe(false);
    expect(isMapped({ departmentId: "d", hasLineManager: true, siteIds: [] })).toBe(false);
  });
});

describe("line manager choice", () => {
  it("round-trips a worker and a manager-app user", () => {
    expect(encodeLineManager({ kind: "worker", id: W })).toBe(`w:${W}`);
    expect(encodeLineManager({ kind: "membership", id: M })).toBe(`m:${M}`);
    expect(encodeLineManager(null)).toBe("");
    expect(decodeLineManager(`w:${W}`)).toEqual({
      lineManagerWorkerId: W,
      lineManagerMembershipId: null,
    });
    expect(decodeLineManager(`m:${M}`)).toEqual({
      lineManagerWorkerId: null,
      lineManagerMembershipId: M,
    });
  });

  it("clears both columns for an empty or unknown value", () => {
    for (const value of ["", undefined, null, "w:", "x:abc", W]) {
      expect(decodeLineManager(value)).toEqual({
        lineManagerWorkerId: null,
        lineManagerMembershipId: null,
      });
    }
  });
});

describe("pay versions", () => {
  it("adds monthly basic and allowances exactly in kobo", () => {
    expect(
      payHeadline({
        ...none,
        payType: "monthly",
        basic: 10_500_000n,
        housing: 3_600_000n,
        transport: 2_400_050n,
        otherAllowances: 0n,
      }),
    ).toBe(16_500_050n);
    expect(payHeadline({ ...none, payType: "daily", dailyRate: 500_000n })).toBe(500_000n);
    expect(payHeadline({ ...none, payType: "hourly", hourlyRate: 75_050n })).toBe(75_050n);
  });

  it("stays exact beyond the safe-integer range", () => {
    const big = 9_007_199_254_740_993n;
    expect(payHeadline({ ...none, payType: "monthly", basic: big, housing: 1n })).toBe(big + 1n);
  });

  it("tells current, scheduled and ended versions apart", () => {
    const today = "2026-11-16";
    const ended = { effectiveFrom: "2026-01-01", effectiveTo: "2026-11-15" };
    const current = { effectiveFrom: "2026-11-16", effectiveTo: "2026-11-30" };
    const scheduled = { effectiveFrom: "2026-12-01", effectiveTo: null };
    expect(payVersionState(ended, today)).toBe("ended");
    expect(payVersionState(current, today)).toBe("current");
    expect(payVersionState(scheduled, today)).toBe("scheduled");
    expect(currentPayVersion([ended, current, scheduled], today)).toBe(current);
    expect(currentPayVersion([scheduled], today)).toBeNull();
  });
});

describe("people search", () => {
  const musa = { firstName: "Musa", lastName: "Ibrahim", staffId: "MO-0114" };

  it("matches full name either way round, or staff ID, ignoring case", () => {
    expect(matchesPeopleSearch(musa, "")).toBe(true);
    expect(matchesPeopleSearch(musa, "musa ib")).toBe(true);
    expect(matchesPeopleSearch(musa, "Ibrahim  Musa")).toBe(true);
    expect(matchesPeopleSearch(musa, "mo-0114")).toBe(true);
    expect(matchesPeopleSearch(musa, "0114")).toBe(true);
    expect(matchesPeopleSearch(musa, "Halima")).toBe(false);
  });

  it("gives initials", () => {
    expect(initials(musa)).toBe("MI");
  });
});
