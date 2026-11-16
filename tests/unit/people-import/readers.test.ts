import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import writeXlsxFile from "write-excel-file/node";
import { describe, expect, it } from "vitest";

import { TEMPLATE_COLUMNS, mapHeader, normaliseHeaderName } from "@/server/people/import/columns";
import { decodeCsvBytes, parseCsv } from "@/server/people/import/csv";
import { readImportFile } from "@/server/people/import/read-file";
import { checkZipArchive } from "@/server/people/import/zip-guard";

const templatePath = fileURLToPath(
  new URL("../../../fixtures/employee_import_template.csv", import.meta.url),
);

describe("template columns", () => {
  it("match the header of fixtures/employee_import_template.csv (32 columns)", () => {
    const parsed = parseCsv(readFileSync(templatePath, "utf8"));
    if (!parsed.ok) throw new Error("template did not parse");
    expect(parsed.rows[0]).toEqual([...TEMPLATE_COLUMNS]);
    expect(TEMPLATE_COLUMNS).toHaveLength(32);
  });

  it("maps headers loosely and reports missing, duplicated and unknown columns", () => {
    expect(normaliseHeaderName("\uFEFF Employee ID ")).toBe("employee_id");
    const map = mapHeader(["Staff ID", "First Name", "first_name", "Favourite colour"]);
    expect(map.indexOf.employee_id).toBe(0);
    expect(map.indexOf.first_name).toBe(1);
    expect(map.duplicated).toEqual(["first_name"]);
    expect(map.ignored).toEqual(["Favourite colour"]);
    expect(map.missingRequired).toContain("last_name");
    expect(map.missingRequired).not.toContain("employee_id");
  });
});

describe("parseCsv", () => {
  it("handles quotes, embedded commas, line breaks, doubled quotes and CRLF", () => {
    const result = parseCsv('a,b,c\r\n"x, y","line\nbreak","say ""hi"""\r\n1,,3');
    expect(result).toEqual({
      ok: true,
      rows: [
        ["a", "b", "c"],
        ["x, y", "line\nbreak", 'say "hi"'],
        ["1", "", "3"],
      ],
    });
  });

  it("strips a byte order mark and keeps text exactly as written", () => {
    expect(parseCsv("\uFEFFbasic\n105,000\n")).toEqual({
      ok: true,
      rows: [["basic"], ["105", "000"]],
    });
    expect(parseCsv('basic\n"105,000"\n')).toEqual({ ok: true, rows: [["basic"], ["105,000"]] });
  });

  it("reports an unclosed quote with its row", () => {
    expect(parseCsv('a\nb\n"oops,1\n2')).toEqual({
      ok: false,
      reason: "unclosed_quote",
      rowNumber: 3,
    });
  });

  it("decodes Windows-1252 when the bytes are not UTF-8", () => {
    expect(decodeCsvBytes(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
    expect(decodeCsvBytes(new TextEncoder().encode("Café"))).toBe("Café");
  });
});

/** Cells as write-excel-file takes them; loosely typed so formula cells fit. */
type XlsxCell = { value: string | number | Date; type?: unknown; format?: string } | null;

async function xlsxBytes(rows: XlsxCell[][]): Promise<Uint8Array> {
  return new Uint8Array(await writeXlsxFile(rows as never).toBuffer());
}

describe("readImportFile", () => {
  it("reads .xlsx numbers as their exact digits and dates as ISO", async () => {
    const bytes = await xlsxBytes([
      [{ value: "basic_monthly" }, { value: "start_date" }, { value: "phone" }],
      [
        { value: 105000.5, type: Number },
        { value: new Date("2024-03-01T00:00:00Z"), type: Date, format: "dd/mm/yyyy" },
        { value: "08031234567", type: String },
      ],
      [{ value: 123456789012345, type: Number }, null, null],
    ]);
    const result = await readImportFile({ name: "staff.xlsx", bytes });
    expect(result).toEqual({
      ok: true,
      format: "xlsx",
      rows: [
        ["basic_monthly", "start_date", "phone"],
        ["105000.5", "2024-03-01", "08031234567"],
        ["123456789012345", "", ""],
      ],
    });
  });

  it("ignores formulas: a formula cell without a saved value reads as blank", async () => {
    const bytes = await xlsxBytes([
      [{ value: "basic_monthly" }, { value: "housing_monthly" }],
      [
        { value: 100000, type: Number },
        { value: "=A2*0.6", type: "Formula" },
      ],
    ]);
    const result = await readImportFile({ name: "staff.xlsx", bytes });
    expect(result.ok && result.rows[1]).toEqual(["100000", ""]);
  });

  it("refuses files over 5 MB, empty files and unsupported types", async () => {
    const big = await readImportFile({
      name: "big.csv",
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
    });
    expect(!big.ok && big.problem.code).toBe("file_too_large");
    const empty = await readImportFile({ name: "empty.csv", bytes: new Uint8Array() });
    expect(!empty.ok && empty.problem.code).toBe("file_empty");
    const xls = await readImportFile({
      name: "old.xls",
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]),
    });
    expect(!xls.ok && xls.problem.code).toBe("file_type_unsupported");
    const pdf = await readImportFile({
      name: "staff.pdf",
      bytes: new TextEncoder().encode("%PDF-1.7"),
    });
    expect(!pdf.ok && pdf.problem.code).toBe("file_type_unsupported");
  });

  it("refuses a zip renamed to .csv and a broken .xlsx", async () => {
    const xlsx = await xlsxBytes([[{ value: "a" }]]);
    const renamed = await readImportFile({ name: "staff.csv", bytes: xlsx });
    expect(!renamed.ok && renamed.problem.code).toBe("file_type_unsupported");
    const broken = await readImportFile({ name: "staff.xlsx", bytes: xlsx.slice(0, 200) });
    expect(!broken.ok && broken.problem.code).toBe("file_unreadable");
  });

  it("reports an unclosed CSV quote", async () => {
    const result = await readImportFile({
      name: "staff.csv",
      bytes: new TextEncoder().encode('employee_id\n"AFS-1\n'),
    });
    expect(!result.ok && result.problem.code).toBe("csv_unclosed_quote");
  });
});

