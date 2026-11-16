/**
 * A small RFC 4180 CSV reader: comma separated, double-quoted fields may hold commas, line
 * breaks and doubled quotes (`""`). Accepts CRLF or LF line endings and a UTF-8 byte order mark.
 * Every cell comes back as the exact text in the file; nothing is converted to a number.
 */

export type CsvParseResult =
  { ok: true; rows: string[][] } | { ok: false; reason: "unclosed_quote"; rowNumber: number };

export function parseCsv(text: string): CsvParseResult {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteStartRow = 0;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
      quoteStartRow = rows.length + 1;
      i += 1;
    } else if (char === ",") {
      endField();
      i += 1;
    } else if (char === "\r" && input[i + 1] === "\n") {
      endRow();
      i += 2;
    } else if (char === "\n" || char === "\r") {
      endRow();
      i += 1;
    } else {
      field += char;
      i += 1;
    }
  }

  if (inQuotes) return { ok: false, reason: "unclosed_quote", rowNumber: quoteStartRow };
  // A file that ends without a final line break still has a last row.
  if (field !== "" || row.length > 0) endRow();
  return { ok: true, rows };
}

/**
 * Decodes CSV bytes. UTF-8 first; Excel on Windows saves "CSV" in Windows-1252, so a file that
 * isn't valid UTF-8 is read as Windows-1252 instead.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Characters that make a spreadsheet app treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell for a file people will open in Excel. A value starting with `=`, `+`, `-`, `@`,
 * tab or carriage return is prefixed with `'` so it shows as text and never runs as a formula
 * (CSV formula injection); then the cell is quoted if it holds a quote, comma or line break.
 */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Writes rows as CSV (CRLF line endings, UTF-8 byte order mark so Excel reads accents), with
 * every cell escaped by `csvCell`. Every CSV download built from imported or typed values goes
 * through this, starting with "Download problems (.csv)" in slice 1.8.
 */
export function formatCsv(rows: readonly (readonly string[])[]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
