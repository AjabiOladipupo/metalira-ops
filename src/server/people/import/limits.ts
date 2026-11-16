export const IMPORT_LIMITS = {
  /** Upload size cap for CSV and .xlsx. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Employee rows checked in one file (header not counted). */
  maxRows: 5000,
  /** Longest value accepted in one cell. */
  maxCellLength: 200,
  /**
   * Largest amount in one pay or rent cell: ₦1,000,000,000 in kobo. Far below the Postgres
   * `bigint` ceiling (about 9.2e18 kobo), and catches a typo with extra zeros.
   */
  maxAmountKobo: 100_000_000_000n,
} as const;
