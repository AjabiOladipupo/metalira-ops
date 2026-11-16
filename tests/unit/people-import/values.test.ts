import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkNin,
  checkNuban,
  maskMobileForMessage,
  parseEmploymentType,
  parseImportDate,
  parseImportEmail,
  parseImportNaira,
  parseNigerianMobile,
  parsePayType,
  parseRsaPin,
  parseTin,
  parseYesNo,
} from "@/server/people/import/values";
import { normaliseStaffId, staffIdKey } from "@/server/people/import/staff-id";

describe("parseImportNaira (kobo, never floats)", () => {
  it.each([
    ["105000", 10_500_000n],
    ["105,000", 10_500_000n],
    ["105000.50", 10_500_050n],
    ["105000.5", 10_500_050n],
    ["105,000.05", 10_500_005n],
    ["1,234,567.89", 123_456_789n],
    ["0", 0n],
    ["0.01", 1n],
    [" 42000 ", 4_200_000n],
    // The cap, ₦1,000,000,000, is accepted.
    ["1,000,000,000", 100_000_000_000n],
    ["1000000000.00", 100_000_000_000n],
    ["999999999.99", 99_999_999_999n],
    // The classic float trap: 0.1 + 0.2 style values stay exact.
    ["0.30", 30n],
    ["19.99", 1999n],
  ])("parses %j to %s kobo", (input, kobo) => {
    expect(parseImportNaira(input)).toEqual({ ok: true, value: kobo });
  });

  it.each([
    "",
    "₦105,000",
    "-5000",
    "+5000",
    "105 000",
    "105000.505",
    "1,05,000",
    "10,5000",
    "105,00",
    ",105000",
    "105000.",
    ".50",
    "1e5",
    "1.05E5",
    "NaN",
    "Infinity",
    "0x10",
    "105k",
    "N105000",
  ])("rejects %j", (input) => {
    expect(parseImportNaira(input)).toEqual({ ok: false, reason: "not_amount" });
  });

  it.each([
    "1000000000.01",
    "1,000,000,001",
    "45,000,000,000",
    "100000000000000000",
    // Past the Postgres bigint ceiling in kobo: refused, never stored.
    "99999999999999999999999",
  ])("refuses %j as more than the ₦1,000,000,000 cap", (input) => {
    expect(parseImportNaira(input)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("parseNigerianMobile", () => {
  it.each([
    ["08031234567", "08031234567"],
    ["0803 123 4567", "08031234567"],
    ["0803-123-4567", "08031234567"],
    ["+2348031234567", "08031234567"],
    ["2348031234567", "08031234567"],
    ["8031234567", "08031234567"], // leading zero dropped by a spreadsheet
    ["07061234567", "07061234567"],
    ["08101234567", "08101234567"],
    ["09051234567", "09051234567"],
    ["09161234567", "09161234567"],
  ])("accepts %j as %j", (input, phone) => {
    expect(parseNigerianMobile(input)).toEqual({ ok: true, value: phone });
  });

  it.each([
    "0803123456",
    "080312345678",
    "01234567890",
    "08231234567",
    "phone",
    "+4478031234567",
    "",
  ])("rejects %j", (input) => {
    expect(parseNigerianMobile(input)).toEqual({ ok: false });
  });

  it("masks for messages as on the board", () => {
    expect(maskMobileForMessage("08030001120")).toBe("0803 ••• 1120");
  });
});

describe("checkNuban and checkNin", () => {
  it("accepts exactly 10 and 11 digits, allowing spaces and dashes", () => {
    expect(checkNuban("0123456789")).toEqual({ ok: true, value: "0123456789" });
    expect(checkNuban("0123 456 789")).toEqual({ ok: true, value: "0123456789" });
    expect(checkNin("12345678901")).toEqual({ ok: true, value: "12345678901" });
  });

  it("reports the digit count when the length is wrong", () => {
    expect(checkNuban("123456789")).toEqual({ ok: false, reason: "wrong_length", digits: 9 });
    expect(checkNin("1234567890")).toEqual({ ok: false, reason: "wrong_length", digits: 10 });
  });

  it("rejects letters and symbols", () => {
    expect(checkNuban("01234A6789")).toEqual({ ok: false, reason: "not_digits" });
    expect(checkNin("1234.567890")).toEqual({ ok: false, reason: "not_digits" });
  });
});

describe("parseRsaPin and parseTin", () => {
  it("accepts PEN and 12 digits in any case and spacing", () => {
    expect(parseRsaPin("PEN100000000001")).toEqual({ ok: true, value: "PEN100000000001" });
    expect(parseRsaPin("pen 1000 0000 0001")).toEqual({ ok: true, value: "PEN100000000001" });
  });

  it.each(["PEN10000000000", "PEN1000000000012", "100000000001", "PIN100000000001", "PEN<b>"])(
    "rejects RSA PIN %j",
    (input) => {
      expect(parseRsaPin(input)).toEqual({ ok: false });
    },
  );

  it("accepts digits in dash-separated groups as a TIN", () => {
    expect(parseTin("20000001-0001")).toEqual({ ok: true, value: "20000001-0001" });
    expect(parseTin("1234567890")).toEqual({ ok: true, value: "1234567890" });
  });

  it.each(["=1+1", "-12345678", "12345678-", "12--34", "TIN 1234", "1".repeat(21)])(
    "rejects TIN %j",
    (input) => {
      expect(parseTin(input)).toEqual({ ok: false });
    },
  );
});

describe("normaliseStaffId", () => {
  it.each([
    ["AFS-0042", "AFS-0042"],
    ["afs/0042", "afs/0042"],
    ["EMP_12.3", "EMP_12.3"],
    // Fullwidth lookalikes fold to ASCII, so they collide with the real ID.
    ["ＡＦＳ-００４２", "AFS-0042"],
  ])("accepts %j as %j", (input, id) => {
    expect(normaliseStaffId(input)).toBe(id);
  });

  it.each([
    "<a href=x>",
    "AFS<0042",
    "https://evil.example",
    "AFS:0042",
    "AFS\u00000042",
    "AFS\n0042",
    "kola@example.com",
    "AFS 0042",
    "=HYPERLINK(1)",
    "-0042",
    "+0042",
    "АFS-0042", // Cyrillic А
    "A".repeat(41),
  ])("rejects %j", (input) => {
    expect(normaliseStaffId(input)).toBeNull();
  });

  it("compares IDs after the same normalisation, ignoring case", () => {
    expect(staffIdKey("ＡＦＳ-００４２")).toBe(staffIdKey("afs-0042"));
  });
});

describe("parseImportDate", () => {
  it.each([
    ["2024-03-01", "2024-03-01"],
    ["01/03/2024", "2024-03-01"], // day first
    ["1/3/2024", "2024-03-01"],
    ["2024-02-29", "2024-02-29"],
    ["2000-02-29", "2000-02-29"],
  ])("accepts %j as %j", (input, iso) => {
    expect(parseImportDate(input)).toEqual({ ok: true, value: iso });
  });

  it.each([
    "2023-02-29",
    "1900-02-29",
    "2024-13-01",
    "2024-04-31",
    "31/02/2024",
    "2024/03/01",
    "March 1 2024",
    "45352",
    "",
  ])("rejects %j", (input) => {
    expect(parseImportDate(input)).toEqual({ ok: false });
  });
});

describe("enumerations", () => {
  it("reads employment types in any case", () => {
    expect(parseEmploymentType("Permanent")).toEqual({ ok: true, value: "permanent" });
    expect(parseEmploymentType(" CASUAL ")).toEqual({ ok: true, value: "casual" });
    expect(parseEmploymentType("Daily")).toEqual({ ok: true, value: "daily" });
    expect(parseEmploymentType("Full time")).toEqual({ ok: false });
  });

  it("accepts Monthly and Daily pay, and calls out Hourly", () => {
    expect(parsePayType("Monthly")).toEqual({ ok: true, value: "monthly" });
    expect(parsePayType("daily")).toEqual({ ok: true, value: "daily" });
    expect(parsePayType("Hourly")).toEqual({ ok: false, reason: "hourly" });
    expect(parsePayType("Weekly")).toEqual({ ok: false, reason: "unknown" });
  });

  it("reads yes/no flags", () => {
    expect(parseYesNo("Y")).toEqual({ ok: true, value: true });
    expect(parseYesNo("no")).toEqual({ ok: true, value: false });
    expect(parseYesNo("TRUE")).toEqual({ ok: true, value: true });
    expect(parseYesNo("maybe")).toEqual({ ok: false });
  });

  it("checks email shape", () => {
    expect(parseImportEmail(" Kola@Example.com ")).toEqual({ ok: true, value: "kola@example.com" });
    expect(parseImportEmail("kola@example")).toEqual({ ok: false });
    expect(parseImportEmail("kola example.com")).toEqual({ ok: false });
  });
});

describe("no floats in the import library", () => {
  it("never converts text with parseFloat, parseInt, Number() or toFixed", () => {
    const dir = fileURLToPath(new URL("../../../src/server/people/import/", import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}${file}`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/parseFloat|parseInt\(|Number\(|Number\.parse|toFixed\(/);
    }
  });
});
