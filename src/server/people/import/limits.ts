export const IMPORT_LIMITS = {
  /** Upload size cap for CSV and .xlsx. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Employee rows checked in one file (header not counted). */
  maxRows: 5000,
  /** Longest value accepted in one cell. */
  maxCellLength: 200,
} as const;
