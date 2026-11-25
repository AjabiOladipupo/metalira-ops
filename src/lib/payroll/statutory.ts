/**
 * Statutory remittances (slice 5.6; docs/PHASE_5.md 5.6, open questions 13 and 14). Pure.
 *
 * What a posted run owes each authority is the sum of its payslip lines in kobo: PAYE by the
 * payslip's tax state, pension by its PFA (employee and employer together), NHF, NSITF and ITF.
 * Authorities are grouped on a normalised key (money review M2), so "Lagos", "lagos state" and
 * "Lagos State" are one remittance. The database makes the same grouping at approval
 * (`private.statutory_amounts`, migration 20261122160000); `groupStatutory` mirrors it.
 *
 * Due dates (slice 5.9b; the tax adviser's answers of 24 Nov 2026, docs/PHASE_5.md 5.9b): pension
 * by the 7th working day counting the day salary is actually paid (the release; the scheduled pay
 * date, provisionally, before it) as day 1, or the next working day when it isn't one; PAYE the
 * 10th of the following month (penalty after the 21st); NHF the same day of the next month (the
 * month's last day when it has none); NSITF the 15th of the following month; ITF 1 April of the
 * following year. Working days are Monday to Friday less the platform's official holidays
 * (federal, and the tax state's for PAYE), never the company's own list. A fixed date that isn't a
 * working day comes back to the working day before. The company's own day applies only when
 * earlier. `private.statutory_due_date` (migration 20261122240000) mirrors this.
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
 * `days` working days after `from`: Monday to Friday, leaving out `holidays` (`YYYY-MM-DD`).
 * Mirrors `private.deadline_add_working_days`.
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

/** The working day on or before `date`. Mirrors `private.deadline_on_or_before`. */
export function workingDayOnOrBefore(date: string, holidays: ReadonlySet<string>): string {
  let d = date;
  while (!isWorkingDay(d, holidays)) d = addDays(d, -1);
  return d;
}

/** The working day on or after `date`. Mirrors `private.deadline_on_or_after`. */
export function workingDayOnOrAfter(date: string, holidays: ReadonlySet<string>): string {
  let d = date;
  while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
  return d;
}

/**
 * The platform's official holiday calendar (slice 5.9b, `public.official_holidays`): federal
 * holidays for every deadline, and each state's own (keyed by `normaliseTaxState`) for that
 * state's PAYE. A company's own holiday list is for pay only and never moves a deadline.
 */
export interface OfficialCalendar {
  federal: ReadonlySet<string>;
  states: ReadonlyMap<string, ReadonlySet<string>>;
}

export const EMPTY_CALENDAR: OfficialCalendar = { federal: new Set(), states: new Map() };

/** Standing calendar rows (withdrawn ones left out) as an `OfficialCalendar`. */
export function officialCalendar(
  rows: readonly { date: string; scope: "federal" | "state"; stateKey: string | null }[],
): OfficialCalendar {
  const federal = new Set<string>();
  const states = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.scope === "federal") federal.add(r.date);
    else if (r.stateKey) {
      const set = states.get(r.stateKey) ?? new Set<string>();
      set.add(r.date);
      states.set(r.stateKey, set);
    }
  }
  return { federal, states };
}

/**
 * The days that aren't working days for a kind's deadline: the federal holidays, and for PAYE
 * also the tax state's (adviser, 24 Nov 2026).
 */
export function deadlineHolidays(
  calendar: OfficialCalendar,
  kind: RemittanceKind,
  authorityKey: string | null,
): ReadonlySet<string> {
  const state = kind === "paye" && authorityKey ? calendar.states.get(authorityKey) : undefined;
  if (!state || state.size === 0) return calendar.federal;
  return new Set([...calendar.federal, ...state]);
}

/** Pension is due by this working day, counting the day salary is paid (or the next) as the first. */
export const PENSION_DUE_WORKING_DAYS = 7;
/** PAYE: target the 10th of the following month; a statutory penalty after the 21st. */
export const PAYE_TARGET_DAY = 10;
export const PAYE_PENALTY_AFTER_DAY = 21;
/** NSITF: on or before the 15th of the following month. */
export const NSITF_DUE_DAY = 15;

