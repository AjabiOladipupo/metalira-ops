import { formatNaira, roundHalfUp, type Kobo } from "@/lib/money";

/**
 * Leavers' final-pay items (slice 5.9c, docs/RULES_NIGERIA.md adviser answer 19). Pure.
 *
 * A final-pay off-cycle run (slice 5.7b) takes typed items instead of a generic one-off earning.
 * Each item becomes one or two `payroll_adjustments` earning rows (written by the database's
 * `add_final_pay_item`), carrying the `taxable` and `pensionable` flags the gross-to-net engine
 * already honours, so the engine itself doesn't change:
 *
 * | Item                     | Calculation                          | Tax                         | Pension |
 * | ------------------------ | ------------------------------------ | --------------------------- | ------- |
 * | Pay in lieu of leave     | untaken days × basic daily rate      | taxable                     | no      |
 * | Pay in lieu of notice    | notice days × basic daily rate       | taxable, unless part of a   | no      |
 * |                          |                                      | loss-of-office settlement   |         |
 * | Gratuity                 | entered by HR (contract)             | taxable                     | no      |
 * | Redundancy or loss of    | entered by HR (negotiated)           | exempt up to the cap (₦50m, | no      |
 * | employment               |                                      | per worker, cumulative)     |         |
 *
 * The basic daily rate is the basic monthly pay of the pay version in force on the worker's last
 * day ÷ the company's `hourly_rate_divisor_days` (20): the divisor the pay policy already uses
 * for the normal rate. The adviser says "basic daily rate" without defining it, so this is a
 * product reading (flagged in RULES_NIGERIA.md). Daily and hourly pay rates get no pre-fill.
 */

export const FINAL_PAY_ITEM_TYPES = [
  "leave_in_lieu",
  "notice_in_lieu",
  "gratuity",
  "loss_of_office",
] as const;
export type FinalPayItemType = (typeof FINAL_PAY_ITEM_TYPES)[number];

export interface FinalPayItemRule {
  label: string;
  /** When it is owed, for the form. */
  owed: string;
  calculation: string;
  tax: string;
  /** Every final-pay item is left out of the pension base (adviser answer 19). */
  pensionable: false;
  /** Days × basic daily rate, pre-filled. */
  byDays: boolean;
  source: string;
}

export const FINAL_PAY_ITEMS: Record<FinalPayItemType, FinalPayItemRule> = {
  leave_in_lieu: {
    label: "Pay in lieu of untaken leave",
    owed: "Owed by law after 6 months' continuous service (Labour Act s.18(4)).",
    calculation: "Untaken annual leave days × basic daily rate, from the leave balance.",
    tax: "Taxable. Not pensionable.",
    pensionable: false,
    byDays: true,
    source: "Labour Act s.18(4); tax adviser, answer 19",
  },
  notice_in_lieu: {
    label: "Pay in lieu of notice",
    owed: "Owed where notice isn't given (Labour Act s.11(6) to (9)).",
    calculation: "Notice days × basic daily rate.",
    tax: "Taxable, unless part of a redundancy or loss-of-office settlement. Not pensionable.",
    pensionable: false,
    byDays: true,
    source: "Labour Act s.11(6) to (9); tax adviser, answer 19",
  },
  gratuity: {
    label: "Gratuity",
    owed: "Only if the employment contract provides for it.",
    calculation: "The amount the contract gives, entered by HR.",
    tax: "Taxable. Not pensionable.",
    pensionable: false,
    byDays: false,
    source: "Employment contract; tax adviser, answer 19",
  },
  loss_of_office: {
    label: "Redundancy or loss-of-office compensation",
    owed: "Redundancy (Labour Act s.20); the amount is negotiated.",
    calculation: "The negotiated amount, entered by HR.",
    tax: "Exempt up to the cap a worker (₦50,000,000); only the excess is taxable. Not pensionable.",
    pensionable: false,
    byDays: false,
    source: "Labour Act s.20; tax adviser, answer 19",
  },
};

export function isFinalPayItemType(v: unknown): v is FinalPayItemType {
  return typeof v === "string" && (FINAL_PAY_ITEM_TYPES as readonly string[]).includes(v);
}

/** The starting cap, as stored on every rule set version (`loss_of_office_exempt_kobo`). */
export const LOSS_OF_OFFICE_EXEMPT_DEFAULT_KOBO: Kobo = 5_000_000_000n;

/** Months of continuous service from the start date to the last day, whole months only. */
export function serviceMonths(startDate: string, endDate: string): number {
  const [sy, sm, sd] = startDate.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = endDate.split("-").map(Number) as [number, number, number];
  let months = (ey - sy) * 12 + (em - sm);
  // The month is complete on the day before the start day of the month (5 Jan to 4 Jul is 6).
  if (ed + 1 < sd) months -= 1;
  return Math.max(0, months);
}

/** Leave in lieu is owed by law from 6 months' continuous service (Labour Act s.18(4)). */
export const LEAVE_IN_LIEU_MIN_SERVICE_MONTHS = 6;

/**
 * `days` × (basic monthly ÷ divisor days), rounded half up once: the database's
 * `add_final_pay_item` checks the same figure.
 */
export function basicDaysAmount(days: number, basicMonthlyKobo: Kobo, divisorDays: number): Kobo {
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be a whole number");
  if (!Number.isInteger(divisorDays) || divisorDays < 1) throw new RangeError("bad divisor");
  if (basicMonthlyKobo < 0n) throw new RangeError("basic can't be negative");
  return roundHalfUp(BigInt(days) * basicMonthlyKobo, BigInt(divisorDays));
}

/**
 * The exempt and taxable parts of a loss-of-office payment (adviser answer 19): exempt up to the
 * cap, less what earlier payments of the worker already used (the conservative reading: the cap
 * is per worker, across all such payments). Parts sum to the amount.
 */
