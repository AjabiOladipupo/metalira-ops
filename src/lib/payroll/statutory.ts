/**
 * Statutory remittances (slice 5.6; docs/PHASE_5.md 5.6, open questions 13 and 14). Pure.
 *
 * What a posted run owes each authority is the sum of its payslip lines in kobo: PAYE by the
 * payslip's tax state, pension by its PFA (employee and employer together), NHF, NSITF and ITF.
 * The database makes the same grouping at approval (`private.statutory_amounts`, migration
 * 20261122160000); `groupStatutory` mirrors it for tests and previews.
 *
 * Due dates: pension is due 7 working days after the pay date (RULES_NIGERIA "Pension": within 7
 * working days of paying salary), skipping Saturdays, Sundays and the company's public holidays.
 * PAYE, NHF, NSITF and ITF have a due date only when the company sets its own day of the month
 * after the pay date (open question 13); RULES_NIGERIA.md has no rule for them. Every figure here
 * is to be confirmed with a tax adviser before the first live payroll.
 */
import { addDays } from "@/lib/dates";
import type { Kobo } from "@/lib/money";

export const REMITTANCE_KINDS = ["paye", "pension", "nhf", "nsitf", "itf"] as const;
export type RemittanceKind = (typeof REMITTANCE_KINDS)[number];

export const REMITTANCE_KIND_LABELS: Record<RemittanceKind, string> = {
  paye: "PAYE",
  pension: "Pension",
  nhf: "NHF",
  nsitf: "NSITF",
  itf: "ITF",
};

/** Working days after the pay date that pension is due (RULES_NIGERIA "Pension"). */
export const PENSION_DUE_WORKING_DAYS = 7;

/** The payslip line codes each kind sums. */
const KIND_OF_CODE: Readonly<Record<string, RemittanceKind>> = {
  paye: "paye",
  pension_employee: "pension",
  pension_employer: "pension",
  nhf: "nhf",
  nsitf: "nsitf",
  itf: "itf",
};

export interface StatutorySlip {
  taxState: string | null;
  pfaName: string | null;
  lines: readonly { code: string; amountKobo: Kobo }[];
}

export interface StatutoryGroup {
  kind: RemittanceKind;
  /** The tax state (PAYE) or PFA name (pension); null for the levies or when none is on file. */
  authorityKey: string | null;
  amountKobo: Kobo;
  workerCount: number;
}

/**
 * One group per kind and authority with an amount above 0, in kind order then authority (none
 * first), as the database makes them.
 */
export function groupStatutory(slips: readonly StatutorySlip[]): StatutoryGroup[] {
  const groups = new Map<string, StatutoryGroup & { slips: Set<number> }>();
  slips.forEach((slip, index) => {
    for (const line of slip.lines) {
      const kind = KIND_OF_CODE[line.code];
      if (!kind) continue;
      const authorityKey =
        kind === "paye" ? slip.taxState : kind === "pension" ? slip.pfaName : null;
      const key = `${kind}\u0000${authorityKey ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { kind, authorityKey, amountKobo: 0n, workerCount: 0, slips: new Set() };
        groups.set(key, group);
      }
      group.amountKobo += line.amountKobo;
      if (line.amountKobo > 0n) group.slips.add(index);
    }
  });
  return [...groups.values()]
    .filter((g) => g.amountKobo > 0n)
    .map(({ slips: counted, ...g }) => ({ ...g, workerCount: counted.size }))
    .sort((a, b) => {
      const byKind = REMITTANCE_KINDS.indexOf(a.kind) - REMITTANCE_KINDS.indexOf(b.kind);
      if (byKind !== 0) return byKind;
      if (a.authorityKey === b.authorityKey) return 0;
      if (a.authorityKey === null) return -1;
      if (b.authorityKey === null) return 1;
      return a.authorityKey < b.authorityKey ? -1 : 1;
    });
}

/** ISO weekday, Monday 1 to Sunday 7, of a `YYYY-MM-DD` date. */
function isoWeekday(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * `days` working days after `from`: Monday to Friday, leaving out `holidays` (the company's live
 * public holidays, `YYYY-MM-DD`). Mirrors `private.add_working_days`.
 */
export function addWorkingDays(from: string, days: number, holidays: ReadonlySet<string>): string {
  if (!Number.isInteger(days) || days < 0 || days > 60) {
    throw new RangeError("Count 0 to 60 working days.");
  }
  let date = from;
  let left = days;
  while (left > 0) {
    date = addDays(date, 1);
    if (isoWeekday(date) < 6 && !holidays.has(date)) left -= 1;
  }
  return date;
}

/** The company's own due days (1 to 28 of the month after the pay date), or null for none. */
export interface RemitDueDays {
  paye: number | null;
  nhf: number | null;
  nsitf: number | null;
  itf: number | null;
}

/** A remittance's due date, as `private.statutory_due_date` works it out. */
export function remittanceDueDate(
  kind: RemittanceKind,
  payDate: string,
  dueDays: RemitDueDays,
  holidays: ReadonlySet<string>,
): string | null {
  if (kind === "pension") return addWorkingDays(payDate, PENSION_DUE_WORKING_DAYS, holidays);
  const day = dueDays[kind];
  if (day === null) return null;
  const [y, m] = payDate.split("-").map(Number) as [number, number];
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type RemittanceStatus = "paid" | "overdue" | "due" | "no_due_date";

/** Worked out on read (no crons): paid once a standing payment is recorded. */
export function remittanceStatus(
  remittance: { dueDate: string | null; paid: boolean },
  today: string,
): RemittanceStatus {
  if (remittance.paid) return "paid";
  if (remittance.dueDate === null) return "no_due_date";
  return remittance.dueDate < today ? "overdue" : "due";
}

export const REMITTANCE_STATUS: Record<
  RemittanceStatus,
  { label: string; tone: "done" | "pending" | "partial" | "action" }
> = {
  paid: { label: "Paid", tone: "done" },
  overdue: { label: "Overdue", tone: "action" },
  due: { label: "Due", tone: "pending" },
  no_due_date: { label: "No due date set", tone: "partial" },
};

/**
 * Who the money goes to, for the screen: "Lagos State IRS", "FCT IRS", "Stanbic IBTC Pensions",
 * "NSITF". The state names are free text on the worker, so anything else is shown as typed.
 */
export function authorityLabel(kind: RemittanceKind, authorityKey: string | null): string {
  if (kind === "paye") {
    if (authorityKey === null) return "No tax state on file";
    const state = authorityKey.trim();
    if (/^(fct|fct abuja|abuja)$/i.test(state)) return "FCT IRS";
    if (/\b(irs|board|service)\b/i.test(state)) return state;
    return `${state.replace(/\s+state$/i, "")} State IRS`;
  }
  if (kind === "pension") return authorityKey ?? "No PFA on file";
  return REMITTANCE_KIND_LABELS[kind];
}

/** "PAYE to Lagos State IRS", "Pension to Stanbic IBTC Pensions", "NSITF". */
export function remittanceTitle(kind: RemittanceKind, authorityKey: string | null): string {
  if (kind === "paye" || kind === "pension") {
    return `${REMITTANCE_KIND_LABELS[kind]} to ${authorityLabel(kind, authorityKey)}`;
  }
  return REMITTANCE_KIND_LABELS[kind];
}
