/**
 * Gross to net (slice 5.0), beyond the golden fixture: PAYE band edges reached through a whole
 * payslip, the rent relief cap, the pension base, NHF on and off, daily workers, the levies,
 * rounding once per line, deductions cut to fit, and properties that hold for any input.
 * Figures from docs/RULES_NIGERIA.md (confirm with a tax adviser before the first live payroll).
 */
import { describe, expect, it } from "vitest";

import { allocateKobo, applyBps, sumKobo, type Kobo } from "@/lib/money";
import type {
  DeductionLine,
  EarningCode,
  EarningLine,
  GrossToNetInput,
} from "@/lib/payroll/contract";
import { grossToNet, PayrollInputError } from "@/lib/payroll/gross-to-net";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";

const N = (naira: bigint) => naira * 100n;
const ITF_ON = { itfApplies: true };

function earning(
  code: EarningCode,
  amountKobo: Kobo,
  over: Partial<EarningLine> = {},
): EarningLine {
  const salary = code === "basic" || code === "housing" || code === "transport";
  return {
    code,
    label: code,
    amountKobo,
    pensionable: salary,
    nhfBase: code === "basic",
    taxable: true,
    sources: [],
    ...over,
  };
}

/** A monthly salary split 50 / 30 / 20 as the golden test does. */
function salary(grossKobo: Kobo): EarningLine[] {
  const [b, h, t] = allocateKobo(grossKobo, [5n, 3n, 2n]);
  return [earning("basic", b!), earning("housing", h!), earning("transport", t!)];
}

function input(over: Partial<GrossToNetInput> = {}): GrossToNetInput {
  return {
    employmentType: "permanent",
    earnings: salary(N(120_000n)),
    nhfOptIn: false,
    annualRentKobo: 0n,
    deductions: [],
    carriedDeductionKobo: 0n,
    ...over,
  };
}

const run = (over: Partial<GrossToNetInput> = {}, itfApplies = true) =>
  grossToNet(input(over), NTA_2025_V1, { itfApplies });

describe("PAYE band edges through a payslip", () => {
  it("₦800,000 taxable pays nothing; ₦800,001 pays 1 kobo", () => {
    // ₦80,000 gross: 12 × (80,000 − 6,400) = ₦883,200; rent ₦416,000 gives ₦83,200 relief.
    const at = run({ earnings: salary(N(80_000n)), annualRentKobo: N(416_000n) });
    expect(at.trace.find((s) => s.step === "taxable")!.value_kobo).toBe(N(800_000n).toString());
    expect(at.payeKobo).toBe(0n);
    // ₦5 less rent: ₦1 less relief, so ₦800,001 taxable: 15 kobo a year, 1.25 a month → 1.
    const above = run({ earnings: salary(N(80_000n)), annualRentKobo: N(415_995n) });
    expect(above.trace.find((s) => s.step === "taxable")!.value_kobo).toBe(N(800_001n).toString());
    expect(above.payeKobo).toBe(1n);
  });

  it("₦3,000,000 taxable pays ₦27,500 a month", () => {
    // ₦300,000 gross: 12 × 276,000 = ₦3,312,000, less ₦312,000 relief (rent ₦1,560,000).
    const r = run({ earnings: salary(N(300_000n)), annualRentKobo: N(1_560_000n) });
    expect(r.trace.find((s) => s.step === "taxable")!.value_kobo).toBe(N(3_000_000n).toString());
    expect(r.payeKobo).toBe(N(27_500n));
  });

  it("₦50,000,000 taxable pays ₦869,166.67 a month", () => {
    // Basic ₦1,000,000 (pension ₦80,000) and ₦3,250,000 taxable allowance not pensionable:
    // 12 × 4,170,000 = ₦50,040,000, less ₦40,000 relief (rent ₦200,000).
    const r = run({
      earnings: [earning("basic", N(1_000_000n)), earning("adjustment_earning", N(3_250_000n))],
      annualRentKobo: N(200_000n),
    });
    expect(r.pensionEmployeeKobo).toBe(N(80_000n));
    expect(r.trace.find((s) => s.step === "taxable")!.value_kobo).toBe(N(50_000_000n).toString());
    expect(r.payeKobo).toBe(86_916_667n);
    expect(r.trace.filter((s) => s.step === "paye_band")).toHaveLength(5);
  });
});

