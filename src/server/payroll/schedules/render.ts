/**
 * Statutory schedules (slice 5.6; docs/PHASE_5.md 5.6): one CSV per remittance, listing the
 * workers it covers. Pure: the caller reads the payslips and workers (and decrypts RSA PINs on
 * the server for pension) and passes them in; nothing here logs or keeps a value.
 *
 * - PAYE, per tax state: staff ID, name, TIN, gross, annual taxable income, PAYE.
 * - Pension, per PFA: staff ID, name, RSA PIN, employee and employer shares, total.
 * - NHF: staff ID, name, basic, NHF.
 * - NSITF and ITF: staff ID, name, gross (the levy base), the levy.
 * A last row gives the worker count and the totals; the total of the amount column equals the
 * remittance.
 */
import { sumKobo, type Kobo } from "@/lib/money";
import type { RemittanceKind } from "@/lib/payroll/statutory";

import { csvCell, nairaCell, toCsv, type CsvRow } from "./csv";

export interface ScheduleWorkerRow {
  staffId: string;
  name: string;
  /** PAYE only. Null when none is on file. */
  tin: string | null;
  /** Pension only, decrypted on the server. Null when none is on file. */
  rsaPin: string | null;
  grossKobo: Kobo;
  /** The payslip's annual taxable income (its trace's `taxable` step), for PAYE. */
  annualTaxableKobo: Kobo | null;
  /** Basic pay (the payslip's `basic` lines), for NHF. */
  basicKobo: Kobo;
  payeKobo: Kobo;
  pensionEmployeeKobo: Kobo;
  pensionEmployerKobo: Kobo;
  nhfKobo: Kobo;
  nsitfKobo: Kobo;
  itfKobo: Kobo;
}

export interface RenderedSchedule {
  bytes: Uint8Array;
  /** Workers listed. */
  workerCount: number;
  /** The total of the amount column: what the remittance owes. */
  totalKobo: Kobo;
}

const NOT_ON_FILE = "Not on file";

/** The amount a worker owes this kind; workers with 0 are left out of the schedule. */
export function scheduleAmount(kind: RemittanceKind, row: ScheduleWorkerRow): Kobo {
  switch (kind) {
    case "paye":
      return row.payeKobo;
    case "pension":
      return row.pensionEmployeeKobo + row.pensionEmployerKobo;
    case "nhf":
      return row.nhfKobo;
    case "nsitf":
      return row.nsitfKobo;
    case "itf":
      return row.itfKobo;
  }
}

function header(kind: RemittanceKind): string[] {
  switch (kind) {
    case "paye":
      return [
        "Staff ID",
        "Name",
        "TIN",
        "Gross pay (NGN)",
        "Annual taxable income (NGN)",
        "PAYE (NGN)",
      ];
    case "pension":
      return ["Staff ID", "Name", "RSA PIN", "Employee (NGN)", "Employer (NGN)", "Total (NGN)"];
    case "nhf":
      return ["Staff ID", "Name", "Basic pay (NGN)", "NHF (NGN)"];
    case "nsitf":
      return ["Staff ID", "Name", "Gross pay (NGN)", "NSITF (NGN)"];
    case "itf":
      return ["Staff ID", "Name", "Gross pay (NGN)", "ITF (NGN)"];
  }
}

function body(kind: RemittanceKind, r: ScheduleWorkerRow): CsvRow {
  const id = [csvCell(r.staffId), csvCell(r.name)];
  switch (kind) {
    case "paye":
      return [
        ...id,
        csvCell(r.tin ?? NOT_ON_FILE),
        nairaCell(r.grossKobo),
        r.annualTaxableKobo === null ? "" : nairaCell(r.annualTaxableKobo),
        nairaCell(r.payeKobo),
      ];
    case "pension":
      return [
        ...id,
        csvCell(r.rsaPin ?? NOT_ON_FILE),
        nairaCell(r.pensionEmployeeKobo),
        nairaCell(r.pensionEmployerKobo),
        nairaCell(r.pensionEmployeeKobo + r.pensionEmployerKobo),
      ];
    case "nhf":
      return [...id, nairaCell(r.basicKobo), nairaCell(r.nhfKobo)];
    case "nsitf":
      return [...id, nairaCell(r.grossKobo), nairaCell(r.nsitfKobo)];
    case "itf":
      return [...id, nairaCell(r.grossKobo), nairaCell(r.itfKobo)];
  }
}

function totals(kind: RemittanceKind, rows: readonly ScheduleWorkerRow[]): CsvRow {
  const sum = (pick: (r: ScheduleWorkerRow) => Kobo) => nairaCell(sumKobo(rows.map(pick)));
  const label = [
    csvCell("Total"),
    csvCell(`${rows.length} ${rows.length === 1 ? "worker" : "workers"}`),
  ];
  switch (kind) {
    case "paye":
      return [...label, "", sum((r) => r.grossKobo), "", sum((r) => r.payeKobo)];
    case "pension":
      return [
        ...label,
        "",
        sum((r) => r.pensionEmployeeKobo),
        sum((r) => r.pensionEmployerKobo),
        sum((r) => r.pensionEmployeeKobo + r.pensionEmployerKobo),
      ];
    case "nhf":
      return [...label, sum((r) => r.basicKobo), sum((r) => r.nhfKobo)];
    case "nsitf":
      return [...label, sum((r) => r.grossKobo), sum((r) => r.nsitfKobo)];
    case "itf":
      return [...label, sum((r) => r.grossKobo), sum((r) => r.itfKobo)];
  }
}

/**
 * The schedule for one remittance: `rows` are the payslips of its run with its authority (the
 * caller filters by tax state or PFA); workers owing 0 are left out. Ordered by staff ID.
 */
export function renderSchedule(
  kind: RemittanceKind,
  rows: readonly ScheduleWorkerRow[],
): RenderedSchedule {
  const listed = rows
    .filter((r) => scheduleAmount(kind, r) > 0n)
    .toSorted((a, b) => (a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0));
  const csv: CsvRow[] = [header(kind).map(csvCell), ...listed.map((r) => body(kind, r))];
  csv.push(totals(kind, listed));
  return {
    bytes: toCsv(csv),
    workerCount: listed.length,
    totalKobo: sumKobo(listed.map((r) => scheduleAmount(kind, r))),
  };
}
