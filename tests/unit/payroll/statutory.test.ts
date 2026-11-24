/**
 * Slice 5.6 (docs/PHASE_5.md 5.6): statutory remittances and schedules, pure parts.
 * - Grouping by tax state and PFA, and the golden statutory totals from the engine's payslip
 *   lines: pension ₦156,600, NSITF ₦8,700, ITF ₦8,700 (fixtures/october-2026-golden.json).
 * - Pension's due date: 7 working days after the pay date, skipping weekends and holidays.
 * - Other kinds: only the company's own day; status worked out on read.
 * - Schedules: formula-injection escaping, kobo to naira with 2 decimals, totals equal the
 *   remittance, exact bytes for a small PAYE file.
 */
import { describe, expect, it } from "vitest";

import golden from "../../../fixtures/october-2026-golden.json";
import { allocateKobo, parseNairaToKobo, type Kobo } from "@/lib/money";
import type { EarningLine } from "@/lib/payroll/contract";
import { grossToNet } from "@/lib/payroll/gross-to-net";
import { NTA_2025_V1 } from "@/lib/payroll/rule-set";
import {
  addWorkingDays,
  authorityLabel,
  groupStatutory,
  remittanceDueDate,
  remittanceStatus,
  remittanceTitle,
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
    expect(groups.map((g) => [g.kind, g.authorityKey, g.workerCount])).toEqual([
      ["paye", "Lagos", 5], // Grace Edet's PAYE is ₦0, so she isn't counted
      ["pension", "ARM Pension Managers", 3],
      ["pension", "Stanbic IBTC Pensions", 3],
      ["nsitf", null, 6],
      ["itf", null, 6],
    ]);
    // Employee 8% and employer 10% together for each PFA.
    const stanbic = groups.find((g) => g.authorityKey === "Stanbic IBTC Pensions")!;
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
      { kind: "pension", authorityKey: null, amountKobo: 1800n, workerCount: 2 },
    ]);
  });
});

describe("due dates", () => {
  it("makes pension due 7 working days after the pay date (Sunday 25 Oct 2026 gives Tue 3 Nov)", () => {
    expect(remittanceDueDate("pension", "2026-10-25", NO_DUE_DAYS, new Set())).toBe("2026-11-03");
  });

  it("skips weekends and the company's public holidays", () => {
    // Friday 25 Sep 2026; Thursday 1 Oct is Independence Day on this company's list.
    expect(addWorkingDays("2026-09-25", 7, new Set())).toBe("2026-10-06");
    expect(addWorkingDays("2026-09-25", 7, new Set(["2026-10-01"]))).toBe("2026-10-07");
    // A holiday on a Saturday changes nothing.
    expect(addWorkingDays("2026-09-25", 7, new Set(["2026-10-03"]))).toBe("2026-10-06");
    // Christmas and Boxing Day 2026 (Friday and Saturday), and 1 Jan 2027 (Friday).
    expect(
      remittanceDueDate(
        "pension",
        "2026-12-25",
        NO_DUE_DAYS,
        new Set(["2026-12-25", "2026-12-26", "2027-01-01"]),
      ),
    ).toBe("2027-01-06");
  });

  it("gives PAYE, NHF, NSITF and ITF a due date only when the company set a day", () => {
    for (const kind of ["paye", "nhf", "nsitf", "itf"] as const) {
      expect(remittanceDueDate(kind, "2026-10-25", NO_DUE_DAYS, new Set())).toBeNull();
    }
    const days = { paye: 10, nhf: 28, nsitf: 1, itf: null };
    expect(remittanceDueDate("paye", "2026-10-25", days, new Set())).toBe("2026-11-10");
    expect(remittanceDueDate("nhf", "2026-12-25", days, new Set())).toBe("2027-01-28");
    expect(remittanceDueDate("nsitf", "2026-10-25", days, new Set())).toBe("2026-11-01");
    expect(remittanceDueDate("itf", "2026-10-25", days, new Set())).toBeNull();
  });

  it("works status out on read", () => {
    expect(remittanceStatus({ dueDate: "2026-11-03", paid: false }, "2026-11-03")).toBe("due");
    expect(remittanceStatus({ dueDate: "2026-11-03", paid: false }, "2026-11-04")).toBe("overdue");
    expect(remittanceStatus({ dueDate: "2026-11-03", paid: true }, "2026-12-01")).toBe("paid");
    expect(remittanceStatus({ dueDate: null, paid: false }, "2026-12-01")).toBe("no_due_date");
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
    expect(lines[0]).toBe(
      "﻿Staff ID,Name,RSA PIN,Employee 8% (NGN),Employer 10% (NGN),Total (NGN)",
    );
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
