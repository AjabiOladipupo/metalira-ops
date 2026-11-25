/**
 * Slice 5.6 (docs/PHASE_5.md 5.6): statutory remittances and schedules, pure parts.
 * - Grouping by tax state and PFA, and the golden statutory totals from the engine's payslip
 *   lines: pension ₦156,600, NSITF ₦8,700, ITF ₦8,700 (fixtures/october-2026-golden.json).
 * - Due dates (slice 5.9b, the tax adviser's answers): pension by the 7th working day counting
 *   the day salary is paid (or the next working day) as day 1; PAYE the 10th, NHF a month on,
 *   NSITF the 15th, ITF 1 April; the official calendar only; a company day only when earlier.
 * - Authorities grouped on a normalised key (money review M2); short and over payments are never
 *   "paid" (money review H1).
 * - Status worked out on read; PAYE past its penalty date flagged.
 * - Schedules: formula-injection escaping, kobo to naira with 2 decimals, totals equal the
 *   remittance, exact bytes for a small PAYE file.
 */
import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { addDays } from "@/lib/dates";
import { allocateKobo, parseNairaToKobo, type Kobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/contract";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import {
  EMPTY_CALENDAR,
  addWorkingDays,
  fixedDeadline,
  annualPayeReturnDue,
  authorityLabel,
  deadlineHolidays,
  groupStatutory,
  normalisePfa,
  normaliseTaxState,
  officialCalendar,
  payePenaltyAfter,
  remittanceDeadline,
  remittanceIsOverdue,
  remittanceIsPastPenalty,
  remittanceOutstanding,
  remittanceStatus,
  remittanceTitle,
  statutoryDeadline,
  workingDayOnOrAfter,
  workingDayOnOrBefore,
  type RemittanceKind,
  type StatutorySlip,
} from "@/lib/payroll/statutory";
import { csvCell, nairaCell, toCsv } from "@/server/payroll/schedules/csv";
import { renderSchedule, type ScheduleWorkerRow } from "@/server/payroll/schedules/render";

const kobo = (naira: number): Kobo => parseNairaToKobo(String(naira));
/** Keeps the byte order mark, so the tests see the file as written. */
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
const NO_DUE_DAYS = { paye: null, nhf: null, nsitf: null, itf: null };

function salary(grossKobo: Kobo): EarningLine[] {
  const [basic, housing, transport] = allocateKobo(grossKobo, [5n, 3n, 2n]);
  return (["basic", "housing", "transport"] as const).map((code, i) => ({
    code,
    label: code,
    amountKobo: [basic, housing, transport][i]!,
    pensionable: true,
    nhfBase: code === "basic",
    taxable: true,
    sources: [],
  }));
}

// Two PFAs, so grouping by authority is exercised; everyone in Lagos, as the fixture.
const PFAS = ["Stanbic IBTC Pensions", "ARM Pension Managers"];
const goldenSlips: StatutorySlip[] = golden.workers.map((w, i) => {
  const result = grossToNet(
    {
      employmentType: "permanent",
      earnings: salary(kobo(w.gross)),
      nhfOptIn: false,
      annualRentKobo: kobo(w.annual_rent),
      deductions: [],
      carriedDeductionKobo: 0n,
    },
    NTA_2025_V1,
    { itfApplies: golden.workers.length >= NTA_2025_V1.rules.itf.minStaff },
  );
  return { taxState: "Lagos", pfaName: PFAS[i % 2]!, lines: result.lines };
});

