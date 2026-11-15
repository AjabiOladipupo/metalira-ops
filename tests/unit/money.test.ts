import { describe, expect, it } from "vitest";
import {
  allocateKobo,
  allocateKoboEvenly,
  applyBps,
  formatNaira,
  koboToMajorString,
  parseNairaToKobo,
  roundHalfUp,
  sumKobo,
  toKobo,
} from "@/lib/money";

describe("toKobo", () => {
  it("accepts bigint, safe integer numbers and digit strings", () => {
    expect(toKobo(1n)).toBe(1n);
    expect(toKobo(100)).toBe(100n);
    expect(toKobo("100")).toBe(100n);
    expect(toKobo("-250")).toBe(-250n);
    expect(toKobo(" 42 ")).toBe(42n);
    expect(toKobo("900719925474099300")).toBe(900719925474099300n);
  });

  it("rejects fractions, NaN, unsafe numbers and junk", () => {
    expect(() => toKobo(1.5)).toThrow(RangeError);
    expect(() => toKobo(Number.NaN)).toThrow(RangeError);
    expect(() => toKobo(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toKobo(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => toKobo("1.5")).toThrow(RangeError);
    expect(() => toKobo("")).toThrow(RangeError);
    expect(() => toKobo("1e3")).toThrow(RangeError);
    expect(() => toKobo("abc")).toThrow(RangeError);
  });
});

describe("parseNairaToKobo", () => {
  it.each([
    ["642,312.50", 64231250n],
    ["₦1,000", 100000n],
    ["₦ 1,000.00", 100000n],
    ["0.5", 50n],
    ["0.05", 5n],
    ["-12.34", -1234n],
    ["-₦1,000", -100000n],
    ["44812.5", 4481250n],
    ["1000000000", 100000000000n],
    ["0", 0n],
  ])("parses %s", (input, expected) => {
    expect(parseNairaToKobo(input)).toBe(expected);
  });

  it.each(["1.234", "", "abc", "1.2.3", "₦", "1,00", "12,3456", "1.", ".5", "--1", "1e3", "₦₦1"])(
    "rejects %j",
    (input) => {
      expect(() => parseNairaToKobo(input)).toThrow(RangeError);
    },
  );
});

describe("roundHalfUp", () => {
  it("rounds half away from zero", () => {
    expect(roundHalfUp(5n, 10n)).toBe(1n);
    expect(roundHalfUp(4n, 10n)).toBe(0n);
    expect(roundHalfUp(15n, 10n)).toBe(2n);
    expect(roundHalfUp(14n, 10n)).toBe(1n);
    expect(roundHalfUp(20n, 10n)).toBe(2n);
    expect(roundHalfUp(0n, 10n)).toBe(0n);
  });

  it("is symmetric for negatives, so a reversal mirrors the original", () => {
    expect(roundHalfUp(-5n, 10n)).toBe(-1n);
    expect(roundHalfUp(-4n, 10n)).toBe(0n);
    expect(roundHalfUp(-15n, 10n)).toBe(-2n);
    for (let n = -1000n; n <= 1000n; n++) {
      expect(roundHalfUp(-n, 7n)).toBe(-roundHalfUp(n, 7n));
    }
  });

  it("throws on a zero or negative denominator", () => {
    expect(() => roundHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => roundHalfUp(1n, -10n)).toThrow(RangeError);
  });
});

describe("applyBps", () => {
  it("applies basis points and rounds once", () => {
    expect(applyBps(59750000n, 750)).toBe(4481250n);
    expect(applyBps(59750000n, 750n)).toBe(4481250n);
    expect(applyBps(1n, 750)).toBe(0n); // 0.075 kobo
    expect(applyBps(7n, 750)).toBe(1n); // 0.525 kobo rounds up
    expect(applyBps(-7n, 750)).toBe(-1n);
    expect(applyBps(12000000n, 1000)).toBe(1200000n);
  });

  it("rejects a fractional or unsafe bps number", () => {
    expect(() => applyBps(100n, 7.5)).toThrow(RangeError);
    expect(() => applyBps(100n, Number.NaN)).toThrow(RangeError);
  });
});

describe("sumKobo", () => {
  it("sums exactly", () => {
    expect(sumKobo([])).toBe(0n);
    expect(sumKobo([1n, 2n, -3n, 100n])).toBe(100n);
    expect(sumKobo([10n ** 20n, 1n])).toBe(10n ** 20n + 1n);
  });
});

describe("formatNaira", () => {
  it.each([
    [0n, "₦0.00"],
    [5n, "₦0.05"],
    [99n, "₦0.99"],
    [100n, "₦1.00"],
    [64231250n, "₦642,312.50"],
    [100000000000n, "₦1,000,000,000.00"],
    [-100000n, "-₦1,000.00"],
    [-5n, "-₦0.05"],
  ])("formats %s kobo as %s", (kobo, expected) => {
    expect(formatNaira(kobo)).toBe(expected);
  });

  it("stays exact above 2^53 (no floats)", () => {
    expect(formatNaira(10n ** 20n)).toBe("₦1,000,000,000,000,000,000.00");
    expect(formatNaira(9007199254740993n)).toBe("₦90,071,992,547,409.93");
  });

  it("rounds whole naira half up for dashboards", () => {
    expect(formatNaira(64231250n, { whole: true })).toBe("₦642,313");
    expect(formatNaira(64231249n, { whole: true })).toBe("₦642,312");
    expect(formatNaira(50n, { whole: true })).toBe("₦1");
    expect(formatNaira(49n, { whole: true })).toBe("₦0");
    expect(formatNaira(0n, { whole: true })).toBe("₦0");
    expect(formatNaira(100000000n, { whole: true })).toBe("₦1,000,000");
  });

  it("rounds negative whole naira half away from zero and never shows -₦0", () => {
    expect(formatNaira(-50n, { whole: true })).toBe("-₦1");
    expect(formatNaira(-49n, { whole: true })).toBe("₦0");
    expect(formatNaira(-64231250n, { whole: true })).toBe("-₦642,313");
  });
});

describe("koboToMajorString", () => {
  it("gives two-decimal major units without grouping", () => {
    expect(koboToMajorString(64231250n)).toBe("642312.50");
    expect(koboToMajorString(5n)).toBe("0.05");
    expect(koboToMajorString(-5n)).toBe("-0.05");
    expect(koboToMajorString(0n)).toBe("0.00");
    expect(koboToMajorString(100000000000n)).toBe("1000000000.00");
  });

  it("round-trips through parseNairaToKobo", () => {
    for (const kobo of [0n, 1n, 99n, 100n, 64231250n, -1234n, 10n ** 18n]) {
      expect(parseNairaToKobo(koboToMajorString(kobo))).toBe(kobo);
    }
  });
});

describe("allocateKobo", () => {
  it("gives the leftover kobo to the largest remainders, ties to the lower index", () => {
    expect(allocateKobo(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateKobo(1n, [1n, 1n])).toEqual([1n, 0n]);
    expect(allocateKobo(100n, [1n, 2n])).toEqual([33n, 67n]);
    expect(allocateKobo(10n, [3n, 3n, 4n])).toEqual([3n, 3n, 4n]);
  });

  it("handles zero totals and zero weights", () => {
    expect(allocateKobo(0n, [1n, 2n, 3n])).toEqual([0n, 0n, 0n]);
    expect(allocateKobo(100n, [0n, 1n, 1n])).toEqual([0n, 50n, 50n]);
    expect(allocateKobo(101n, [1n, 0n, 1n])).toEqual([51n, 0n, 50n]);
  });

  it("mirrors the positive split for a negative total", () => {
    expect(allocateKobo(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocateKobo(-1n, [1n, 1n])).toEqual([-1n, 0n]);
  });

  it("throws on empty, negative or all-zero weights", () => {
    expect(() => allocateKobo(100n, [])).toThrow(RangeError);
    expect(() => allocateKobo(100n, [1n, -1n])).toThrow(RangeError);
    expect(() => allocateKobo(100n, [0n, 0n])).toThrow(RangeError);
  });

  it("always sums to the total and stays within 1 kobo of each exact share (seeded)", () => {
    // Small deterministic LCG so failures are reproducible.
    let seed = 0x2026n;
    const next = (max: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return (seed >> 16n) % max;
    };
    for (let i = 0; i < 1000; i++) {
      const total = next(10n ** 12n) - 5n * 10n ** 11n;
      const count = Number(next(12n)) + 1;
      const weights = Array.from({ length: count }, () => next(1000n));
      if (weights.every((w) => w === 0n)) weights[0] = 1n;
      const parts = allocateKobo(total, weights);
      expect(parts).toHaveLength(count);
      expect(sumKobo(parts)).toBe(total);
      const weightSum = sumKobo(weights);
      parts.forEach((part, index) => {
        // |part - total * w / W| < 1  <=>  |part * W - total * w| < W
        const diff = part * weightSum - total * (weights[index] ?? 0n);
        expect(diff < 0n ? -diff : diff).toBeLessThan(weightSum);
      });
    }
  });
});

describe("allocateKoboEvenly", () => {
  it("splits evenly with earlier parts taking the extra kobo", () => {
    expect(allocateKoboEvenly(1000n, 3)).toEqual([334n, 333n, 333n]);
    expect(allocateKoboEvenly(-1000n, 3)).toEqual([-334n, -333n, -333n]);
    expect(allocateKoboEvenly(5n, 1)).toEqual([5n]);
  });

  it("throws on a zero, negative or fractional count", () => {
    expect(() => allocateKoboEvenly(100n, 0)).toThrow(RangeError);
    expect(() => allocateKoboEvenly(100n, -1)).toThrow(RangeError);
    expect(() => allocateKoboEvenly(100n, 1.5)).toThrow(RangeError);
  });
});