describe("rent relief", () => {
  it("is 20% of declared rent, capped at ₦500,000", () => {
    const relief = (rent: bigint) =>
      run({ earnings: salary(N(400_000n)), annualRentKobo: N(rent) }).trace.find(
        (s) => s.step === "rent_relief",
      )!;
    expect(relief(360_000n).value_kobo).toBe(N(72_000n).toString());
    expect(relief(2_499_995n).value_kobo).toBe(N(499_999n).toString());
    expect(relief(2_500_000n)).toMatchObject({ value_kobo: N(500_000n).toString() });
    expect(relief(3_000_000n)).toMatchObject({ value_kobo: N(500_000n).toString() });
    expect(relief(3_000_000n).inputs.capped).toBe(true);
    expect(relief(0n).label).toBe("Rent relief (no rent declared)");
  });

  it("gives the same PAYE at ₦2,500,000 and ₦3,000,000 rent", () => {
    const at = run({ earnings: salary(N(400_000n)), annualRentKobo: N(2_500_000n) });
    const over = run({ earnings: salary(N(400_000n)), annualRentKobo: N(3_000_000n) });
    const under = run({ earnings: salary(N(400_000n)), annualRentKobo: N(2_000_000n) });
    expect(at.payeKobo).toBe(over.payeKobo);
    expect(under.payeKobo > at.payeKobo).toBe(true);
    // 12 × (400,000 − 32,000) − 500,000 = ₦3,916,000: 330,000 + 916,000 × 18% = ₦494,880 a year.
    expect(at.payeKobo).toBe(N(41_240n));
  });

  it("keeps a relief worth a fraction of a kobo exact until the month", () => {
    // 20% of 3 kobo is 0.6 kobo: taxable is exact, PAYE rounds once.
    const r = run({ earnings: salary(N(400_000n)), annualRentKobo: 3n });
    const step = r.trace.find((s) => s.step === "rent_relief")!;
    expect(step.inputs.exact_num).toBe("6000");
    expect(step.inputs.exact_den).toBe("10000");
    expect(step.value_kobo).toBe("1");
  });
});

describe("pension base and NHF", () => {
  it("takes pension only on pensionable lines", () => {
    const r = run({
      earnings: [
        ...salary(N(100_000n)),
        earning("overtime", N(20_000n)),
        earning("other_allowances", N(10_000n)),
      ],
    });
    expect(r.pensionEmployeeKobo).toBe(N(8_000n));
    expect(r.pensionEmployerKobo).toBe(N(10_000n));
    // Overtime and other allowances are taxed.
    expect(r.trace.find((s) => s.step === "annual_gross")!.label).toBe("Gross pay (₦130,000 × 12)");
  });

  it("reduces the pension base by a leave deduction marked pensionable", () => {
    const r = run({
      earnings: [
        ...salary(N(100_000n)),
        earning("leave_deduction", -N(10_000n), { pensionable: true }),
      ],
    });
    expect(r.grossKobo).toBe(N(90_000n));
    expect(r.pensionEmployeeKobo).toBe(N(7_200n));
  });

  it("charges NHF 2.5% of basic only when opted in, and deducts it before tax", () => {
    const off = run({ earnings: salary(N(200_000n)) });
    const on = run({ earnings: salary(N(200_000n)), nhfOptIn: true });
    expect(off.nhfKobo).toBe(0n);
    expect(off.lines.some((l) => l.code === "nhf")).toBe(false);
    // Basic ₦100,000 × 2.5% = ₦2,500.
    expect(on.nhfKobo).toBe(N(2_500n));
    expect(on.lines.find((l) => l.code === "nhf")!.amountKobo).toBe(N(2_500n));
    // 12 × 2,500 = ₦30,000 less taxable: ₦4,500 less tax a year at 15%, ₦375 a month.
    expect(off.payeKobo - on.payeKobo).toBe(N(375n));
    expect(on.netKobo).toBe(off.netKobo - N(2_500n) + N(375n));
  });
});