describe("grouping the October 2026 golden run", () => {
  const groups = groupStatutory(goldenSlips);
  const total = (kind: string) =>
    groups.filter((g) => g.kind === kind).reduce((n, g) => n + g.amountKobo, 0n);

  it("gives the golden statutory totals to the kobo", () => {
    expect(total("pension")).toBe(kobo(golden.statutory.pension_total));
    expect(total("nsitf")).toBe(kobo(golden.statutory.nsitf));
    expect(total("itf")).toBe(kobo(golden.statutory.itf));
    expect(total("paye")).toBe(kobo(golden.totals.paye));
    expect(total("nhf")).toBe(0n);
  });

  it("makes one PAYE remittance per tax state and one pension remittance per PFA", () => {
    expect(groups.map((g) => [g.kind, g.authorityKey, g.authorityName, g.workerCount])).toEqual([
      ["paye", "lagos", "Lagos", 5], // Grace Edet's PAYE is ₦0, so she isn't counted
      ["pension", "arm pension managers", "ARM Pension Managers", 3],
      ["pension", "stanbic ibtc pensions", "Stanbic IBTC Pensions", 3],
      ["nsitf", null, null, 6],
      ["itf", null, null, 6],
    ]);
    // Employee 8% and employer 10% together for each PFA.
    const stanbic = groups.find((g) => g.authorityName === "Stanbic IBTC Pensions")!;
    const stanbicWorkers = golden.workers.filter((_, i) => i % 2 === 0);
    const expected = stanbicWorkers.reduce(
      (n, w) => n + kobo(w.pension_employee) + (kobo(w.gross) * 10n) / 100n,
      0n,
    );
    expect(stanbic.amountKobo).toBe(expected);
  });

  it("leaves out kinds with nothing owed and groups workers with no PFA together", () => {
    const groups2 = groupStatutory([
      { taxState: "Ogun", pfaName: null, lines: [{ code: "pension_employee", amountKobo: 800n }] },
      { taxState: "Ogun", pfaName: null, lines: [{ code: "pension_employer", amountKobo: 1000n }] },
      { taxState: "Ogun", pfaName: "X", lines: [{ code: "paye", amountKobo: 0n }] },
      { taxState: "Oyo", pfaName: "X", lines: [{ code: "basic", amountKobo: 5000n }] },
    ]);
    expect(groups2).toEqual([
      {
        kind: "pension",
        authorityKey: null,
        authorityName: null,
        authorityVariants: [],
        amountKobo: 1800n,
        workerCount: 2,
      },
    ]);
  });

  it("merges spellings of one state or PFA, and lists the variants", () => {
    const line = (code: string, amountKobo: bigint) => ({ code, amountKobo });
    const groups3 = groupStatutory([
      {
        taxState: "Lagos",
        pfaName: "Stanbic IBTC Pensions",
        lines: [line("paye", 100n), line("pension_employee", 10n)],
      },
      {
        taxState: " lagos  state",
        pfaName: "stanbic  ibtc pensions ",
        lines: [line("paye", 200n), line("pension_employee", 20n)],
      },
      { taxState: "LAGOS STATE", pfaName: "Stanbic IBTC Pensions", lines: [line("paye", 300n)] },
      { taxState: "Abuja", pfaName: null, lines: [line("paye", 50n)] },
      { taxState: "FCT", pfaName: null, lines: [line("paye", 50n)] },
      { taxState: "Ikeja Board", pfaName: null, lines: [line("paye", 7n)] },
    ]);
    expect(
      groups3.map((g) => [
        g.kind,
        g.authorityKey,
        g.authorityName,
        g.authorityVariants,
        g.amountKobo,
        g.workerCount,
      ]),
    ).toEqual([
      ["paye", "fct abuja", "FCT Abuja", ["Abuja", "FCT"], 100n, 2],
      ["paye", "ikeja board", "Ikeja Board", ["Ikeja Board"], 7n, 1],
      ["paye", "lagos", "Lagos", ["LAGOS STATE", "Lagos", "lagos state"], 600n, 3],
      [
        "pension",
        "stanbic ibtc pensions",
        "Stanbic IBTC Pensions",
        ["Stanbic IBTC Pensions", "stanbic ibtc pensions"],
        30n,
        2,
      ],
    ]);
  });

  it("normalises keys as the database does", () => {
    expect(normaliseTaxState("  Cross   River State ")).toBe("cross river");
    expect(normaliseTaxState("Federal Capital Territory")).toBe("fct abuja");
    expect(normaliseTaxState("FCT Abuja")).toBe("fct abuja");
    expect(normaliseTaxState("   ")).toBeNull();
    expect(normaliseTaxState(null)).toBeNull();
    expect(normalisePfa("  ARM   Pension Managers ")).toBe("arm pension managers");
    expect(normalisePfa("")).toBeNull();
  });
});

