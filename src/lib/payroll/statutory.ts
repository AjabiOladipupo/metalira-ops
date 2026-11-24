/**
 * Statutory remittances (slice 5.6; docs/PHASE_5.md 5.6, open questions 13 and 14). Pure.
 *
 * What a posted run owes each authority is the sum of its payslip lines in kobo: PAYE by the
 * payslip's tax state, pension by its PFA (employee and employer together), NHF, NSITF and ITF.
 * Authorities are grouped on a normalised key (money review M2), so "Lagos", "lagos state" and
 * "Lagos State" are one remittance. The database makes the same grouping at approval
 * (`private.statutory_amounts`, migration 20261122160000); `groupStatutory` mirrors it.
 *
 * Due dates: pension by the 7th working day counting the pay date as the first, after rolling a
 * pay date that isn't a working day back to the working day before (RULES_NIGERIA "Pension":
 * within 7 working days of paying salary; money review M3 took the earlier, safer reading),
 * skipping Saturdays, Sundays and the company's public holidays. PAYE, NHF, NSITF and ITF have a
 * due date only when the company sets its own day of the month after the pay date (open question
 * 13); RULES_NIGERIA.md has no rule for them. Every figure here is to be confirmed with a tax
 * adviser before the first live payroll.
 */
import { NIGERIAN_STATES } from "@/lib/company";
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

/** Pension is due by this working day, counting the (rolled back) pay date as the first. */
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

const FCT_SPELLINGS = new Set([
  "fct",
  "abuja",
  "fct abuja",
  "fct, abuja",
  "fct-abuja",
  "federal capital territory",
]);

/** Spaces trimmed and collapsed; null for nothing. */
function spelling(value: string | null): string | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  return v === "" ? null : v;
}

/** A tax state's grouping key, as `private.normalise_tax_state` makes it. */
export function normaliseTaxState(value: string | null): string | null {
  const v =
    spelling(value)
      ?.toLowerCase()
      .replace(/ state$/, "") ?? null;
  if (v === null || v === "") return null;
  return FCT_SPELLINGS.has(v) ? "fct abuja" : v;
}

/** A PFA name's grouping key, as `private.normalise_pfa` makes it. */
export function normalisePfa(value: string | null): string | null {
  return spelling(value)?.toLowerCase() ?? null;
}

/** The state's own name for a tax-state key ("lagos" gives "Lagos"), or null. */
export function nigerianStateName(key: string): string | null {
  return NIGERIAN_STATES.find((s) => s.toLowerCase() === key) ?? null;
}

export interface StatutorySlip {
  taxState: string | null;
  pfaName: string | null;
  lines: readonly { code: string; amountKobo: Kobo }[];
}

export interface StatutoryGroup {
  kind: RemittanceKind;
  /** The normalised tax state (PAYE) or PFA (pension); null for the levies or none on file. */
  authorityKey: string | null;
  /** How the screen names it: the state's own name, or the first spelling of the PFA. */
  authorityName: string | null;
  /** Every spelling merged under the key, sorted. More than one shows a notice. */
  authorityVariants: string[];
  amountKobo: Kobo;
  workerCount: number;
}

/**
 * One group per kind and authority key with an amount above 0, in kind order then key (none
 * first), as the database makes them.
 */
