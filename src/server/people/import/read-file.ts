import "server-only";

import { decodeCsvBytes, parseCsv } from "./csv";
import { IMPORT_LIMITS } from "./limits";
import type { FileProblem, ImportFormat } from "./types";
import { readXlsxRows } from "./xlsx";

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
}

export type ReadFileResult =
  | { ok: true; format: ImportFormat; rows: string[][] }
  | { ok: false; format: ImportFormat | null; problem: FileProblem };

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const; // legacy .xls

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

const UNSUPPORTED: FileProblem = {
  code: "file_type_unsupported",
  message: "Upload a CSV or Excel (.xlsx) file. Save older .xls files as .xlsx first.",
};

/**
 * Picks the format from the file's first bytes (not only its name), applies the size cap and
 * returns the cells of the first sheet as strings.
 */
export async function readImportFile(file: ImportFile): Promise<ReadFileResult> {
  const name = file.name.trim().toLowerCase();
  if (file.bytes.byteLength > IMPORT_LIMITS.maxFileBytes) {
    return {
      ok: false,
      format: null,
      problem: {
        code: "file_too_large",
        message: "The file is larger than 5 MB. Split it into smaller files and upload each one.",
      },
    };
  }
  if (file.bytes.byteLength === 0) {
    return {
      ok: false,
      format: null,
      problem: {
        code: "file_empty",
        message: "The file is empty. Fill the template and upload it again.",
      },
    };
  }

  if (startsWith(file.bytes, ZIP_MAGIC)) {
    if (!name.endsWith(".xlsx")) return { ok: false, format: null, problem: UNSUPPORTED };
    const result = await readXlsxRows(file.bytes);
    if (!result.ok) {
      return {
        ok: false,
        format: "xlsx",
        problem:
          result.reason === "too_large"
            ? {
                code: "file_too_large",
                message: "This Excel file is too large once opened. Split it into smaller files.",
              }
            : {
                code: "file_unreadable",
                message:
                  "We couldn't read this Excel file. Save it again as .xlsx, or save it as CSV.",
              },
      };
    }
    return { ok: true, format: "xlsx", rows: result.rows };
  }

  if (startsWith(file.bytes, OLE_MAGIC) || name.endsWith(".xls") || name.endsWith(".xlsx")) {
    return { ok: false, format: null, problem: UNSUPPORTED };
  }
  if (!name.endsWith(".csv") && !name.endsWith(".txt")) {
    return { ok: false, format: null, problem: UNSUPPORTED };
  }

  const parsed = parseCsv(decodeCsvBytes(file.bytes));
  if (!parsed.ok) {
    return {
      ok: false,
      format: "csv",
      problem: {
        code: "csv_unclosed_quote",
        message: `Row ${parsed.rowNumber} opens a quote that is never closed. Check that row in the file.`,
      },
    };
  }
  return { ok: true, format: "csv", rows: parsed.rows };
}
