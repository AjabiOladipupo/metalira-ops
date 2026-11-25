/**
 * Slice U.1 review (M1): a bulk confirm carries the digest of the people its preview showed;
 * the same set always gives the same digest, and any other set a different one.
 */
import { describe, expect, it } from "vitest";

import { reporteesAddedSubject } from "@/server/email/templates/reportees-added";
import { bulkEndEmploymentSchema, selectionDigest } from "@/server/people/bulk";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("selectionDigest", () => {
  it("ignores order, repeats and case", () => {
    expect(selectionDigest([A, B])).toBe(selectionDigest([B, A, B.toUpperCase()]));
    expect(selectionDigest([A])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when anyone is added or removed", () => {
    const base = selectionDigest([A, B]);
    expect(selectionDigest([A, B, C])).not.toBe(base);
    expect(selectionDigest([A])).not.toBe(base);
    expect(selectionDigest([A, C])).not.toBe(base);
  });
});

describe("confirm input", () => {
  it("needs the preview's digest", () => {
    const input = {
      selection: { kind: "ids", ids: [A] },
      endDate: "2026-11-30",
      reason: "Contract ended",
    };
    expect(bulkEndEmploymentSchema.safeParse(input).success).toBe(false);
    expect(
      bulkEndEmploymentSchema.safeParse({ ...input, expectedDigest: selectionDigest([A]) }).success,
    ).toBe(true);
  });
});

describe("the new line manager's summary", () => {
  it("reads as a count", () => {
    expect(reporteesAddedSubject(1)).toBe("You're now line manager for 1 person");
    expect(reporteesAddedSubject(12)).toBe("You're now line manager for 12 people");
  });
});
