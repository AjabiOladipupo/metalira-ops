/**
 * What each payroll anomaly says on the run's Anomalies step (slice 5.2). Pure. Sentence case,
 * numbers first, no personal numbers: the detail holds ids, dates, counts and percentages.
 */

import { formatDate } from "@/lib/dates";
import { formatNaira } from "@/lib/money";

export interface AnomalyText {
  title: string;
  body: string;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function num(detail: Record<string, unknown>, key: string): number {
  const v = detail[key];
  return typeof v === "number" ? v : 0;
}

function str(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key];
  return typeof v === "string" ? v : null;
}

/**
 * The title and one-line body of an anomaly. `who` is the worker's name (or null for a run-level
 * one); `names` resolves worker ids in a shared-account group.
 */
export function describeAnomaly(
  code: string,
  detail: Record<string, unknown>,
  who: string | null,
  names: (workerId: string) => string = () => "A worker",
): AnomalyText {
  const name = who ?? "A worker";
  switch (code) {
    case "no_pay_rate":
      return {
        title: `No pay rate for part of the cycle · ${name}`,
        body: "Add a pay rate on their page, then recalculate. This blocks the run.",
      };
    case "no_rostered_days":
      return {
        title: `No rostered working days · ${name}`,
        body: "Nothing in the roster, their usual days or the company's days counts as a working day. Fix the working week, then recalculate. This blocks the run.",
      };
    case "no_tax_state":
      return {
        title: `No tax state · ${name}`,
        body: "PAYE goes to the worker's tax state. Add it on their page, then recalculate. This blocks the run.",
      };
    case "calculation_failed":
      if (detail.deduction_cut === true && detail.carry_settled_later === true) {
        // Slice 5.8: a later posted run already carried this worker on, so a new carry is lost.
        const later = str(detail, "period_start");
        return {
          title: `Deduction larger than the payment · ${name}`,
          body: `A later run${later ? ` (from ${formatDate(later)})` : ""} already settled this worker's carried deductions, so nothing this run cuts can carry forward. Lower or remove the deduction so it fits what the run pays. This blocks the run.`,
        };
      }
      if (detail.deduction_cut === true) {
        // Slice 5.7b: a correction or one-off run can't carry a deduction to a later run.
        return {
          title: `Deduction larger than the payment · ${name}`,
          body: "On a correction or one-off run, deductions must fit what the run pays: nothing is carried to a later run. Lower or remove the deduction, or take it in the regular run. This blocks the run.",
        };
      }
      return {
        title: `Pay can't be worked out · ${name}`,
        body: "A leave deduction or a statutory deduction is larger than their pay. Check their leave and pay rate, then recalculate. This blocks the run.",
      };
    case "roster_pattern_unknown":
      return {
        title: `Working week guessed · ${name}`,
        body: "Days outside their employment were counted on the company's working days, because their own pattern isn't clear from the roster. Check the proration.",
      };
    case "leave_pay_missing":
      return {
        title: `Leave without a pay record · ${name}`,
        body: "An approved leave request has no pay percentage, so nothing was deducted for it. Check it with HR.",
      };
    case "open_timesheet_days": {
      const days = num(detail, "days");
      const reasons = Array.isArray(detail.reasons)
        ? (detail.reasons as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      return {
        title: `${plural(days, "timesheet day")} still open · ${str(detail, "site_name") ?? (str(detail, "site_id") ? "A site" : "No site")}`,
        body: `Pending or disputed days aren't paid in this run.${reasons.length > 0 ? ` Flags: ${reasons.join(", ").replace(/_/g, " ")}.` : ""} Acknowledge to pay them next run.`,
      };
    }
    case "no_show_days":
      return {
        title: `${plural(num(detail, "days"), "no-show day")} · ${name}`,
        body: "No pay is docked automatically. Add a deduction with a reason if the company docks pay.",
      };
    case "bank_missing":
      return {
        title: `No bank details · ${name}`,
        body: "Their pay can't go in the bank file until details are added and approved.",
      };
    case "bank_in_hold": {
      const ends = str(detail, "ends_at");
      return {
        title: `Bank details changing · ${name}`,
        body: ends
          ? `A new account is inside the 72-hour hold until ${formatDate(ends.slice(0, 10))}. Their pay uses the account on file until then.`
          : "A change to their bank details is waiting for a second approver.",
      };
    }
    case "bank_not_checked":
      return {
        title: `Bank details not checked · ${name}`,
        body: "The account came from the first import and was never checked with the bank. Check it on their page before the bank file.",
      };
    case "bank_unreadable":
      return {
        title: `Bank details can't be read · ${name}`,
        body: "The stored account number didn't pass its integrity check, so it was left out of the shared-account check. Ask HR to enter it again.",
      };
    case "bank_shared": {
      const ids = Array.isArray(detail.worker_ids)
        ? (detail.worker_ids as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      const count = Math.max(num(detail, "workers"), ids.length);
      const who2 = ids.map(names);
      const more = count > ids.length ? ` and ${count - ids.length} more` : "";
      return {
        title: `Shared bank account · ${plural(count, "worker")}`,
        body: `${who2.join(more ? ", " : " and ")}${more} share one account number. Check before approving.`,
      };
    }
    case "bank_shared_unchecked":
      return {
        title: "Shared accounts not checked",
        body: "The encryption key isn't set on this server, so account numbers couldn't be compared. Check for shared accounts another way.",
      };
    case "first_pay": {
      const start = str(detail, "start_date");
      return {
        title: `First pay · ${name}`,
        body: start
          ? `Joined ${formatDate(start)}. Pay is prorated by rostered days.`
          : "Their first payslip.",
      };
    }
    case "final_pay": {
      const end = str(detail, "end_date");
      return {
        title: `Final pay · ${name}`,
        body: end
          ? `Leaves ${formatDate(end)}. Pay is prorated to their last day.`
          : "Their last payslip.",
      };
    }
    case "net_change": {
      const pct = num(detail, "percent");
      return {
        title: `${pct >= 0 ? "Up" : "Down"} ${Math.abs(pct)}% on last month · ${name}`,
        body: "Net pay moved more than 10% from their last posted payslip. Explain shows why.",
      };
    }
    case "deduction_cut":
      return {
        title: `Net pay cut to ₦0 · ${name}`,
        body: "Deductions were cut so net pay isn't negative; the rest carries to the next run.",
      };
    case "no_pension_details": {
      const missing = [detail.no_pfa ? "PFA" : null, detail.no_rsa_pin ? "RSA PIN" : null].filter(
        Boolean,
      );
      return {
        title: `No ${missing.join(" or ") || "pension details"} · ${name}`,
        body: "Pension is due this month. Add the details on their page before the pension schedule.",
      };
    }
    case "previous_not_posted": {
      const start = str(detail, "period_start");
      return {
        title: "The period before isn't posted",
        body: `The run${start ? ` from ${formatDate(start)}` : ""} isn't approved yet, so carried deductions and the 10% check can't be known. Approve it first, then recalculate. This blocks the run.`,
      };
    }
    case "recurring_not_carried":
      return {
        title: `Recurring item not carried · ${name}`,
        body: `Instalment ${num(detail, "next")} of ${num(detail, "of")} from the period before isn't on this run, because that run wasn't posted when this one was prepared. Use Carry next instalment below if it's due: it continues the same series, so it is never deducted twice.`,
      };
    case "on_off_cycle_run":
      // Slice 5.7b, money review L4.
      return {
        title: `On an off-cycle run not yet approved · ${name}`,
        body: "Left out of this run because a final-pay or missed-worker run for this period pays them, and that run isn't approved yet. Approve it, or discard it and recalculate this run, so they're paid once.",
      };
    case "leave_correction_pending":
      // Slice 5.7c, money review M4.
      return {
        title: `Leave correction waiting, not in this run · ${name}`,
        body: `${num(detail, "arrears")} leave arrears and ${num(detail, "refunds")} leave refunds are waiting for this worker, who isn't in this run (they left, or a final-pay or missed-worker run pays them). Settle it with a correction run, or on their final pay.`,
      };
    case "carry_settled_later": {
      // Slice 5.8: a full-pay off-cycle run for an earlier period than a posted run.
      const later = str(detail, "period_start");
      return {
        title: `Carried deduction already taken · ${name}`,
        body: `The run${later ? ` for the period from ${formatDate(later)}` : " of a later period"} already took this worker's carried deductions, so this run takes none.`,
      };
    }
    case "refund_uncollected_carry": {
      // Slice 5.8 (owner decision): a leave refund pays back arrears never recovered.
      // Whole naira in thousands groups ("20,000"), and kobo.
      const naira = str(detail, "naira")?.replace(/,/g, "") ?? null;
      const amount =
        naira !== null && /^\d{1,15}$/.test(naira)
          ? BigInt(naira) * 100n + BigInt(Math.trunc(num(detail, "kobo")))
          : null;
      return {
        title: `Refund includes ${amount === null ? "an amount" : formatNaira(amount)} not yet recovered from carried deductions · ${name}`,
        body: "The leave refund pays back the arrears in full, but part of them is still in this worker's carried deductions. Check it before submitting.",
      };
    }
    // Slice 5.9a: the tax adviser's answers of 24 Nov 2026.
    case "deduction_capped":
      return {
        title: `Other deductions capped at a third of gross · ${name}`,
        body: "Other deductions capped at a third of gross; the rest carries forward (Labour Act s.5(7)). PAYE, pension and NHF came off in full.",
      };
    case "paye_overwithheld":
      return {
        title: `More PAYE withheld this year than is due · ${name}`,
        body: "PAYE already withheld this tax year is more than the tax due to date, so this payslip withholds ₦0. Explain shows the amount over; settle it with your tax adviser.",
      };
    case "nhf_not_deducted": {
      const why =
        detail.no_number === true
          ? "no NHF number is on file. Add it on their page, then recalculate"
          : detail.below_minimum_wage === true
            ? "their regular monthly pay is below the minimum wage"
            : "the NHF conditions aren't met";
      return {
        title: `NHF not taken · ${name}`,
        body: `Opted in to NHF, but ${why}.`,
      };
    }
    case "paye_not_withheld": {
      const amount =
        typeof detail.naira === "string"
          ? `₦${detail.naira}${typeof detail.kobo === "number" && detail.kobo > 0 ? `.${String(detail.kobo).padStart(2, "0")}` : ""}`
          : "Some PAYE";
      return {
        title: `PAYE ${amount} couldn't be withheld this month · ${name}`,
        body:
          detail.year_end === true
            ? "This payslip can't pay all the PAYE due to date, and it is their last payslip of the tax year, so it needs settling at year end."
            : "This payslip can't pay all the PAYE due to date; it will be caught up next month by the year-to-date maths.",
      };
    }
    case "recovery_carried":
      return {
        title: `Clawback larger than this month's pay · ${name}`,
        body: "What this month's pay could bear came off before tax; the rest is carried forward and comes off after tax in later runs.",
      };
    case "rent_relief_unverified":
      return {
        title: `Rent relief not applied: proof not verified · ${name}`,
        body: "Rent is declared, but no tenancy agreement, receipts and payment record are verified for this tax year. Add and verify them on their page, then recalculate.",
      };
    default:
      return {
        title: `${code.replace(/_/g, " ")} · ${name}`,
        body: "Check this before submitting.",
      };
  }
}