/** A minimal zip with one deflated entry, built by hand. */
function zipWith(
  name: string,
  content: Uint8Array,
  options: { trailingEntry?: boolean } = {},
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const data = deflateRawSync(content);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, content.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);

  // An extra local entry the central directory doesn't list (a hidden entry).
  const hidden = options.trailingEntry ? local.slice() : new Uint8Array();

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, content.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const centralOffset = local.length + data.length + hidden.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, centralOffset, true);

  const out = new Uint8Array(centralOffset + central.length + eocd.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(hidden, local.length + data.length);
  out.set(central, centralOffset);
  out.set(eocd, centralOffset + central.length);
  return out;
}

describe("checkZipArchive (zip-bomb guard)", () => {
  const limits = { maxEntries: 10, maxExpandedBytes: 1024 * 1024 };

  it("accepts a small archive and reports its real expanded size", () => {
    const result = checkZipArchive(zipWith("a.xml", new Uint8Array(1000)), limits);
    expect(result).toEqual({ ok: true, expandedBytes: 1000 });
  });

  it("refuses an entry that expands past the cap, whatever its header claims", () => {
    // 20 MB of zeros deflates to about 20 KB.
    const bomb = zipWith("sheet1.xml", new Uint8Array(20 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(checkZipArchive(bomb, limits)).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses data the central directory doesn't account for", () => {
    const hidden = zipWith("a.xml", new Uint8Array(10), { trailingEntry: true });
    expect(checkZipArchive(hidden, limits)).toEqual({ ok: false, reason: "not_zip" });
  });

  it("refuses non-zip bytes", () => {
    expect(
      checkZipArchive(new TextEncoder().encode("not a zip at all, just text"), limits),
    ).toEqual({
      ok: false,
      reason: "not_zip",
    });
  });

  it("is applied before the spreadsheet parser runs", async () => {
    const bomb = zipWith("xl/worksheets/sheet1.xml", new Uint8Array(60 * 1024 * 1024));
    const result = await readImportFile({ name: "bomb.xlsx", bytes: bomb });
    expect(!result.ok && result.problem.code).toBe("file_too_large");
  });
});
