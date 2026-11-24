/**
 * The reversal's sign convention (slice 5.7a, migration 20261122180000). Pure.
 *
 * Payslip, line and run amounts are stored non-negative (5.2's checks), so a reversal run's
 * copies keep the original's amounts as written and carry `sign = -1`. The signed value of a
 * copy is sign x amount, so a run and its reversal sum to zero, to the kobo, and the reversal's
 * totals are minus the original's. Never a float: every amount is a bigint of kobo.
 */
import type { Kobo } from "@/lib/money";

import type { RunTotals } from "./run";

export type Sign = 1 | -1;

/** The money fields a payslip and a run share (RunTotals without the count). */
export const MONEY_FIELDS = [
  "grossKobo",
  "payeKobo",
  "pensionEmployeeKobo",
  "pensionEmployerKobo",
  "nhfKobo",
  "otherDeductionsKobo",
  "netKobo",
  "nsitfKobo",
  "itfKobo",
  "employerCostKobo",
  "carriedForwardKobo",
] as const satisfies readonly (keyof RunTotals)[];

export type MoneyField = (typeof MONEY_FIELDS)[number];
export type Amounts = Record<MoneyField, Kobo>;

/** A stored payslip (or line set) with its sign. */
export interface SignedAmounts {
  sign: Sign;
  amounts: Amounts;
}

/** The reversal's copy of a stored payslip: the same amounts, sign -1. */
export function reversalCopy(original: Amounts): SignedAmounts {
  if (MONEY_FIELDS.some((f) => original[f] < 0n)) {
    throw new RangeError("Stored payslip amounts are never negative");
  }
  return { sign: -1, amounts: { ...original } };
}

/** A stored amount's signed value. */
export function signed(sign: Sign, amount: Kobo): Kobo {
  return sign === -1 ? -amount : amount;
}

/** The signed sum of each money field over stored payslips. */
export function signedTotals(slips: readonly SignedAmounts[]): Amounts {
  const out = Object.fromEntries(MONEY_FIELDS.map((f) => [f, 0n])) as Amounts;
  for (const s of slips) {
    for (const f of MONEY_FIELDS) out[f] += signed(s.sign, s.amounts[f]);
  }
  return out;
}

/** A run's totals as a reversal shows them: every money field negated. */
export function negatedTotals(totals: RunTotals): RunTotals {
  const out = { ...totals };
  for (const f of MONEY_FIELDS) out[f] = -totals[f];
  return out;
}