export function lossOfOfficeSplit(
  amountKobo: Kobo,
  capKobo: Kobo,
  usedKobo: Kobo,
): { exemptKobo: Kobo; taxableKobo: Kobo; roomKobo: Kobo } {
  if (amountKobo <= 0n) throw new RangeError("amount must be above 0");
  const room = capKobo - usedKobo > 0n ? capKobo - usedKobo : 0n;
  const exempt = amountKobo < room ? amountKobo : room;
  return { exemptKobo: exempt, taxableKobo: amountKobo - exempt, roomKobo: room };
}

/** Whether an item shares the loss-of-office exemption. */
export function usesExemption(type: FinalPayItemType, partOfSettlement: boolean): boolean {
  return type === "loss_of_office" || (type === "notice_in_lieu" && partOfSettlement);
}

/** What the database pre-fills from (`payroll_final_pay_prefill`), per worker on the run. */
export interface FinalPayPrefill {
  workerId: string;
  startDate: string;
  endDate: string;
  /** The pay version in force on the last day: monthly basic, or null for daily and hourly. */
  basicMonthlyKobo: Kobo | null;
  divisorDays: number;
  /** The annual leave balance (Phase 4 ledger) for the last day's year; null with no annual type. */
  annualBalanceDays: number | null;
  /** The run's rule set cap and what earlier items of the worker already used. */
  exemptCapKobo: Kobo;
  exemptUsedKobo: Kobo;
}

export interface FinalPayItemInput {
  type: FinalPayItemType;
  /** Leave and notice: days. */
  days: number | null;
  amountKobo: Kobo;
  partOfSettlement: boolean;
}

export interface FinalPayLine {
  label: string;
  amountKobo: Kobo;
  taxable: boolean;
  pensionable: false;
}

export interface FinalPayPlan {
  /** Days × basic daily rate (leave and notice on a monthly rate); null otherwise. */
  computedKobo: Kobo | null;
  exemptKobo: Kobo;
  taxableKobo: Kobo;
  /** HR changed the pre-filled days or amount, so a reason for the change is needed. */
  needsChangeReason: boolean;
  lines: FinalPayLine[];
  /** Below 6 months' service, leave in lieu isn't owed by law. */
  belowLeaveService: boolean;
}

/** The label the database writes on the item's adjustment row(s). */
export function finalPayLabel(
  type: FinalPayItemType,
  days: number | null,
  part: "whole" | "exempt" | "taxable",
): string {
  const base =
    type === "leave_in_lieu"
      ? `Pay in lieu of untaken leave, ${days} ${days === 1 ? "day" : "days"}`
      : type === "notice_in_lieu"
        ? `Pay in lieu of notice, ${days} ${days === 1 ? "day" : "days"}`
        : FINAL_PAY_ITEMS[type].label;
  return part === "whole" ? base : `${base}, ${part} part`;
}

/** Works out an item as the database will store it (see the file header). */
export function planFinalPayItem(prefill: FinalPayPrefill, input: FinalPayItemInput): FinalPayPlan {
  const rule = FINAL_PAY_ITEMS[input.type];
  if (rule.byDays && (input.days === null || input.days < 1)) {
    throw new RangeError("days are needed for this item");
  }
  const computedKobo =
    rule.byDays && prefill.basicMonthlyKobo !== null
      ? basicDaysAmount(input.days!, prefill.basicMonthlyKobo, prefill.divisorDays)
      : null;
  const daysChanged =
    input.type === "leave_in_lieu" &&
    (prefill.annualBalanceDays === null || input.days !== prefill.annualBalanceDays);
  const amountChanged = rule.byDays && (computedKobo === null || input.amountKobo !== computedKobo);
  const exempt = usesExemption(input.type, input.partOfSettlement);
  const split = exempt
    ? lossOfOfficeSplit(input.amountKobo, prefill.exemptCapKobo, prefill.exemptUsedKobo)
    : { exemptKobo: 0n, taxableKobo: input.amountKobo };
  const lines: FinalPayLine[] = [];
  if (!exempt) {
    lines.push({
      label: finalPayLabel(input.type, input.days, "whole"),
      amountKobo: input.amountKobo,
      taxable: true,
      pensionable: false,
    });
  } else {
    if (split.exemptKobo > 0n) {
      lines.push({
        label: finalPayLabel(input.type, input.days, "exempt"),
        amountKobo: split.exemptKobo,
        taxable: false,
        pensionable: false,
      });
    }
    if (split.taxableKobo > 0n) {
      lines.push({
        label: finalPayLabel(input.type, input.days, "taxable"),
        amountKobo: split.taxableKobo,
        taxable: true,
        pensionable: false,
      });
    }
  }
  return {
    computedKobo,
    exemptKobo: split.exemptKobo,
    taxableKobo: split.taxableKobo,
    needsChangeReason: daysChanged || amountChanged,
    lines,
    belowLeaveService:
      input.type === "leave_in_lieu" &&
      serviceMonths(prefill.startDate, prefill.endDate) < LEAVE_IN_LIEU_MIN_SERVICE_MONTHS,
  };
}

/** "₦3,000 a day (basic ₦60,000 ÷ 20 days)", or null without a monthly basic. */
export function basicDailyRateText(prefill: FinalPayPrefill): string | null {
  if (prefill.basicMonthlyKobo === null) return null;
  const daily = roundHalfUp(prefill.basicMonthlyKobo, BigInt(prefill.divisorDays));
  return `${formatNaira(daily)} a day (basic ${formatNaira(prefill.basicMonthlyKobo)} ÷ ${prefill.divisorDays} days)`;
}
