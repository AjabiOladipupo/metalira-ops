/**
 * The stage contract between the earnings stage (slice 5.1, `earnings.ts`) and the gross-to-net
 * stage (slice 5.0), as fixed in docs/PHASE_5.md "Calculation design". One definition each,
 * kept in `contract.ts` and `trace.ts`; re-exported here for the earnings stage's imports.
 *
 * A timesheet line can back several earning lines of one payslip (overtime and the
 * public-holiday premium on one day), so slice 5.2's "a source is paid once" holds across
 * standing payslips, not within one.
 */

export type { EarningCode, EarningLine, PaySourceRef } from "./contract";
export type { TraceStep } from "./trace";
