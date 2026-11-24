/**
 * Who a payroll run's bank file pays (slice 5.4, docs/PHASE_5.md decision 11). Pure; the same
 * rules as `private.make_payout_batch`, which checks them again in SQL. Never sees an account
 * number: the server checks the decrypted number's last 4 digits separately.
 *
 *   net ₦0                                   left out: nothing_to_pay
 *   no usable details on file                left out (no_bank_details) when HR acknowledged a
 *                                            bank anomaly for the worker on this run; else refused
 *   a change waiting or in its 72-hour hold  left out (bank_change_in_hold) when HR acknowledged a
 *                                            bank anomaly; else paid to the account in force
 *   no bank code                             refused
 *   otherwise                                paid: net pay, to the details in force now
 */

import type { Kobo } from "@/lib/money";

export const LEFT_OUT_REASONS = [
  "no_bank_details",
  "bank_change_in_hold",
  "nothing_to_pay",
] as const;
export type LeftOutReason = (typeof LEFT_OUT_REASONS)[number];

export const LEFT_OUT_LABEL: Record<LeftOutReason, string> = {
  no_bank_details: "No bank details · not in this file",
  bank_change_in_hold: "Bank change in its 72-hour hold · not in this file",
  nothing_to_pay: "Net pay ₦0 · not in this file",
};

export interface PayoutPlanRow {
  payslipId: string;
  workerId: string;
  workerName: string;
  staffId: string;
  netKobo: Kobo;
  bankName: string | null;
  bankCode: string | null;
  accountName: string | null;
  bankAccountLast4: string | null;
  bankDetailChangeId: string | null;
  /** An encrypted account number is on file (as of now). */
  onFile: boolean;
  /** A bank-detail change is waiting for its second approver or inside its 72-hour hold. */
  inHold: boolean;
  /** The bank anomaly HR acknowledged for this worker on the run, if any. */
  acknowledgedCode: string | null;
}

export type PayoutDecision =
  | { kind: "pay" }
  | { kind: "left_out"; reason: LeftOutReason }
  | { kind: "refuse"; reason: "no_details" | "no_code" };

export function decidePayout(row: PayoutPlanRow): PayoutDecision {
  const usable =
    row.onFile &&
    row.bankName !== null &&
    row.accountName !== null &&
    row.bankAccountLast4 !== null;
  const acknowledged = row.acknowledgedCode !== null;
  if (row.netKobo === 0n) return { kind: "left_out", reason: "nothing_to_pay" };
  if (!usable) {
    return acknowledged
      ? { kind: "left_out", reason: "no_bank_details" }
      : { kind: "refuse", reason: "no_details" };
  }
  if (row.inHold && acknowledged) return { kind: "left_out", reason: "bank_change_in_hold" };
  if (row.bankCode === null) return { kind: "refuse", reason: "no_code" };
  return { kind: "pay" };
}

/** "Musa Ibrahim, Grace Edet and 3 more": at most five names. */
export function nameList(names: readonly string[]): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= 5) return sorted.join(", ");
  return `${sorted.slice(0, 5).join(", ")} and ${sorted.length - 5} more`;
}

export interface PayoutPlanSummary {
  paid: PayoutPlanRow[];
  leftOut: { row: PayoutPlanRow; reason: LeftOutReason }[];
  noDetails: string[];
  noCode: string[];
  totalKobo: Kobo;
}

/** Splits the plan into paid, left out and refused (by name), keeping the plan's order. */
export function summarisePlan(rows: readonly PayoutPlanRow[]): PayoutPlanSummary {
  const out: PayoutPlanSummary = {
    paid: [],
    leftOut: [],
    noDetails: [],
    noCode: [],
    totalKobo: 0n,
  };
  for (const row of rows) {
    const d = decidePayout(row);
    if (d.kind === "pay") {
      out.paid.push(row);
      out.totalKobo += row.netKobo;
    } else if (d.kind === "left_out") out.leftOut.push({ row, reason: d.reason });
    else if (d.reason === "no_details") out.noDetails.push(row.workerName);
    else out.noCode.push(row.workerName);
  }
  return out;
}

/** The refusal for workers who can't be paid, by name, or null when everyone can. */
export function planRefusal(summary: PayoutPlanSummary): string | null {
  if (summary.noDetails.length > 0) {
    return `No bank details for ${nameList(summary.noDetails)}, and HR didn't acknowledge it on this run. Add their details (a second person approves them) and make the file again.`;
  }
  if (summary.noCode.length > 0) {
    return `No bank code for ${nameList(summary.noCode)}. Check their bank details on their page, then make the file again.`;
  }
  if (summary.paid.length === 0) return "Nobody in this run can be paid by bank file.";
  return null;
}

/** "•••• 7712" */
export function maskedLast4(last4: string | null): string {
  return last4 ? `•••• ${last4}` : "Not on file";
}
