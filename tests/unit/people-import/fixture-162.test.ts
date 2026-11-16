import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildPeopleImport162, toCsv } from "../../../scripts/fixtures/people-import-162";
import { validatePeopleImport, type ImportResult, type RowResult } from "@/server/people/import";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

interface Expected {
  summary: Record<string, unknown>;
  attention: { row: number; status: string; problems: unknown[]; warnings: unknown[] }[];
  otherWarnings: { row: number; code: string; message: string }[];
  newNames: {
    departments: string[];
    clients: string[];
    projects: { client: string; name: string }[];
    sites: { client: string; name: string }[];
  };
}

const expected = JSON.parse(
  readFileSync(fixture("people-import-162.expected.json"), "utf8"),
) as Expected;

async function validate(name: string): Promise<Extract<ImportResult, { ok: true }>> {
  const bytes = new Uint8Array(readFileSync(fixture(name)));
  const result = await validatePeopleImport({ name, bytes }, {});
  if (!result.ok) throw new Error(`Fixture ${name} failed: ${JSON.stringify(result.problems)}`);
  return result;
}

const byKey = <T>(items: T[]) =>
  [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function checkAgainstExpected(result: Extract<ImportResult, { ok: true }>) {
  expect(result.summary).toMatchObject(expected.summary);
  expect(
    result.attention.map((row) => ({
      row: row.rowNumber,
      status: row.status,
      problems: row.problems,
      warnings: row.warnings,
    })),
  ).toEqual(expected.attention);
  expect(
    result.rows
      .filter((row) => row.status === "ready")
      .flatMap((row) =>
        row.warnings.map((w) => ({ row: row.rowNumber, code: w.code, message: w.message })),
      ),
  ).toEqual(expected.otherWarnings);
  expect(byKey(result.summary.newNames.departments)).toEqual(byKey(expected.newNames.departments));
  expect(byKey(result.summary.newNames.clients)).toEqual(byKey(expected.newNames.clients));
  expect(byKey(result.summary.newNames.projects)).toEqual(byKey(expected.newNames.projects));
  expect(byKey(result.summary.newNames.sites)).toEqual(byKey(expected.newNames.sites));
}

describe("fixtures/people-import-162", () => {
  it("is the deterministic output of scripts/fixtures/people-import-162.ts", () => {
    expect(readFileSync(fixture("people-import-162.csv"), "utf8")).toBe(
      toCsv(buildPeopleImport162()),
    );
  });

  it("validates to 158 ready and 4 for attention, as the Setup board shows (CSV)", async () => {
    const result = await validate("people-import-162.csv");
    expect(result.format).toBe("csv");
    checkAgainstExpected(result);
  });

  it("gives the same result from the .xlsx copy", async () => {
    const csv = await validate("people-import-162.csv");
    const xlsx = await validate("people-import-162.xlsx");
    expect(xlsx.format).toBe("xlsx");
    checkAgainstExpected(xlsx);
    // Raw cells differ only in how Excel stores money ("60,000" in the CSV, 60000 in the
    // .xlsx); everything the validator derives from them is identical.
    const derived = (rows: RowResult[]) =>
      rows.map(({ rowNumber, status, problems, warnings, normalised }) => ({
        rowNumber,
        status,
        problems,
        warnings,
        normalised,
      }));
    expect(derived(xlsx.rows)).toEqual(derived(csv.rows));
    expect(xlsx.summary).toEqual(csv.summary);
  });

  it("imports row 88 as-is with supervisor clock-in and holds the other three", async () => {
    const result = await validate("people-import-162.csv");
    const row = (n: number) => result.rows.find((r) => r.rowNumber === n) as RowResult;
    expect(row(88).normalised?.worker.supervisorClockIn).toBe(true);
    expect(row(12).normalised?.worker.supervisorClockIn).toBe(false);
    for (const n of [23, 57, 140]) expect(row(n).normalised).toBeNull();
  });

  it("normalises pay to exact kobo from 105000, 60,000 and 62500.50 style cells", async () => {
    const result = await validate("people-import-162.csv");
    const row = (n: number) => result.rows.find((r) => r.rowNumber === n) as RowResult;
    // Row 4: Kola Adebayo, ₦105,000 + ₦63,000 + ₦42,000 + ₦15,000 (₦225,000 a month on the board).
    expect(row(4).normalised?.payRate).toEqual({
      payType: "monthly",
      basicKobo: 10_500_000n,
      housingKobo: 6_300_000n,
      transportKobo: 4_200_000n,
      otherAllowancesKobo: 1_500_000n,
      dailyRateKobo: 0n,
      currency: "NGN",
      effectiveFrom: row(4).normalised?.worker.startDate,
    });
    // Row 2: "450,000" with comma grouping.
    expect(row(2).normalised?.payRate?.basicKobo).toBe(45_000_000n);
    // Row 23 would be ₦62,500.50 basic; any row of that pay shape keeps the 50 kobo.
    const withKobo = result.rows.find((r) => r.raw.basic_monthly === "62500.50" && r.normalised);
    expect(withKobo?.normalised?.payRate?.basicKobo).toBe(6_250_050n);
    // Relief guards are paid daily.
    const daily = result.rows.find((r) => r.normalised?.payRate?.payType === "daily");
    expect(daily?.normalised?.payRate?.dailyRateKobo).toBeGreaterThan(0n);
  });

  it("generates staff IDs in the company's pattern for blank rows", async () => {
    const result = await validate("people-import-162.csv");
    const ids = result.rows
      .filter((r) => r.normalised?.worker.staffIdGenerated)
      .map((r) => r.normalised?.worker.staffId);
    expect(ids).toEqual(["AFS-0163", "AFS-0164"]);
  });
});