describe("due dates (slice 5.9b, the tax adviser's answers of 24 Nov 2026)", () => {
  const NONE = new Set<string>();
  // The federal holidays the migration seeds around the dates used here.
  const FEDERAL = new Set(["2026-10-01", "2026-12-25", "2026-12-26", "2027-01-01"]);
  const calendar = (federal: string[], states: Record<string, string[]> = {}) =>
    officialCalendar([
      ...federal.map((date) => ({ date, scope: "federal" as const, stateKey: null })),
      ...Object.entries(states).flatMap(([stateKey, dates]) =>
        dates.map((date) => ({ date, scope: "state" as const, stateKey })),
      ),
    ]);
  const deadline = (
    over: Partial<Parameters<typeof remittanceDeadline>[0]> & { kind: RemittanceKind },
  ) =>
    remittanceDeadline({
      authorityKey: null,
      payDate: "2026-10-25",
      uploadedOn: null,
      dueDays: NO_DUE_DAYS,
      calendar: EMPTY_CALENDAR,
      ...over,
    });

  it("counts pension from a weekend payday's next working day as day 1 (Sun 25 Oct 2026 gives Tue 3 Nov)", () => {
    // The golden run: paid Sunday 25 Oct, day 1 is Monday 26 Oct, day 7 Tuesday 3 Nov.
    expect(workingDayOnOrAfter("2026-10-25", NONE)).toBe("2026-10-26");
    expect(statutoryDeadline("pension", "2026-10-25", NONE)).toBe("2026-11-03");
    // Saturday 24 Oct gives the same day 1.
    expect(statutoryDeadline("pension", "2026-10-24", NONE)).toBe("2026-11-03");
    // A working payday counts itself: Friday 25 Sep 2026 gives Monday 5 Oct.
    expect(statutoryDeadline("pension", "2026-09-25", NONE)).toBe("2026-10-05");
    // Paid on Monday 26 Oct: the same day 1 as the Sunday.
    expect(statutoryDeadline("pension", "2026-10-26", NONE)).toBe("2026-11-03");
  });

  it("counts pension from the next working day when payday is a public holiday", () => {
    // Paid on Independence Day, Thursday 1 Oct 2026: day 1 is Friday 2 Oct, day 7 Monday 12 Oct.
    expect(statutoryDeadline("pension", "2026-10-01", FEDERAL)).toBe("2026-10-12");
    // Without the holiday it would count itself: Friday 9 Oct.
    expect(statutoryDeadline("pension", "2026-10-01", NONE)).toBe("2026-10-09");
    // Paid on Christmas Day 2026: Boxing Day (Saturday) and 1 Jan 2027 skipped; day 1 Monday
    // 28 Dec, day 7 Wednesday 6 Jan 2027.
    expect(statutoryDeadline("pension", "2026-12-25", FEDERAL)).toBe("2027-01-06");
    // A federal holiday inside the 7 days moves it on a day: Friday 25 Sep 2026, 1 Oct skipped.
    expect(statutoryDeadline("pension", "2026-09-25", FEDERAL)).toBe("2026-10-06");
  });

  it("counts pension from the upload date given at release, provisionally from the pay date before", () => {
    expect(deadline({ kind: "pension" })).toMatchObject({
      dueDate: "2026-11-03",
      paidOn: "2026-10-25",
      provisional: true,
      provisionalDueDate: null,
    });
    // Uploaded Tuesday 27 Oct: day 7 is Wednesday 4 Nov, no longer provisional; the provisional
    // date it replaced is kept to show beside it.
    expect(deadline({ kind: "pension", uploadedOn: "2026-10-27" })).toMatchObject({
      dueDate: "2026-11-04",
      paidOn: "2026-10-27",
      provisional: false,
      provisionalDueDate: "2026-11-03",
    });
    // Uploaded Monday 26 Oct gives the same day 1 as the Sunday pay date: nothing to show.
    expect(deadline({ kind: "pension", uploadedOn: "2026-10-26" })).toMatchObject({
      dueDate: "2026-11-03",
      provisionalDueDate: null,
    });
  });

  it("keys PAYE, NHF, NSITF and ITF on the pay date, never the upload date (money review M1)", () => {
    // Uploaded in the next month: PAYE stays the 10th after the pay-date month.
    const late = { uploadedOn: "2026-11-02" };
    expect(deadline({ kind: "paye", ...late }).dueDate).toBe("2026-11-10");
    expect(deadline({ kind: "nhf", ...late }).dueDate).toBe("2026-11-25");
    expect(deadline({ kind: "nsitf", ...late }).dueDate).toBe("2026-11-13");
    for (const kind of ["paye", "nhf", "nsitf", "itf"] as const) {
      expect(deadline({ kind, ...late })).toMatchObject({
        paidOn: "2026-10-25",
        provisional: false,
      });
    }
    // A December pay date uploaded in January: PAYE keeps January and ITF the next year's
    // 1 April. 10 Jan 2027 is a Sunday, so the earlier Friday 8 Jan is used until confirmed.
    const dec = {
      payDate: "2026-12-24",
      uploadedOn: "2027-01-04",
      calendar: calendar([...FEDERAL]),
    };
    expect(deadline({ kind: "paye", ...dec })).toMatchObject({
      dueDate: "2027-01-08",
      rolledBackFrom: "2027-01-10",
      penaltyAfter: "2027-01-21",
    });
    expect(deadline({ kind: "itf", ...dec })).toMatchObject({
      dueDate: "2027-04-01",
      rolledBackFrom: null,
    });
    // Pay date 24 Dec 2027, uploaded 3 Jan 2028: PAYE Monday 10 Jan 2028 exactly.
    expect(
      deadline({ kind: "paye", payDate: "2027-12-24", uploadedOn: "2028-01-03" }).dueDate,
    ).toBe("2028-01-10");
    // Pension does follow the upload: Monday 4 Jan 2027 is day 1, so Tuesday 12 Jan; from the
    // pay date (Thursday 24 Dec; Christmas, Boxing Day and New Year skipped) it was Tuesday 5 Jan.
    expect(deadline({ kind: "pension", ...dec })).toMatchObject({
      dueDate: "2027-01-12",
      provisionalDueDate: "2027-01-05",
    });
  });

  it("marks a fixed date brought back to the working day before (until the adviser confirms)", () => {
    // 15 Nov 2026 is a Sunday: NSITF uses Friday 13 Nov.
    expect(fixedDeadline("nsitf", "2026-10-25")).toBe("2026-11-15");
    expect(deadline({ kind: "nsitf" })).toMatchObject({
      dueDate: "2026-11-13",
      rolledBackFrom: "2026-11-15",
    });
    expect(deadline({ kind: "paye" }).rolledBackFrom).toBeNull();
    expect(deadline({ kind: "pension" }).rolledBackFrom).toBeNull();
  });

  it("gives up looking for a working day after a year", () => {
    // Every day from 2025 to early 2027 a holiday: no working day within a year of mid-2026.
    const allDays = new Set(Array.from({ length: 800 }, (_, i) => addDays("2025-01-01", i)));
    expect(() => workingDayOnOrBefore("2026-06-30", allDays)).toThrow(RangeError);
    expect(() => workingDayOnOrAfter("2025-06-30", allDays)).toThrow(RangeError);
    expect(() => addWorkingDays("2025-06-30", 1, allDays)).toThrow(RangeError);
  });

  it("uses only the official calendar: a state's holiday moves its own PAYE, nothing else", () => {
    // Paid Wednesday 25 Nov 2026: PAYE is due Thursday 10 Dec.
    const cal = calendar(["2026-12-25"], { lagos: ["2026-12-10", "2026-12-15"] });
    expect(deadline({ kind: "paye", payDate: "2026-11-25", calendar: cal }).dueDate).toBe(
      "2026-12-10",
    );
    // A Lagos holiday on the 10th brings Lagos PAYE back to Wednesday 9 Dec.
    expect(
      deadline({ kind: "paye", payDate: "2026-11-25", authorityKey: "lagos", calendar: cal })
        .dueDate,
    ).toBe("2026-12-09");
    // Ogun PAYE, and the federal levies, don't count Lagos's holidays.
    expect(
      deadline({ kind: "paye", payDate: "2026-11-25", authorityKey: "ogun", calendar: cal })
        .dueDate,
    ).toBe("2026-12-10");
    expect(
      deadline({ kind: "nsitf", payDate: "2026-11-25", authorityKey: "lagos", calendar: cal })
        .dueDate,
    ).toBe("2026-12-15");
    expect(deadlineHolidays(cal, "pension", "lagos")).toBe(cal.federal);
  });

  it("gives PAYE the 10th of the next month, back to the working day before, with the penalty after the 21st", () => {
    expect(deadline({ kind: "paye" })).toMatchObject({
      dueDate: "2026-11-10",
      penaltyAfter: "2026-11-21",
    });
    // Paid 25 Sep 2026: 10 Oct is a Saturday, so Friday 9 Oct; penalty after 21 Oct.
    expect(deadline({ kind: "paye", payDate: "2026-09-25" })).toMatchObject({
      dueDate: "2026-10-09",
      penaltyAfter: "2026-10-21",
    });
    expect(payePenaltyAfter("2026-12-24")).toBe("2027-01-21");
    expect(deadline({ kind: "nsitf" }).penaltyAfter).toBeNull();
    expect(annualPayeReturnDue(2026)).toBe("2027-01-31");
  });

  it("flags PAYE past the penalty date only while something is owed", () => {
    const owed = { penaltyAfter: "2026-11-21", amountKobo: 100_000n, paidKobo: null };
    expect(remittanceIsPastPenalty(owed, "2026-11-21")).toBe(false);
    expect(remittanceIsPastPenalty(owed, "2026-11-22")).toBe(true);
    expect(remittanceIsPastPenalty({ ...owed, paidKobo: 100_000n }, "2026-12-01")).toBe(false);
    expect(remittanceIsPastPenalty({ ...owed, paidKobo: 50_000n }, "2026-12-01")).toBe(true);
    expect(remittanceIsPastPenalty({ ...owed, penaltyAfter: null }, "2026-12-01")).toBe(false);
  });

  it("gives NHF the same day of the next month, or that month's last day at month end", () => {
    expect(statutoryDeadline("nhf", "2026-10-25", NONE)).toBe("2026-11-25");
    // 31 Oct 2026: November has no 31st, so Monday 30 Nov.
    expect(statutoryDeadline("nhf", "2026-10-31", NONE)).toBe("2026-11-30");
    // 31 Jan 2028 (a leap year): Tuesday 29 Feb.
    expect(statutoryDeadline("nhf", "2028-01-31", NONE)).toBe("2028-02-29");
    // 31 Jan 2027: 28 Feb is a Sunday, so back to Friday 26 Feb.
    expect(statutoryDeadline("nhf", "2027-01-31", NONE)).toBe("2027-02-26");
    // December rolls into the next year.
    expect(statutoryDeadline("nhf", "2026-12-24", FEDERAL)).toBe("2027-01-22");
  });

  it("gives NSITF the 15th of the next month and ITF 1 April of the next year", () => {
    // 15 Nov 2026 is a Sunday: Friday 13 Nov.
    expect(statutoryDeadline("nsitf", "2026-10-25", NONE)).toBe("2026-11-13");
    expect(statutoryDeadline("nsitf", "2026-11-25", NONE)).toBe("2026-12-15");
    // ITF for any 2026 month: Thursday 1 Apr 2027.
    expect(statutoryDeadline("itf", "2026-01-25", NONE)).toBe("2027-04-01");
    expect(statutoryDeadline("itf", "2026-12-24", NONE)).toBe("2027-04-01");
    // 1 Apr 2028 is a Saturday: Friday 31 Mar 2028.
    expect(statutoryDeadline("itf", "2027-10-25", NONE)).toBe("2028-03-31");
    // A holiday on 1 April brings it back a day.
    expect(statutoryDeadline("itf", "2026-10-25", new Set(["2027-04-01"]))).toBe("2027-03-31");
  });

  it("applies the company's own day only when it is earlier than the statutory date", () => {
    const days = { paye: 5, nhf: null, nsitf: 20, itf: 28 };
    // PAYE: the 5th is earlier than the statutory 10 Nov, so it applies.
    expect(deadline({ kind: "paye", dueDays: days })).toMatchObject({
      dueDate: "2026-11-05",
      statutoryDate: "2026-11-10",
      customDay: { day: 5, date: "2026-11-05", applied: true },
    });
    // NSITF: the 20th is later than the statutory 13 Nov, so it is ignored (the screen says so).
    expect(deadline({ kind: "nsitf", dueDays: days })).toMatchObject({
      dueDate: "2026-11-13",
      statutoryDate: "2026-11-13",
      customDay: { day: 20, date: "2026-11-20", applied: false },
    });
    // ITF: the 28th of the next month is long before 1 April; 28 Nov 2026 is a Saturday, so the
    // company's day is brought back to Friday 27 Nov too (money review L1).
    expect(deadline({ kind: "itf", dueDays: days })).toMatchObject({
      dueDate: "2026-11-27",
      customDay: { day: 28, date: "2026-11-27", applied: true },
    });
    // A company day on a weekend is brought back before it is compared: the 7th of Nov 2026 is
    // a Saturday, so Friday 6 Nov.
    expect(deadline({ kind: "paye", dueDays: { ...days, paye: 7 } })).toMatchObject({
      dueDate: "2026-11-06",
      customDay: { day: 7, date: "2026-11-06", applied: true },
    });
    // The same day as the statutory one changes nothing; none set is the statutory date.
    expect(deadline({ kind: "paye", dueDays: { ...days, paye: 10 } })).toMatchObject({
      dueDate: "2026-11-10",
      customDay: { applied: false },
    });
    expect(deadline({ kind: "nhf", dueDays: days })).toMatchObject({
      dueDate: "2026-11-25",
      customDay: null,
    });
    // Pension has no company day.
    expect(deadline({ kind: "pension", dueDays: days }).customDay).toBeNull();
  });

  it("works status out on read", () => {
    const owed = (paidKobo: bigint | null, dueDate = "2026-11-03") => ({
      dueDate,
      amountKobo: 2_160_000n,
      paidKobo,
    });
    expect(remittanceStatus(owed(null), "2026-11-03")).toBe("due");
    expect(remittanceStatus(owed(null), "2026-11-04")).toBe("overdue");
    expect(remittanceStatus(owed(2_160_000n), "2026-12-01")).toBe("paid");
  });

  it("never shows a short or over payment as paid (money review H1)", () => {
    const short = { dueDate: "2026-11-02", amountKobo: 2_160_000n, paidKobo: 2_150_000n };
    expect(remittanceStatus(short, "2026-11-01")).toBe("part_paid");
    expect(remittanceOutstanding(short)).toBe(10_000n);
    expect(remittanceIsOverdue(short, "2026-11-01")).toBe(false);
    expect(remittanceIsOverdue(short, "2026-11-03")).toBe(true);
    const over = { dueDate: "2026-11-02", amountKobo: 2_160_000n, paidKobo: 2_170_000n };
    expect(remittanceStatus(over, "2026-11-03")).toBe("overpaid");
    expect(remittanceOutstanding(over)).toBe(0n);
    expect(remittanceIsOverdue(over, "2026-11-03")).toBe(false);
    const exact = { dueDate: "2026-11-02", amountKobo: 2_160_000n, paidKobo: 2_160_000n };
    expect(remittanceOutstanding(exact)).toBe(0n);
    expect(remittanceIsOverdue(exact, "2026-12-01")).toBe(false);
    expect(remittanceOutstanding({ amountKobo: 5n, paidKobo: null })).toBe(5n);
  });

  it("refuses a silly count", () => {
    expect(() => addWorkingDays("2026-10-25", -1, new Set())).toThrow(RangeError);
    expect(() => addWorkingDays("2026-10-25", 61, new Set())).toThrow(RangeError);
  });
});

