import { describe, expect, it } from "vitest";

import { generateStaffIds, nextStaffId } from "@/server/people/staff-id";

describe("staff ID generation", () => {
  it("starts at EMP-0001 when the company has no numbered IDs", () => {
    expect(nextStaffId([])).toBe("EMP-0001");
    expect(nextStaffId(["KOLA", "SUPERVISOR"])).toBe("EMP-0001");
  });

  it("continues the company's own pattern after its highest number", () => {
    expect(nextStaffId(["CSL-0410", "CSL-0412", "CSL-0007"])).toBe("CSL-0413");
  });

  it("follows the most common pattern, ties going to the one seen first", () => {
    expect(nextStaffId(["AFS-0042", "X1", "AFS-0050", "X9"])).toBe("AFS-0051");
    expect(nextStaffId(["SEC/001", "CLN/010"])).toBe("SEC/002");
  });

  it("skips IDs already taken, ignoring case", () => {
    expect(nextStaffId(["EMP-0001", "EMP-0002", "emp-0003"])).toBe("EMP-0004");
    expect(generateStaffIds(["emp-0001", "EMP-0003", "EMP-0002"], 2)).toEqual([
      "emp-0004",
      "emp-0005",
    ]);
  });

  it("grows past the padding width without losing digits", () => {
    expect(nextStaffId(["EMP-9999"])).toBe("EMP-10000");
    expect(nextStaffId(["W-99999999999999999999"])).toBe("W-100000000000000000000");
  });

  it("hands out several distinct IDs at once", () => {
    expect(generateStaffIds(["EMP-0001"], 3)).toEqual(["EMP-0002", "EMP-0003", "EMP-0004"]);
  });
});
