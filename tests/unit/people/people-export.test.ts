/**
 * Slice U.1: "Export selected to CSV" holds work details only, and every cell is safe to open
 * in Excel (formula injection: a cell starting with =, +, -, @, tab or CR opens as text).
 */
import { describe, expect, it } from "vitest";

import {
  PEOPLE_EXPORT_COLUMNS,
  peopleExportCsv,
  peopleExportFileName,
  type PeopleExportRow,
} from "@/server/people/export-csv";
import { csvCell } from "@/server/people/import/csv";
import { toExportRow, type ScopedPerson } from "@/server/people/people-scope";

const BOM = "﻿";

function row(overrides: Partial<PeopleExportRow> = {}): PeopleExportRow {
  return {
    name: "Ada Obi",
    staffId: "EMP-0001",
    jobTitle: "Security guard",
    department: "Operations",
    sites: ["Lekki gate", "Ikoyi tower"],
    lineManager: "Kola Adebayo",
    employmentType: "permanent",
    status: "active",
    startDate: "2025-01-06",
    endDate: null,
    ...overrides,
  };
}

function lines(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true);
  return csv.slice(BOM.length).split("\r\n").filter(Boolean);
}

describe("peopleExportCsv", () => {
  it("writes the fixed columns and one row per person", () => {
    const [header, first] = lines(peopleExportCsv([row()]));
    expect(header).toBe(
      "Name,Staff ID,Job title,Department,Site,Line manager,Employment type,Status,Start date,End date",
    );
    expect(first).toBe(
      "Ada Obi,EMP-0001,Security guard,Operations,Lekki gate; Ikoyi tower,Kola Adebayo,Permanent,Active,2025-01-06,",
    );
  });

  it("has no personal data or pay columns", () => {
    const header = PEOPLE_EXPORT_COLUMNS.join(" ").toLowerCase();
    for (const word of [
      "nin",
      "bvn",
      "bank",
      "account",
      "rsa",
      "pin",
      "pay",
      "salary",
      "kobo",
      "tax",
      "phone",
      "kin",
    ]) {
      expect(header.split(/[\s,]+/), word).not.toContain(word);
      expect(header, word).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  });

  it("escapes formulas so they open as text", () => {
    const csv = peopleExportCsv([
      row({
        name: "=1+1",
        staffId: "+234",
        jobTitle: "-cmd",
        department: "@SUM(A1)",
        lineManager: '=HYPERLINK("http://x","y")',
      }),
    ]);
    const [, first] = lines(csv);
    expect(first).toContain("'=1+1,");
    expect(first).toContain("'+234,");
    expect(first).toContain("'-cmd,");
    expect(first).toContain("'@SUM(A1),");
    expect(first).toContain('"\'=HYPERLINK(""http://x"",""y"")"');
  });

  it("quotes commas and labels ended people with their end date", () => {
    const [, first] = lines(
      peopleExportCsv([row({ name: "Obi, Ada", status: "ended", endDate: "2026-11-30" })]),
    );
    expect(first?.startsWith('"Obi, Ada",')).toBe(true);
    expect(first?.endsWith(",Ended,2025-01-06,2026-11-30")).toBe(true);
  });

  it("names the file by date", () => {
    expect(peopleExportFileName("2026-11-24")).toBe("people-2026-11-24.csv");
  });
});

describe("toExportRow", () => {
  it("keeps work details only, whatever else the person carries", () => {
    const person = {
      id: "w1",
      name: "Ada Obi",
      firstName: "Ada",
      lastName: "Obi",
      staffId: "EMP-0001",
      jobTitle: null,
      departmentId: null,
      departmentName: null,
      siteIds: [],
      siteNames: [],
      lineManager: "",
      lineManagerName: null,
      appRole: null,
      payType: "monthly",
      status: "active",
      invited: true,
      employmentType: "contract",
      startDate: "2025-01-06",
      endDate: null,
      // Not part of the type: a stray field must never reach the file.
      bankAccountLast4: "1234",
    } as ScopedPerson;
    const exported = toExportRow(person);
    expect(Object.keys(exported).sort()).toEqual(
      [
        "department",
        "employmentType",
        "endDate",
        "jobTitle",
        "lineManager",
        "name",
        "sites",
        "staffId",
        "startDate",
        "status",
      ].sort(),
    );
    expect(exported.status).toBe("invited");
    expect(peopleExportCsv([exported])).not.toContain("1234");
    expect(peopleExportCsv([exported])).not.toContain("Monthly");
  });
});

describe("csvCell (shared by imports and exports)", () => {
  it.each([
    ["=1+1", "'=1+1"],
    [" =1+1", "' =1+1"],
    ["  +234", "'  +234"],
    [" -cmd", "' -cmd"],
    ["\n@SUM(A1)", '"\'\n@SUM(A1)"'],
    ["\tTAB", "'\tTAB"],
  ])("escapes %j", (input, output) => {
    expect(csvCell(input)).toBe(output);
  });

  it("leaves ordinary values alone", () => {
    expect(csvCell("  Ada Obi")).toBe("  Ada Obi");
    expect(csvCell("a=b")).toBe("a=b");
  });
});
