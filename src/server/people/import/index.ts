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
 * Each row's `raw` cells and `normalised.worker` hold NIN, bank account number and RSA PIN in
 * clear: read those fields directly to encrypt them before storing (slice 1.2). Both objects
 * carry a non-enumerable `toJSON` and `util.inspect` hook that mask those fields, so
 * `JSON.stringify(result)`, `console.log(result)` and Sentry's serialiser never show them; a
 * spread copy (`{ ...worker }`) drops that guard, so never log one.
 */
export async function validatePeopleImport(
  file: ImportFile,
  context: ImportContextInput,
): Promise<ImportResult> {
  const read = await readImportFile(file);
  if (!read.ok) return { ok: false, format: read.format, problems: [read.problem] };
  return validateImportTable(read.rows, context, read.format, { numeric: read.numeric });
}

export { readImportFile, type ImportFile } from "./read-file";
export { validateImportRecords, validateImportTable, type ImportRecord } from "./validate";
export { IMPORT_LIMITS } from "./limits";
export { formatCsv } from "./csv";
export { TEMPLATE_COLUMNS, REQUIRED_COLUMNS, COLUMN_LABELS, type ColumnKey } from "./columns";
export * from "./types";
