import "server-only";

import { readSheet } from "read-excel-file/node";

import { checkZipArchive } from "./zip-guard";

/**
 * Reads the first sheet of an `.xlsx` file as rows of strings. Server only.
 *
 * - Values only: formulas are never evaluated. A formula cell gives the value the spreadsheet
 *   app saved with it, or blank when there is none.
 * - Numbers come back as the exact digits stored in the file (`parseNumber` returns the raw
 *   string), so naira amounts never pass through a float.
 * - Which cells were number cells is reported alongside, so the validator can tell when Excel
 *   dropped a leading zero from an account number or NIN typed into a number cell.
 * - Date cells become `YYYY-MM-DD` (the parser gives a UTC midnight `Date`).
 * - The archive is checked for zip bombs before parsing.
 */

export const XLSX_LIMITS = {
  maxEntries: 200,
  /** Expanded XML inside the archive. A 5,000-row, 32-column sheet is well under 20 MB. */
  maxExpandedBytes: 50 * 1024 * 1024,
} as const;

export type XlsxReadResult =
  | {
      ok: true;
      rows: string[][];
      /** `numeric[r][c]` is true when that cell was a number cell. Same shape as `rows`. */
      numeric: boolean[][];
    }
  | { ok: false; reason: "unreadable" | "too_large" };

/** A number cell, kept as the exact digits stored in the file. */
class NumberCell {
  constructor(readonly digits: string) {}
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (cell instanceof NumberCell) return cell.digits;
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return "";
    return `${pad(cell.getUTCFullYear(), 4)}-${pad(cell.getUTCMonth() + 1, 2)}-${pad(cell.getUTCDate(), 2)}`;
  }
  return "";
}

export async function readXlsxRows(bytes: Uint8Array): Promise<XlsxReadResult> {
  const zip = checkZipArchive(bytes, XLSX_LIMITS);
  if (!zip.ok)
    return { ok: false, reason: zip.reason === "too_large" ? "too_large" : "unreadable" };
  try {
    const data = await readSheet<NumberCell>(Buffer.from(bytes), 1, {
      parseNumber: (raw: string) => new NumberCell(raw),
      trim: false,
    });
    return {
      ok: true,
      rows: data.map((row) => row.map(cellToString)),
      numeric: data.map((row) => row.map((cell) => cell instanceof NumberCell)),
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
