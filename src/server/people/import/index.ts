import "server-only";

import { readImportFile, type ImportFile } from "./read-file";
import type { ImportContextInput, ImportResult } from "./types";
import { validateImportTable } from "./validate";

/**
 * People import validator (slice 1.4). A pure library: it reads the uploaded bytes and the
 * organisation's existing records passed in as plain data, and returns per row either a
 * normalised worker, pay rate and mapping, or the problems holding the row back, each in plain
 * English with a suggested fix where there is one. It never touches the database or storage.
 *
 * The normalised rows hold NIN, bank account numbers and RSA PINs in clear: encrypt them before
 * storing (slice 1.2) and never log a result.
 */
export async function validatePeopleImport(
  file: ImportFile,
  context: ImportContextInput,
): Promise<ImportResult> {
  const read = await readImportFile(file);
  if (!read.ok) return { ok: false, format: read.format, problems: [read.problem] };
  return validateImportTable(read.rows, context, read.format);
}

export { readImportFile, type ImportFile } from "./read-file";
export { validateImportRecords, validateImportTable, type ImportRecord } from "./validate";
export { IMPORT_LIMITS } from "./limits";
export { TEMPLATE_COLUMNS, REQUIRED_COLUMNS, COLUMN_LABELS, type ColumnKey } from "./columns";
export * from "./types";
