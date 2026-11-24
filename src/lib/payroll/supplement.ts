/**
 * Supplementary payout files (slice 5.7c, carried from 5.4). Pure; the same rules as
 * `private.make_payout_supplement`, which checks them again in SQL.
 *
 * A released run's bank file left some workers out (no usable bank details, or a bank change in
 * its 72-hour hold). Their payslips stand and their net pay is outstanding on the Pay step. Once a
 * worker's details are in force (complete, with a bank code, no change waiting or in its hold),
 * a supplementary file pays exactly those workers, each their net pay. A payslip is paid once
 * across the original file and every supplementary one: the original item is left out, and only
 * one supplementary item per payslip stands.
 */

import { sumKobo, type Kobo } from "@/lib/money";

import type { LeftOutReason, PayoutPlanRow } from "./payout";

export interface SupplementRow extends PayoutPlanRow {
  /** The left-out item of the run's bank file this pays. */
  originalItemId: string;
  leftOutReason: LeftOutReason | null;
  /** The database's view: details complete, with a bank code, no change waiting. */
  ready: boolean;
}

export type WaitingReason = "no_bank_details" | "bank_change_in_hold" | "no_bank_code";

export const WAITING_LABEL: Record<WaitingReason, string> = {
  no_bank_details: "No bank details yet",
  bank_change_in_hold: "Bank change waiting or in its 72-hour hold",
  no_bank_code: "No bank code on file",
};

/** Why a row can't be paid yet, or null when it can. */
export function waitingReason(row: SupplementRow): WaitingReason | null {
  const usable =
    row.onFile && row.bankName !== null && row.accountName !== null && row.bankAccountLast4 !== null;
  if (!usable) return "no_bank_details";
  if (row.inHold) return "bank_change_in_hold";
  if (row.bankCode === null) return "no_bank_code";
  return null;
}

export interface SupplementSummary {
  ready: SupplementRow[];
  waiting: { row: SupplementRow; reason: WaitingReason }[];
  readyKobo: Kobo;
  outstandingKobo: Kobo;
}

/**
 * Splits the outstanding items into ready to pay and still waiting. The TypeScript reading and
 * the database's `ready` must agree; a row they disagree on waits (the safer side).
 */
export function summariseSupplement(rows: readonly SupplementRow[]): SupplementSummary {
  const out: SupplementSummary = { ready: [], waiting: [], readyKobo: 0n, outstandingKobo: 0n };
  for (const row of rows) {
    const reason = waitingReason(row);
    if (reason === null && row.ready) {
      out.ready.push(row);
      out.readyKobo += row.netKobo;
    } else {
      out.waiting.push({ row, reason: reason ?? "bank_change_in_hold" });
    }
  }
  out.outstandingKobo = sumKobo(rows.map((r) => r.netKobo));
  return out;
}

/** The refusal when nobody can be paid yet, or null. */
export function supplementRefusal(summary: SupplementSummary): string | null {
  if (summary.ready.length > 0) return null;
  if (summary.waiting.length === 0) return "Nobody is outstanding on this run.";
  return "Nobody left out of this run's bank file has bank details in force yet. Add or approve their details (a second person approves them), then make the file.";
}

export interface SupplementItemPayload {
  payslip_id: string;
  position: number;
  bank_name: string | null;
  bank_code: string | null;
  account_name: string | null;
  bank_account_last4: string | null;
  bank_detail_change_id: string | null;
  amount_kobo: string;
}

/** What `make_payout_supplement` receives for the ready rows: positions and details, no number. */
export function supplementItemsPayloadShape(
  ready: readonly SupplementRow[],
): SupplementItemPayload[] {
  return ready.map((r, i) => ({
    payslip_id: r.payslipId,
    position: i + 1,
    bank_name: r.bankName,
    bank_code: r.bankCode,
    account_name: r.accountName,
    bank_account_last4: r.bankAccountLast4,
    bank_detail_change_id: r.bankDetailChangeId,
    amount_kobo: r.netKobo.toString(),
  }));
}
