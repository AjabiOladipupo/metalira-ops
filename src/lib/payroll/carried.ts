/**
 * Outstanding carried deductions (slice 5.7c, docs/PHASE_5.md open question 6). Pure.
 *
 * Open question 6's default, which 5.0's engine builds: net pay is never negative. Statutory
 * deductions come first, then the carried deduction, then other deductions in the order added,
 * each cut to what fits; what doesn't fit is carried to the next run (`carried_forward_kobo`) and
 * settled there first. Whether Nigerian law caps total deductions from wages is a question for the
 * tax adviser (flagged on the open question); the app never invents a cap.
 *
 * This file turns a worker's posted payslips into a running balance, run by run:
 *   brought forward  the balance after the payslip before (0 for the first)
 *   settled          the carried_deduction lines this payslip took
 *   added            deductions this payslip couldn't fit (carried − (brought − settled))
 *   carried forward  the balance after this payslip (its carried_forward_kobo)
 * `added` is negative only if a payslip settled from a balance this ledger doesn't hold (a carry
 * taken from a different payslip); the entry is marked so the screen can say so.
 */

import { sumKobo, type Kobo } from "@/lib/money";

export interface CarriedSlip {
  workerId: string;
  runId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  /** Orders two runs paid on one date (approval time, as my_payslips orders them). */
  approvedAt: string;
  /** Σ carried_deduction lines of this payslip (what it settled). */
  settledKobo: Kobo;
  /** carried_forward_kobo of this payslip (the balance after it). */
  carriedForwardKobo: Kobo;
}

export interface CarriedEntry {
  runId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  broughtKobo: Kobo;
  settledKobo: Kobo;
  addedKobo: Kobo;
  carriedKobo: Kobo;
  /** The payslip settled more than the balance this ledger holds. */
  mismatch: boolean;
}

export interface CarriedLedger {
  workerId: string;
  entries: CarriedEntry[];
  /** What is still owed after the latest posted payslip. */
  balanceKobo: Kobo;
  /** Σ settled over the entries. */
  settledKobo: Kobo;
}

const order = (a: CarriedSlip, b: CarriedSlip) =>
  a.payDate.localeCompare(b.payDate) ||
  a.approvedAt.localeCompare(b.approvedAt) ||
  a.runId.localeCompare(b.runId);

/**
 * Each worker's running balance from their posted payslips, in pay order. Only workers who ever
 * carried or settled something are returned; their entries start at the first payslip that did.
 */
export function carriedLedgers(slips: readonly CarriedSlip[]): CarriedLedger[] {
  const byWorker = new Map<string, CarriedSlip[]>();
  for (const s of slips) {
    byWorker.set(s.workerId, [...(byWorker.get(s.workerId) ?? []), s]);
  }
  const out: CarriedLedger[] = [];
  for (const [workerId, list] of byWorker) {
    list.sort(order);
    const entries: CarriedEntry[] = [];
    let brought: Kobo = 0n;
    for (const s of list) {
      if (brought === 0n && s.settledKobo === 0n && s.carriedForwardKobo === 0n) continue;
      const added = s.carriedForwardKobo - (brought - s.settledKobo);
      entries.push({
        runId: s.runId,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        payDate: s.payDate,
        broughtKobo: brought,
        settledKobo: s.settledKobo,
        addedKobo: added,
        carriedKobo: s.carriedForwardKobo,
        mismatch: added < 0n || s.settledKobo > brought,
      });
      brought = s.carriedForwardKobo;
    }
    if (entries.length === 0) continue;
    out.push({
      workerId,
      entries,
      balanceKobo: brought,
      settledKobo: sumKobo(entries.map((e) => e.settledKobo)),
    });
  }
  return out.sort(
    (a, b) => (b.balanceKobo > a.balanceKobo ? 1 : b.balanceKobo < a.balanceKobo ? -1 : 0) ||
      a.workerId.localeCompare(b.workerId),
  );
}

/** Σ balances still owed across the workers. */
export function carriedOutstanding(ledgers: readonly CarriedLedger[]): Kobo {
  return sumKobo(ledgers.map((l) => l.balanceKobo));
}
