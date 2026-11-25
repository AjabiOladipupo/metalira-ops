import { z } from "zod";

import type { Kobo } from "@/lib/money";

import type { OpeningBalance, YearToDate } from "./contract";

/**
 * Cumulative year-to-date PAYE's inputs (slice 5.9a, the tax adviser's answers of 24 Nov 2026).
 * Pure and isomorphic: the server reads `payroll_tax_context` and the year's standing payslips,
 * and these turn them into the engine's `YearToDate`.
 *
 * - The tax year is the calendar year of the pay date.
 * - Months elapsed run from the later of 1 January, the worker's start date and the company's
 *   payroll go-live month (the month of its earliest posted pay date, or this run's when there is
 *   none yet) through the pay date's month. With an opening balance the go-live month doesn't
 *   apply: the balance covers the months before go-live, so they count from 1 January or the
 *   start date.
 * - With an opening balance, only payslips paid after its as-of month count (the balance holds
 *   the months before; approval's check, migration 20261122230000, counts the same).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "an ISO date");
const koboText = z
  .string()
  .regex(/^\d{1,16}$/, "whole kobo")
  .transform((v): Kobo => BigInt(v));

const taxContextSchema = z
  .object({
    version: z.literal(1),
    headcount: z.number().int().min(0),
    itf_turnover_over_50m: z.boolean().nullable(),
    go_live_month: isoDate.nullable(),
    workers: z.array(
      z.object({
        worker_id: z.uuid(),
        has_nhf_number: z.boolean(),
        rent_declared_kobo: koboText,
        opening: z
          .object({
            id: z.uuid(),
            as_of_month: isoDate,
            gross_kobo: koboText,
            chargeable_kobo: koboText,
            paye_kobo: koboText,
            pension_kobo: koboText,
          })
          .nullable(),
        reliefs: z.array(
          z.object({
            id: z.uuid(),
            kind: z.enum(["rent", "nhis", "life_assurance"]),
            annual_kobo: koboText,
          }),
        ),
      }),
    ),
  })
  .transform((c) => ({
    headcount: c.headcount,
    itfTurnoverOver50m: c.itf_turnover_over_50m === true,
    goLiveMonth: c.go_live_month,
    workers: new Map(
      c.workers.map((w) => [
        w.worker_id,
        {
          hasNhfNumber: w.has_nhf_number,
          rentDeclaredKobo: w.rent_declared_kobo,
          opening: w.opening
            ? ({
                id: w.opening.id,
                asOfMonth: w.opening.as_of_month.slice(0, 7),
                grossKobo: w.opening.gross_kobo,
                chargeableKobo: w.opening.chargeable_kobo,
                payeKobo: w.opening.paye_kobo,
                pensionKobo: w.opening.pension_kobo,
              } satisfies OpeningBalance)
            : null,
          reliefs: w.reliefs.map((r) => ({ id: r.id, kind: r.kind, annualKobo: r.annual_kobo })),
        },
      ]),
    ),
  }));

export type TaxContext = z.output<typeof taxContextSchema>;
export type TaxWorker = TaxContext["workers"] extends Map<string, infer W> ? W : never;

/** Parses `public.payroll_tax_context`'s jsonb; throws a ZodError when the shape is wrong. */
export function parseTaxContext(raw: unknown): TaxContext {
  return taxContextSchema.parse(raw);
}

/** A standing payslip of the tax year (another run's). */
export interface YearSlip {
  payslipId: string;
  payDate: string;
  grossKobo: Kobo;
  /** Taxable pay less employee pension and NHF. */
  chargeableKobo: Kobo;
  payeKobo: Kobo;
}

const ym = (date: string): { y: number; m: number } => ({
  y: Number(date.slice(0, 4)),
  m: Number(date.slice(5, 7)),
});

const monthText = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** The first day of the month after "YYYY-MM". */
function monthAfter(month: string): string {
  const { y, m } = ym(month);
  return m === 12 ? `${y + 1}-01-01` : `${monthText(y, m + 1)}-01`;
}

export interface YearToDateArgs {
  payDate: string;
  startDate: string;
  /** "YYYY-MM-01" of the company's earliest posted pay date, or null before the first. */
  goLiveMonth: string | null;
  worker: TaxWorker | null;
  /** The worker's standing payslips of the tax year (other runs). */
  slips: readonly YearSlip[];
}

/** The worker's tax year so far, as the engine takes it (see the file header). */
export function yearToDateFor(a: YearToDateArgs): YearToDate {
  const pay = ym(a.payDate);
  const opening = a.worker?.opening ?? null;
  let start = 1;
  const joined = ym(a.startDate);
  if (joined.y === pay.y) start = Math.max(start, joined.m);
  else if (joined.y > pay.y) start = pay.m;
  if (!opening) {
    // Go-live: the earliest posted pay date's month, never later than this payslip's.
    const live =
      a.goLiveMonth !== null && a.goLiveMonth.slice(0, 7) <= monthText(pay.y, pay.m)
        ? ym(a.goLiveMonth)
        : pay;
    if (live.y === pay.y) start = Math.max(start, live.m);
  }
  start = Math.min(start, pay.m);
  const counted = opening
    ? a.slips.filter((s) => s.payDate >= monthAfter(opening.asOfMonth))
    : [...a.slips];
  const sum = (pick: (s: YearSlip) => Kobo) => counted.reduce((n, s) => n + pick(s), 0n);
  return {
    monthsElapsed: pay.m - start + 1,
    fromMonth: monthText(pay.y, start),
    payslips: counted.length,
    grossKobo: sum((s) => s.grossKobo),
    chargeableKobo: sum((s) => s.chargeableKobo),
    payeKobo: sum((s) => s.payeKobo),
    opening,
    reliefIds: (a.worker?.reliefs ?? []).map((r) => r.id).sort(),
  };
}

/**
 * Slice 5.9a (Labour Act s.5(5), tax adviser): an overpayment paid more than `maxMonths` months
 * before `today` (its discovery) can't be deducted from wages. Months are calendar months, the
 * day clamped to the month's end, as SQL's `date - interval 'n months'`.
 */
export function overpaymentTooOld(paidOn: string, today: string, maxMonths: number): boolean {
  const { y, m } = ym(today);
  const day = Number(today.slice(8, 10));
  const total = y * 12 + (m - 1) - maxMonths;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const limit = `${monthText(ty, tm)}-${String(Math.min(day, last)).padStart(2, "0")}`;
  return paidOn < limit;
}
