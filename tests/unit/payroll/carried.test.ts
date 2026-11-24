/**
 * Slice 5.7c: outstanding carried deductions settled across runs (docs/PHASE_5.md open question
 * 6's default, built by 5.0's engine): net pay never goes below ₦0; what doesn't fit is carried
 * and taken first in the next run, after statutory deductions. src/lib/payroll/carried.ts turns
 * posted payslips into each worker's running balance.
 */
import { describe, expect, it } from "vitest";

import { sumKobo, type Kobo } from "@/lib/money";
import { carriedLedgers, carriedOutstanding, type CarriedSlip } from "@/lib/payroll/carried";
import type { EarningLine } from "@/lib/payroll/earning-lines";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";

const daily = (amountKobo: Kobo): EarningLine => ({
  code: "daily_pay",
  label: "Daily pay",
  amountKobo,
  pensionable: false,
  nhfBase: false,
  taxable: true,
  sources: [],
});

/** A daily worker (no statutory deductions), so the arithmetic is plain. */
function slip(gross: Kobo, carried: Kobo, deductions: Kobo[] = []) {
  return grossToNet(
    {
      employmentType: "daily",
      earnings: [daily(gross)],
      nhfOptIn: false,
      annualRentKobo: 0n,
      deductions: deductions.map((amountKobo, i) => ({
        label: `Salary advance ${i + 1}`,
        amountKobo,
        sources: [],
      })),
      carriedDeductionKobo: carried,
    },
    NTA_2025_V1,
    { itfApplies: false },
  );
}

const settled = (s: ReturnType<typeof slip>) =>
  sumKobo(s.lines.filter((l) => l.code === "carried_deduction").map((l) => l.amountKobo));

const RUNS = [
  { runId: "r1", periodStart: "2026-08-20", periodEnd: "2026-09-19", payDate: "2026-09-25" },
  { runId: "r2", periodStart: "2026-09-20", periodEnd: "2026-10-19", payDate: "2026-10-25" },
  { runId: "r3", periodStart: "2026-10-20", periodEnd: "2026-11-19", payDate: "2026-11-25" },
] as const;

describe("carried deductions settle across runs", () => {
  it("carries what doesn't fit, takes it first next run, and settles it to ₦0", () => {
    // September: ₦50,000 earned, a ₦80,000 advance: ₦50,000 taken, ₦30,000 carried.
    const sep = slip(5_000_000n, 0n, [8_000_000n]);
    expect(sep.netKobo).toBe(0n);
    expect(sep.carriedForwardKobo).toBe(3_000_000n);
    expect(sep.flags).toContain("deduction_cut");
    // October: ₦20,000 earned: the carry takes all of it, ₦10,000 still carried.
    const oct = slip(2_000_000n, sep.carriedForwardKobo);
    expect(settled(oct)).toBe(2_000_000n);
    expect(oct.netKobo).toBe(0n);
    expect(oct.carriedForwardKobo).toBe(1_000_000n);
    // November: ₦50,000 earned: ₦10,000 settles the carry, ₦40,000 paid.
    const nov = slip(5_000_000n, oct.carriedForwardKobo);
    expect(settled(nov)).toBe(1_000_000n);
    expect(nov.netKobo).toBe(4_000_000n);
    expect(nov.carriedForwardKobo).toBe(0n);

    const slips: CarriedSlip[] = [sep, oct, nov].map((s, i) => ({
      workerId: "w1",
      ...RUNS[i]!,
      approvedAt: `${RUNS[i]!.payDate}T09:00:00Z`,
      settledKobo: settled(s),
      carriedForwardKobo: s.carriedForwardKobo,
    }));
    const [ledger] = carriedLedgers(slips);
    expect(ledger!.entries.map((e) => [e.broughtKobo, e.settledKobo, e.addedKobo, e.carriedKobo])).toEqual([
      [0n, 0n, 3_000_000n, 3_000_000n],
      [3_000_000n, 2_000_000n, 0n, 1_000_000n],
      [1_000_000n, 1_000_000n, 0n, 0n],
    ]);
    expect(ledger!.balanceKobo).toBe(0n);
    expect(ledger!.settledKobo).toBe(3_000_000n);
    expect(ledger!.entries.some((e) => e.mismatch)).toBe(false);
    // Taken in total equals what was carried in total: settled once, never twice.
    expect(ledger!.settledKobo).toBe(sumKobo(ledger!.entries.map((e) => e.addedKobo)));
  });

  it("takes the carry before a new deduction and carries the new one's remainder", () => {
    const oct = slip(2_000_000n, 1_500_000n, [1_000_000n]);
    expect(settled(oct)).toBe(1_500_000n);
    expect(oct.otherDeductionsKobo).toBe(2_000_000n);
    expect(oct.carriedForwardKobo).toBe(500_000n);
  });

  it("gives each worker's balance, owing first, and the outstanding total", () => {
    const base = { approvedAt: "2026-10-25T09:00:00Z", ...RUNS[1] };
    const ledgers = carriedLedgers([
      { ...base, workerId: "a", settledKobo: 0n, carriedForwardKobo: 250_000n },
      { ...base, workerId: "b", settledKobo: 0n, carriedForwardKobo: 900_000n },
      { ...base, workerId: "c", settledKobo: 0n, carriedForwardKobo: 0n },
    ]);
    expect(ledgers.map((l) => l.workerId)).toEqual(["b", "a"]);
    expect(carriedOutstanding(ledgers)).toBe(1_150_000n);
  });

  it("orders by pay date then approval, whatever order the rows arrive in", () => {
    const rows: CarriedSlip[] = [
      { workerId: "w", ...RUNS[2], approvedAt: "x", settledKobo: 100n, carriedForwardKobo: 0n },
      { workerId: "w", ...RUNS[0], approvedAt: "x", settledKobo: 0n, carriedForwardKobo: 100n },
    ];
    const [ledger] = carriedLedgers(rows);
    expect(ledger!.entries.map((e) => e.runId)).toEqual(["r1", "r3"]);
    expect(ledger!.balanceKobo).toBe(0n);
  });

  it("marks a payslip that took more than the ledger carried", () => {
    const [ledger] = carriedLedgers([
      { workerId: "w", ...RUNS[0], approvedAt: "x", settledKobo: 500n, carriedForwardKobo: 0n },
    ]);
    expect(ledger!.entries[0]!.mismatch).toBe(true);
  });
});
