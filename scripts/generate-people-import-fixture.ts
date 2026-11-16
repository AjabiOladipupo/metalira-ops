/**
 * Writes fixtures/people-import-162.csv and fixtures/people-import-162.xlsx from the same
 * deterministic data (scripts/fixtures/people-import-162.ts).
 *
 *   pnpm fixtures:people
 *
 * The .xlsx is what a person would save from Excel: money as number cells, the start date as a
 * date cell, phones and account numbers as text (so leading zeros survive). The expected result,
 * fixtures/people-import-162.expected.json, is written by hand from the Setup board and is not
 * generated, so the unit tests check the validator against it rather than against itself.
 *
 * The CSV is byte-for-byte deterministic (a unit test checks it). The .xlsx cells are too, but
 * the zip writer stamps the current time on each entry, so its bytes change on every run: only
 * commit a new .xlsx when the data changes.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import writeXlsxFile from "write-excel-file/node";

import {
  FIXTURE_DATE_COLUMNS,
  FIXTURE_MONEY_COLUMNS,
  PEOPLE_IMPORT_COLUMNS,
  buildPeopleImport162,
  toCsv,
} from "./fixtures/people-import-162";

// Run from the repository root (pnpm runs scripts there).
const csvPath = resolve("fixtures/people-import-162.csv");
const xlsxPath = resolve("fixtures/people-import-162.xlsx");

const rows = buildPeopleImport162();
writeFileSync(csvPath, toCsv(rows));

type Cell = {
  value: string | number | Date;
  type?: typeof String | typeof Number | typeof Date;
  format?: string;
} | null;

const header: Cell[] = PEOPLE_IMPORT_COLUMNS.map((name) => ({ value: name, type: String }));
const body: Cell[][] = rows.map((row) =>
  PEOPLE_IMPORT_COLUMNS.map((key): Cell => {
    const value = row[key];
    if (value === "") return null;
    if (FIXTURE_MONEY_COLUMNS.includes(key)) {
      // Test tooling only: Excel stores these as numbers, so the fixture does too. The
      // validator reads them back as the exact digits in the file, never as floats.
      return { value: Number(value.replace(/,/g, "")), type: Number };
    }
    if (FIXTURE_DATE_COLUMNS.includes(key)) {
      return { value: new Date(`${value}T00:00:00Z`), type: Date, format: "yyyy-mm-dd" };
    }
    return { value, type: String };
  }),
);

async function main() {
  const bytes = await writeXlsxFile([header, ...body], { sheet: "Employees" }).toBuffer();
  writeFileSync(xlsxPath, bytes);
  console.log(`Wrote ${rows.length} rows to ${csvPath} and ${xlsxPath}`);
}

void main();