/** Where each kind's deadline comes from (adviser, 24 Nov 2026). */
export const DEADLINE_RULES: Record<RemittanceKind, string> = {
  pension:
    "Pension: within 7 working days of the day salary is paid, counting that day (or the next working day) as day 1 (PRA 2014 s.11(3)(b)).",
  paye: "PAYE: by the 10th of the following month; a statutory penalty applies after the 21st (NTAA 2025 s.107).",
  nhf: "NHF: within 1 month of the deduction, the same day of the next month (NHF Act s.9(2)).",
  nsitf: "NSITF: on or before the 15th of the following month (ECA 2010 s.33(1)).",
  itf: "ITF: by 1 April of the following year; it builds up monthly (ITF Act s.6(2)).",
};

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Year and month (1 to 12) of the month after `iso`'s. */
function nextMonth(iso: string): [number, number] {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return m === 12 ? [y + 1, 1] : [y, m + 1];
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A kind's statutory deadline for salary paid on `paidOn`, before any company day. Fixed dates
 * that aren't working days come back to the working day before (paying early is never late).
 * Mirrors `private.statutory_deadline`.
 */
export function statutoryDeadline(
  kind: RemittanceKind,
  paidOn: string,
  holidays: ReadonlySet<string>,
): string {
  const [ny, nm] = nextMonth(paidOn);
  switch (kind) {
    case "pension":
      return addWorkingDays(
        workingDayOnOrAfter(paidOn, holidays),
        PENSION_DUE_WORKING_DAYS - 1,
        holidays,
      );
    case "paye":
      return workingDayOnOrBefore(ymd(ny, nm, PAYE_TARGET_DAY), holidays);
    case "nhf": {
      const day = Number(paidOn.slice(8, 10));
      return workingDayOnOrBefore(ymd(ny, nm, Math.min(day, daysInMonth(ny, nm))), holidays);
    }
    case "nsitf":
      return workingDayOnOrBefore(ymd(ny, nm, NSITF_DUE_DAY), holidays);
    case "itf":
      return workingDayOnOrBefore(ymd(Number(paidOn.slice(0, 4)) + 1, 4, 1), holidays);
  }
}

/** PAYE's statutory penalty applies after this day: the 21st of the month after `paidOn`. */
export function payePenaltyAfter(paidOn: string): string {
  const [y, m] = nextMonth(paidOn);
  return ymd(y, m, PAYE_PENALTY_AFTER_DAY);
}

/** The annual PAYE return (Form H1) for a tax year is due 31 January of the next year. */
export function annualPayeReturnDue(taxYear: number): string {
  return ymd(taxYear + 1, 1, 31);
}

/** The company's own due days (1 to 28 of the month after the pay date), or null for none. */
export interface RemitDueDays {
  paye: number | null;
  nhf: number | null;
  nsitf: number | null;
  itf: number | null;
}

export interface RemittanceDeadline {
  /** The date to pay by: the statutory deadline, or the company's day when earlier. */
  dueDate: string;
  statutoryDate: string;
  /** The day salary was paid that the deadline counts from. */
  paidOn: string;
  /** Counted from the scheduled pay date: the run isn't released (uploaded to the bank) yet. */
  provisional: boolean;
  /** The company's own day, and whether it applies (only when earlier than the statutory date). */
  customDay: { day: number; date: string; applied: boolean } | null;
  /** PAYE only: the statutory penalty applies after this day. */
  penaltyAfter: string | null;
}

/**
 * A remittance's due date (adviser, 24 Nov 2026), worked out on read. It counts from the day
 * salary was actually paid (`releasedOn`, the release), or provisionally from the scheduled pay
 * date before release. Mirrors `private.statutory_due_date`, which stamps the provisional date at
 * approval.
 */
export function remittanceDeadline(input: {
  kind: RemittanceKind;
  authorityKey: string | null;
  payDate: string;
  releasedOn: string | null;
  dueDays: RemitDueDays;
  calendar: OfficialCalendar;
}): RemittanceDeadline {
  const paidOn = input.releasedOn ?? input.payDate;
  const holidays = deadlineHolidays(input.calendar, input.kind, input.authorityKey);
  const statutoryDate = statutoryDeadline(input.kind, paidOn, holidays);
  const day = input.kind === "pension" ? null : input.dueDays[input.kind];
  let customDay: RemittanceDeadline["customDay"] = null;
  if (day !== null) {
    const [y, m] = nextMonth(paidOn);
    const date = ymd(y, m, day);
    customDay = { day, date, applied: date < statutoryDate };
  }
  return {
    dueDate: customDay?.applied ? customDay.date : statutoryDate,
    statutoryDate,
    paidOn,
    provisional: input.releasedOn === null,
    customDay,
    penaltyAfter: input.kind === "paye" ? payePenaltyAfter(paidOn) : null,
  };
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

/**
 * PAYE past the statutory penalty date (after the 21st of the month after payment, NTAA 2025
 * s.107) with something still owed.
 */
export function remittanceIsPastPenalty(
  r: { penaltyAfter: string | null; amountKobo: Kobo; paidKobo: Kobo | null },
  today: string,
): boolean {
  return r.penaltyAfter !== null && r.penaltyAfter < today && remittanceOutstanding(r) > 0n;
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
