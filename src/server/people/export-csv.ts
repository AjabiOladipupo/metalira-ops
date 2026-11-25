import { EMPLOYMENT_TYPE_LABELS, type EmploymentType } from "@/lib/people";
import { PEOPLE_STATUS_LABELS, type PeopleStatus } from "@/lib/people-filters";

import { formatCsv } from "./import/csv";

/**
 * "Export selected to CSV" on the People list (slice U.1). The columns are fixed here and hold
 * work details only: never NIN, BVN, bank or account details, RSA PIN, tax, next of kin or pay.
 * The rows come from reads that never load those columns. Every cell goes through `formatCsv`,
 * so a value starting with `=`, `+`, `-`, `@`, tab or carriage return opens as text in Excel.
 */

export interface PeopleExportRow {
  name: string;
  staffId: string;
  jobTitle: string | null;
  department: string | null;
  sites: readonly string[];
  lineManager: string | null;
  employmentType: EmploymentType;
  status: PeopleStatus;
  startDate: string;
  endDate: string | null;
}

export const PEOPLE_EXPORT_COLUMNS = [
  "Name",
  "Staff ID",
  "Job title",
  "Department",
  "Site",
  "Line manager",
  "Employment type",
  "Status",
  "Start date",
  "End date",
] as const;

/** The CSV text: a byte order mark, the header row, then one row per person, CRLF line ends. */
export function peopleExportCsv(rows: readonly PeopleExportRow[]): string {
  return formatCsv([
    [...PEOPLE_EXPORT_COLUMNS],
    ...rows.map((r) => [
      r.name,
      r.staffId,
      r.jobTitle ?? "",
      r.department ?? "",
      r.sites.join("; "),
      r.lineManager ?? "",
      EMPLOYMENT_TYPE_LABELS[r.employmentType],
      PEOPLE_STATUS_LABELS[r.status],
      r.startDate,
      r.endDate ?? "",
    ]),
  ]);
}

/** `people-2026-11-24.csv`. */
export function peopleExportFileName(today: string): string {
  return `people-${today}.csv`;
}