describe("authority names", () => {
  it("names state boards and PFAs", () => {
    expect(remittanceTitle("paye", "Lagos")).toBe("PAYE to Lagos State IRS");
    expect(authorityLabel("paye", "FCT Abuja")).toBe("FCT IRS");
    expect(authorityLabel("paye", "Ogun State")).toBe("Ogun State IRS");
    expect(authorityLabel("paye", null)).toBe("No tax state on file");
    expect(remittanceTitle("pension", "Stanbic IBTC Pensions")).toBe(
      "Pension to Stanbic IBTC Pensions",
    );
    expect(remittanceTitle("pension", null)).toBe("Pension to No PFA on file");
    expect(remittanceTitle("nsitf", null)).toBe("NSITF");
  });
});

describe("schedule CSV", () => {
  it("escapes cells that a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+234")).toBe("'+234");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("Obi, Chiamaka")).toBe('"Obi, Chiamaka"');
    expect(csvCell("Musa Ibrahim")).toBe("Musa Ibrahim");
  });

  it("writes kobo as naira with 2 decimals in integer maths", () => {
    expect(nairaCell(12_000_000n)).toBe("120000.00");
    expect(nairaCell(5n)).toBe("0.05");
    expect(nairaCell(4_481_250n)).toBe("44812.50");
    expect(nairaCell(900_719_925_474_099_312n)).toBe("9007199254740993.12");
    expect(() => nairaCell(-1n)).toThrow(RangeError);
  });

  const row = (over: Partial<ScheduleWorkerRow>): ScheduleWorkerRow => ({
    staffId: "MLS-0001",
    name: "Musa Ibrahim",
    tin: "12345678-0001",
    rsaPin: "PEN100012345678",
    grossKobo: 12_000_000n,
    annualTaxableKobo: 125_280_000n,
    basicKobo: 6_000_000n,
    payeKobo: 566_000n,
    pensionEmployeeKobo: 960_000n,
    pensionEmployerKobo: 1_200_000n,
    nhfKobo: 0n,
    nsitfKobo: 120_000n,
    itfKobo: 120_000n,
    ...over,
  });

  it("writes the PAYE schedule's exact bytes", () => {
    const schedule = renderSchedule("paye", [
      row({ staffId: "MLS-0002", name: "=cmd|' /C calc'!A0", tin: null }),
      row({}),
      row({ staffId: "MLS-0003", name: "Grace Edet", payeKobo: 0n }),
    ]);
    const text = decode(schedule.bytes);
    expect(text).toBe(
      "﻿" +
        "Staff ID,Name,TIN,Gross pay (NGN),Annual taxable income (NGN),PAYE (NGN)\r\n" +
        "MLS-0001,Musa Ibrahim,12345678-0001,120000.00,1252800.00,5660.00\r\n" +
        "MLS-0002,'=cmd|' /C calc'!A0,Not on file,120000.00,1252800.00,5660.00\r\n" +
        "Total,2 workers,,240000.00,,11320.00\r\n",
    );
    expect(schedule.workerCount).toBe(2);
    expect(schedule.totalKobo).toBe(1_132_000n);
  });

  it("lists the RSA PIN and both pension shares, and totals to the remittance", () => {
    const schedule = renderSchedule("pension", [
      row({}),
      row({ staffId: "MLS-0009", rsaPin: null }),
    ]);
    const lines = decode(schedule.bytes).split("\r\n");
    expect(lines[0]).toBe("﻿Staff ID,Name,RSA PIN,Employee (NGN),Employer (NGN),Total (NGN)");
    expect(lines[1]).toBe("MLS-0001,Musa Ibrahim,PEN100012345678,9600.00,12000.00,21600.00");
    expect(lines[2]).toBe("MLS-0009,Musa Ibrahim,Not on file,9600.00,12000.00,21600.00");
    expect(lines[3]).toBe("Total,2 workers,,19200.00,24000.00,43200.00");
    expect(schedule.totalKobo).toBe(4_320_000n);
  });

  it("gives NHF, NSITF and ITF their bases and levies", () => {
    const nsitf = decode(renderSchedule("nsitf", [row({})]).bytes);
    expect(nsitf).toContain("MLS-0001,Musa Ibrahim,120000.00,1200.00\r\n");
    const itf = renderSchedule("itf", [row({}), row({ staffId: "D-1", itfKobo: 0n })]);
    expect(itf.workerCount).toBe(1);
    const nhf = renderSchedule("nhf", [row({ nhfKobo: 150_000n })]);
    expect(decode(nhf.bytes)).toContain("MLS-0001,Musa Ibrahim,60000.00,1500.00\r\n");
  });

  it("sums the golden run's NSITF schedule to ₦8,700", () => {
    const rows = golden.workers.map((w, i) =>
      row({
        staffId: `G-${i}`,
        name: w.name,
        grossKobo: kobo(w.gross),
        nsitfKobo: kobo(w.gross) / 100n,
      }),
    );
    expect(renderSchedule("nsitf", rows).totalKobo).toBe(kobo(golden.statutory.nsitf));
  });

  it("starts with a byte order mark and ends every row with CRLF", () => {
    const bytes = toCsv([["a", "b"]]);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decode(bytes)).toBe("﻿a,b\r\n");
  });
});