describe("daily workers", () => {
  it("pay no PAYE, pension, NHF, NSITF or ITF; employer cost is gross", () => {
    const r = run({
      employmentType: "daily",
      earnings: [earning("daily_pay", N(150_000n)), earning("overtime", N(5_000n))],
      nhfOptIn: true,
      annualRentKobo: N(600_000n),
    });
    expect(r.grossKobo).toBe(N(155_000n));
    expect([
      r.payeKobo,
      r.pensionEmployeeKobo,
      r.nhfKobo,
      r.pensionEmployerKobo,
      r.nsitfKobo,
      r.itfKobo,
    ]).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    expect(r.netKobo).toBe(N(155_000n));
    expect(r.employerCostKobo).toBe(N(155_000n));
    expect(r.lines.every((l) => l.kind === "earning")).toBe(true);
    expect(r.trace.some((s) => s.step === "daily_worker")).toBe(true);
  });

  it("still take other deductions, cut to fit", () => {
    const r = run({
      employmentType: "daily",
      earnings: [earning("daily_pay", N(10_000n))],
      deductions: [{ label: "Salary advance 1 of 2", amountKobo: N(15_000n), sources: [] }],
    });
    expect(r.netKobo).toBe(0n);
    expect(r.otherDeductionsKobo).toBe(N(10_000n));
    expect(r.carriedForwardKobo).toBe(N(5_000n));
    expect(r.flags).toEqual(["deduction_cut"]);
  });
});

describe("levies and rounding", () => {
  it("rounds each line once, half up", () => {
    // Pension base 3,333,333 kobo.
    const r = run({ earnings: [earning("basic", 3_333_333n)] });
    expect(r.pensionEmployeeKobo).toBe(266_667n); // 266,666.64
    expect(r.pensionEmployerKobo).toBe(333_333n); // 333,333.3
    expect(r.nsitfKobo).toBe(33_333n); // 33,333.33
    expect(r.itfKobo).toBe(33_333n);
    // 8% of 6,250,006 kobo = 500,000.48 → 500,000; of 6,250,007 = 500,000.56 → 500,001.
    expect(run({ earnings: [earning("basic", 6_250_006n)] }).pensionEmployeeKobo).toBe(500_000n);
    expect(run({ earnings: [earning("basic", 6_250_007n)] }).pensionEmployeeKobo).toBe(500_001n);
    // An exact half rounds up: 1% of 50 kobo = 0.5 → 1.
    expect(run({ earnings: [earning("other_allowances", 50n)] }).nsitfKobo).toBe(1n);
  });

  it("charges ITF only when it applies", () => {
    const off = run({}, false);
    expect(off.itfKobo).toBe(0n);
    expect(off.lines.some((l) => l.code === "itf")).toBe(false);
    expect(off.employerCostKobo).toBe(N(120_000n + 12_000n + 1_200n));
  });
});

describe("deductions after tax", () => {
  const advance = (naira: bigint, label = "Salary advance 1 of 3"): DeductionLine => ({
    label,
    amountKobo: N(naira),
    sources: [{ kind: "adjustment", id: label }],
  });

  it("come off after tax and never change PAYE", () => {
    const plain = run();
    const r = run({ deductions: [advance(10_000n)] });
    expect(r.payeKobo).toBe(plain.payeKobo);
    expect(r.netKobo).toBe(plain.netKobo - N(10_000n));
    expect(r.otherDeductionsKobo).toBe(N(10_000n));
    expect(r.flags).toEqual([]);
  });

  it("take the carried deduction first, then in the order added, each cut to fit", () => {
    // Musa Ibrahim's ₦104,740 after tax and pension.
    const r = run({
      annualRentKobo: N(360_000n),
      carriedDeductionKobo: N(50_000n),
      deductions: [advance(40_000n, "Advance"), advance(30_000n, "Uniform")],
    });
    const taken = r.lines
      .filter((l) => l.kind === "deduction")
      .map((l) => [l.code, l.label, l.amountKobo]);
    expect(taken).toEqual([
      ["carried_deduction", "Outstanding deduction from earlier pay", N(50_000n)],
      ["deduction", "Advance", N(40_000n)],
      ["deduction", "Uniform", N(14_740n)],
    ]);
    expect(r.netKobo).toBe(0n);
    expect(r.carriedForwardKobo).toBe(N(15_260n));
    expect(r.flags).toEqual(["deduction_cut"]);
  });
});

describe("refuses impossible input", () => {
  it("a negative earning other than leave, a positive leave deduction, or negative gross", () => {
    expect(() => run({ earnings: [earning("overtime", -1n)] })).toThrow(PayrollInputError);
    expect(() => run({ earnings: [earning("leave_deduction", 1n)] })).toThrow(PayrollInputError);
    expect(() =>
      run({ earnings: [earning("basic", N(1_000n)), earning("leave_deduction", -N(2_000n))] }),
    ).toThrow(PayrollInputError);
    expect(() => run({ deductions: [{ label: "x", amountKobo: -1n, sources: [] }] })).toThrow(
      PayrollInputError,
    );
    expect(() => run({ carriedDeductionKobo: -1n })).toThrow(PayrollInputError);
    expect(() => run({ annualRentKobo: -1n })).toThrow(PayrollInputError);
  });
});