export function groupStatutory(slips: readonly StatutorySlip[]): StatutoryGroup[] {
  const groups = new Map<
    string,
    Omit<StatutoryGroup, "authorityName" | "authorityVariants" | "workerCount"> & {
      spellings: Set<string>;
      slips: Set<number>;
    }
  >();
  slips.forEach((slip, index) => {
    for (const line of slip.lines) {
      const kind = KIND_OF_CODE[line.code];
      if (!kind) continue;
      const raw = kind === "paye" ? slip.taxState : kind === "pension" ? slip.pfaName : null;
      const authorityKey =
        kind === "paye" ? normaliseTaxState(raw) : kind === "pension" ? normalisePfa(raw) : null;
      const key = `${kind}\u0000${authorityKey ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { kind, authorityKey, amountKobo: 0n, spellings: new Set(), slips: new Set() };
        groups.set(key, group);
      }
      const spelled = spelling(raw);
      if (spelled !== null) group.spellings.add(spelled);
      group.amountKobo += line.amountKobo;
      if (line.amountKobo > 0n) group.slips.add(index);
    }
  });
  return [...groups.values()]
    .filter((g) => g.amountKobo > 0n)
    .map(({ slips: counted, spellings, ...g }) => {
      const variants = [...spellings].sort();
      const authorityName =
        g.authorityKey === null
          ? null
          : ((g.kind === "paye" ? nigerianStateName(g.authorityKey) : null) ?? variants[0] ?? null);
      return { ...g, authorityName, authorityVariants: variants, workerCount: counted.size };
    })
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

function isWorkingDay(iso: string, holidays: ReadonlySet<string>): boolean {
  return isoWeekday(iso) < 6 && !holidays.has(iso);
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
    if (isWorkingDay(date, holidays)) left -= 1;
  }
  return date;
}

/** The working day on or before `date`. Mirrors `private.working_day_on_or_before`. */
export function workingDayOnOrBefore(date: string, holidays: ReadonlySet<string>): string {
  let d = date;
  while (!isWorkingDay(d, holidays)) d = addDays(d, -1);
  return d;
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
  if (kind === "pension") {
    return addWorkingDays(
      workingDayOnOrBefore(payDate, holidays),
      PENSION_DUE_WORKING_DAYS - 1,
      holidays,
    );
  }
  const day = dueDays[kind];
  if (day === null) return null;
  const [y, m] = payDate.split("-").map(Number) as [number, number];
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type RemittanceStatus =
  | "paid"
  | "part_paid"
  | "overpaid"
  | "overdue"
  | "due"
  | "no_due_date"
  /** Its run was reversed (slice 5.7a): nothing is owed; a payment made needs a refund or offset. */
  | "voided";

/**
 * Worked out on read (no crons), from the standing payment against the amount due (money review
 * H1): paid only when they are equal; part paid when less; overpaid when more.
 */
export function remittanceStatus(
  remittance: { dueDate: string | null; amountKobo: Kobo; paidKobo: Kobo | null },
  today: string,
): RemittanceStatus {
  if (remittance.paidKobo !== null) {
    if (remittance.paidKobo === remittance.amountKobo) return "paid";
    return remittance.paidKobo < remittance.amountKobo ? "part_paid" : "overpaid";
  }
  if (remittance.dueDate === null) return "no_due_date";
  return remittance.dueDate < today ? "overdue" : "due";
}

/** What is still owed: the whole amount unpaid, or the gap of a part payment. */
export function remittanceOutstanding(r: { amountKobo: Kobo; paidKobo: Kobo | null }): Kobo {
  if (r.paidKobo === null) return r.amountKobo;
  return r.paidKobo < r.amountKobo ? r.amountKobo - r.paidKobo : 0n;
}

/** Past its due date with something still owed (unpaid, or part paid). */
export function remittanceIsOverdue(
  r: { dueDate: string | null; amountKobo: Kobo; paidKobo: Kobo | null },
  today: string,
): boolean {
  return r.dueDate !== null && r.dueDate < today && remittanceOutstanding(r) > 0n;
}

export const REMITTANCE_STATUS: Record<
  RemittanceStatus,
  { label: string; tone: "done" | "pending" | "partial" | "action" }
> = {
  paid: { label: "Paid", tone: "done" },
  voided: { label: "Voided", tone: "pending" },
  part_paid: { label: "Part paid", tone: "action" },
  overpaid: { label: "Overpaid", tone: "action" },
  overdue: { label: "Overdue", tone: "action" },
  due: { label: "Due", tone: "pending" },
  no_due_date: { label: "No due date set", tone: "partial" },
};

/**
 * Who the money goes to, for the screen: "Lagos State IRS", "FCT IRS", "Stanbic IBTC Pensions",
 * "NSITF". `authorityName` is the remittance's display name.
 */
export function authorityLabel(kind: RemittanceKind, authorityName: string | null): string {
  if (kind === "paye") {
    if (authorityName === null) return "No tax state on file";
    const state = authorityName.trim();
    if (/^(fct|fct abuja|abuja)$/i.test(state)) return "FCT IRS";
    if (/\b(irs|board|service)\b/i.test(state)) return state;
    return `${state.replace(/\s+state$/i, "")} State IRS`;
  }
  if (kind === "pension") return authorityName ?? "No PFA on file";
  return REMITTANCE_KIND_LABELS[kind];
}

/** "PAYE to Lagos State IRS", "Pension to Stanbic IBTC Pensions", "NSITF". */
export function remittanceTitle(kind: RemittanceKind, authorityName: string | null): string {
  if (kind === "paye" || kind === "pension") {
    return `${REMITTANCE_KIND_LABELS[kind]} to ${authorityLabel(kind, authorityName)}`;
  }
  return REMITTANCE_KIND_LABELS[kind];
}