describe("properties for any input", () => {
  // A small deterministic generator (no extra dependency).
  let seed = 20261122n;
  const next = (max: bigint): bigint => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return (seed >> 16n) % (max + 1n);
  };
  const codes: EarningCode[] = [
    "basic",
    "housing",
    "transport",
    "other_allowances",
    "overtime",
    "off_day",
    "adjustment_earning",
  ];

  const cases = Array.from({ length: 400 }, () => {
    const earnings = salary(next(N(3_000_000n)));
    const extra = Number(next(3n));
    for (let i = 0; i < extra; i++) {
      const code = codes[Number(next(BigInt(codes.length - 1)))]!;
      earnings.push(earning(code, next(N(200_000n)), { taxable: next(4n) > 0n }));
    }
    return input({
      employmentType: next(9n) === 0n ? "daily" : "permanent",
      earnings,
      nhfOptIn: next(1n) === 1n,
      annualRentKobo: next(N(4_000_000n)),
      deductions: Array.from({ length: Number(next(2n)) }, (_, i) => ({
        label: `D${i}`,
        amountKobo: next(N(500_000n)),
        sources: [],
      })),
      carriedDeductionKobo: next(3n) === 0n ? next(N(100_000n)) : 0n,
    });
  });

  it("net + deductions = gross, nothing is negative, and the lines add up", () => {
    for (const c of cases) {
      const r = grossToNet(c, NTA_2025_V1, ITF_ON);
      expect(
        r.netKobo + r.payeKobo + r.pensionEmployeeKobo + r.nhfKobo + r.otherDeductionsKobo,
      ).toBe(r.grossKobo);
      expect(r.otherDeductionsKobo + r.carriedForwardKobo).toBe(
        sumKobo(c.deductions.map((d) => d.amountKobo)) + c.carriedDeductionKobo,
      );
      for (const v of [
        r.netKobo,
        r.payeKobo,
        r.pensionEmployeeKobo,
        r.nhfKobo,
        r.nsitfKobo,
        r.itfKobo,
        r.carriedForwardKobo,
      ]) {
        expect(v >= 0n).toBe(true);
      }
      const byKind = (k: string) =>
        sumKobo(r.lines.filter((l) => l.kind === k).map((l) => l.amountKobo));
      expect(byKind("earning")).toBe(r.grossKobo);
      expect(byKind("statutory")).toBe(r.payeKobo + r.pensionEmployeeKobo + r.nhfKobo);
      expect(byKind("deduction")).toBe(r.otherDeductionsKobo);
      expect(byKind("employer")).toBe(r.pensionEmployerKobo + r.nsitfKobo + r.itfKobo);
      expect(r.employerCostKobo).toBe(r.grossKobo + byKind("employer"));
      expect(r.flags.includes("deduction_cut")).toBe(r.carriedForwardKobo > 0n);
    }
  });

  it("rounds each statutory line once from its base", () => {
    for (const c of cases) {
      if (c.employmentType === "daily") continue;
      const r = grossToNet(c, NTA_2025_V1, ITF_ON);
      const base = sumKobo(c.earnings.filter((e) => e.pensionable).map((e) => e.amountKobo));
      expect(r.pensionEmployeeKobo).toBe(applyBps(base, 800));
      expect(r.pensionEmployerKobo).toBe(applyBps(base, 1000));
      expect(r.nsitfKobo).toBe(applyBps(r.grossKobo, 100));
      expect(r.itfKobo).toBe(applyBps(r.grossKobo, 100));
      const nhfBase = sumKobo(c.earnings.filter((e) => e.nhfBase).map((e) => e.amountKobo));
      expect(r.nhfKobo).toBe(c.nhfOptIn ? applyBps(nhfBase, 250) : 0n);
    }
  });

  it("allocations sum to the whole", () => {
    for (let i = 0; i < 200; i++) {
      const total = next(N(5_000_000n));
      expect(sumKobo(allocateKobo(total, [5n, 3n, 2n]))).toBe(total);
    }
  });

  it("PAYE never falls as gross rises", () => {
    for (const rent of [0n, N(360_000n), N(3_000_000n)]) {
      let last = -1n;
      for (let g = 0n; g <= N(6_000_000n); g += N(12_345n)) {
        const paye = run({ earnings: salary(g), annualRentKobo: rent }).payeKobo;
        expect(paye >= last).toBe(true);
        last = paye;
      }
    }
  });
});
