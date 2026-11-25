import { flagLabels, STATUS_TILE_LABELS, type BoardRow } from "@/lib/attendance-board";
import { STATUS_LABELS as LEAVE_STATUS_LABELS, type LeaveStatus } from "@/lib/leave/requests";
import { koboToMajorString, type Kobo } from "@/lib/money";
import {
  REMITTANCE_KIND_LABELS,
  REMITTANCE_STATUS,
  authorityLabel,
  type RemittanceKind,
  type RemittanceStatus,
} from "@/lib/payroll/statutory";
import { RUN_STATUS, type RunStatusName } from "@/lib/payroll/run-format";
import { timeIn } from "@/lib/roster";
import { LINE_STATUS_TEXT, exceptionLabels, type LineStatus } from "@/lib/timesheets/approval";
import { formatCsv } from "@/server/people/import/csv";

/**
 * "Export selected to CSV" on the lists (slice U.2): the fixed columns of each list's file. Pure,
 * so tests/unit/exports checks them. Every cell goes through the shared `csvCell` (via
 * `formatCsv`), so a value starting with `=`, `+`, `-`, `@`, tab or carriage return, even after
 * leading spaces, opens as text.
 *
 * Never in any file: NIN, BVN, bank or account numbers, RSA PIN, phone numbers, locations,
 * selfies, reasons and notes, or anything decrypted. The rows these take never carry them.
 * Pay amounts appear only in the payroll files (runs, payslips, remittances), whose readers are
 * owner, hr and finance; `pay: false` leaves the amount columns out altogether.
 */

/** Kobo as naira with two decimals and no grouping or ₦ ("642312.50"), for spreadsheets. */
function naira(kobo: Kobo): string {
  return koboToMajorString(kobo);
}

function file(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return formatCsv([[...header], ...rows]);
}

/** `clients-2026-11-25.csv`. */
export function exportFileName(list: string, today: string): string {
  return `${list}-${today}.csv`;
}

// ---------------------------------------------------------------------------
// Clients and sites
// ---------------------------------------------------------------------------

export interface ClientExportRow {
  name: string;
  status: "active" | "archived";
  needsDetails: boolean;
  siteCount: number;
  sitesWithoutGeofence: number;
  activeContractCount: number;
}

export const CLIENT_EXPORT_COLUMNS = [
  "Client",
  "Status",
  "Billing details",
  "Sites",
  "Sites without a geofence",
  "Active contracts",
] as const;

export function clientsCsv(rows: readonly ClientExportRow[]): string {
  return file(
    CLIENT_EXPORT_COLUMNS,
    rows.map((r) => [
      r.name,
      r.status === "archived" ? "Archived" : "Active",
      r.needsDetails ? "Needs details" : "Complete",
      String(r.siteCount),
      String(r.sitesWithoutGeofence),
      String(r.activeContractCount),
    ]),
  );
}

export interface SiteExportRow {
  name: string;
  clientName: string;
  address: string | null;
  state: string | null;
  geofence: "circle" | "outline" | null;
  radiusM: number;
  checkpointCount: number;
  status: string;
  needsDetails: boolean;
}

export const SITE_EXPORT_COLUMNS = [
  "Site",
  "Client",
  "Address",
  "State",
  "Geofence",
  "Checkpoints",
  "Status",
] as const;

export function sitesCsv(rows: readonly SiteExportRow[]): string {
  return file(
    SITE_EXPORT_COLUMNS,
    rows.map((r) => [
      r.name,
      r.clientName,
      (r.address ?? "").replace(/\s*\r?\n\s*/g, ", "),
      r.state ?? "",
      r.geofence === "outline"
        ? "Drawn outline"
        : r.geofence === "circle"
          ? `${r.radiusM} m circle`
          : "None",
      String(r.checkpointCount),
      r.status === "archived" ? "Archived" : r.needsDetails ? "Needs details" : "Active",
    ]),
  );
}

// ---------------------------------------------------------------------------
// Attendance and timesheets (minutes only: no pay)
// ---------------------------------------------------------------------------

export const ATTENDANCE_EXPORT_COLUMNS = [
  "Worker",
  "Staff ID",
  "Site",
  "Post",
  "Shift date",
  "Shift start",
  "Shift end",
  "Status",
  "First clock-in",
  "Last punch",
  "Minutes late",
  "Flags",
] as const;

/** The board's rows; the phone on the row is never written. Times in the company's zone. */
export function attendanceCsv(rows: readonly BoardRow[], timeZone: string): string {
  return file(
    ATTENDANCE_EXPORT_COLUMNS,
    rows.map((r) => [
      r.workerName,
      r.staffId ?? "",
      r.siteName,
      r.postName,
      r.shiftDate,
      timeIn(r.startsAt, timeZone),
      timeIn(r.endsAt, timeZone),
      STATUS_TILE_LABELS[r.status],
      r.firstInAt ? timeIn(r.firstInAt, timeZone) : "",
      r.lastPunchAt
        ? `${r.lastPunchKind === "out" ? "Out" : "In"} ${timeIn(r.lastPunchAt, timeZone)}`
        : "",
      r.lateMinutes === null ? "" : String(r.lateMinutes),
      flagLabels(r).join("; "),
    ]),
  );
}

export interface TimesheetExportRow {
  workerName: string;
  staffId: string | null;
  workDate: string;
  siteName: string | null;
  postName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  workedMinutes: number;
  otMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  status: LineStatus;
  exceptions: readonly string[];
}

export const TIMESHEET_EXPORT_COLUMNS = [
  "Worker",
  "Staff ID",
  "Date",
  "Site",
  "Post",
  "Shift start",
  "Shift end",
  "Worked minutes",
  "Overtime minutes",
  "Minutes late",
  "Minutes left early",
  "Status",
  "Exceptions",
] as const;

export function timesheetsCsv(rows: readonly TimesheetExportRow[], timeZone: string): string {
  return file(
    TIMESHEET_EXPORT_COLUMNS,
    rows.map((r) => [
      r.workerName,
      r.staffId ?? "",
      r.workDate,
      r.siteName ?? "",
      r.postName ?? "",
      r.startsAt ? timeIn(r.startsAt, timeZone) : "",
      r.endsAt ? timeIn(r.endsAt, timeZone) : "",
      String(r.workedMinutes),
      String(r.otMinutes),
      String(r.lateMinutes),
      String(r.earlyMinutes),
      LINE_STATUS_TEXT[r.status],
      exceptionLabels(r.exceptions).join("; "),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Leave (dates, type and status only: never the reason or notes, never pay)
// ---------------------------------------------------------------------------

export interface LeaveExportRow {
  workerName: string;
  staffId: string;
  departmentName: string | null;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number;
  status: LeaveStatus;
  lineManagerStep: "approved" | "declined" | null;
  hrStep: "approved" | "declined" | null;
}

export const LEAVE_EXPORT_COLUMNS = [
  "Employee",
  "Staff ID",
  "Department",
  "Leave type",
  "From",
  "To",
  "Days",
  "Status",
  "Line manager",
  "HR",
] as const;

const stepText = (s: "approved" | "declined" | null) =>
  s === "approved" ? "Approved" : s === "declined" ? "Declined" : "";

export function leaveCsv(rows: readonly LeaveExportRow[]): string {
  return file(
    LEAVE_EXPORT_COLUMNS,
    rows.map((r) => [
      r.workerName,
      r.staffId,
      r.departmentName ?? "",
      r.leaveTypeName,
      r.startDate,
      r.endDate,
      String(r.days),
      LEAVE_STATUS_LABELS[r.status],
      stepText(r.lineManagerStep),
      stepText(r.hrStep),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Payroll (owner, hr and finance only; amounts in naira with two decimals)
// ---------------------------------------------------------------------------

export interface RunExportRow {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  kind: string;
  status: RunStatusName;
  discarded: boolean;
  workerCount: number;
  grossKobo: Kobo;
  payeKobo: Kobo;
  pensionEmployeeKobo: Kobo;
  nhfKobo: Kobo;
  otherDeductionsKobo: Kobo;
  netKobo: Kobo;
  employerCostKobo: Kobo;
}

const RUN_BASE_COLUMNS = [
  "Period from",
  "Period to",
  "Pay date",
  "Kind",
  "Status",
  "Workers",
] as const;
const RUN_PAY_COLUMNS = [
  "Gross",
  "PAYE",
  "Pension (employee)",
  "NHF",
  "Other deductions",
  "Net pay",
  "Employer cost",
] as const;

export function runExportColumns(pay: boolean): string[] {
  return pay ? [...RUN_BASE_COLUMNS, ...RUN_PAY_COLUMNS] : [...RUN_BASE_COLUMNS];
}

const RUN_KIND: Record<string, string> = {
  regular: "Regular",
  off_cycle: "Off-cycle",
  reversal: "Reversal",
};

/** A reversal's amounts are written as stored (the original's), with Kind "Reversal". */
export function runsCsv(rows: readonly RunExportRow[], options: { pay: boolean }): string {
  return file(
    runExportColumns(options.pay),
    rows.map((r) => [
      r.periodStart,
      r.periodEnd,
      r.payDate,
      RUN_KIND[r.kind] ?? r.kind,
      r.discarded ? "Discarded" : RUN_STATUS[r.status].label,
      String(r.workerCount),
      ...(options.pay
        ? [
            naira(r.grossKobo),
            naira(r.payeKobo),
            naira(r.pensionEmployeeKobo),
            naira(r.nhfKobo),
            naira(r.otherDeductionsKobo),
            naira(r.netKobo),
            naira(r.employerCostKobo),
          ]
        : []),
    ]),
  );
}

export interface PayslipExportRow {
  workerName: string;
  staffId: string;
  jobTitle: string | null;
  grossKobo: Kobo;
  payeKobo: Kobo;
  pensionEmployeeKobo: Kobo;
  nhfKobo: Kobo;
  otherDeductionsKobo: Kobo;
  netKobo: Kobo;
}

const PAYSLIP_BASE_COLUMNS = ["Worker", "Staff ID", "Job title"] as const;
const PAYSLIP_PAY_COLUMNS = [
  "Gross",
  "PAYE",
  "Pension (employee)",
  "NHF",
  "Other deductions",
  "Net pay",
] as const;

export function payslipExportColumns(pay: boolean): string[] {
  return pay ? [...PAYSLIP_BASE_COLUMNS, ...PAYSLIP_PAY_COLUMNS] : [...PAYSLIP_BASE_COLUMNS];
}

export function payslipsCsv(rows: readonly PayslipExportRow[], options: { pay: boolean }): string {
  return file(
    payslipExportColumns(options.pay),
    rows.map((r) => [
      r.workerName,
      r.staffId,
      r.jobTitle ?? "",
      ...(options.pay
        ? [
            naira(r.grossKobo),
            naira(r.payeKobo),
            naira(r.pensionEmployeeKobo),
            naira(r.nhfKobo),
            naira(r.otherDeductionsKobo),
            naira(r.netKobo),
          ]
        : []),
    ]),
  );
}

export interface RemittanceExportRow {
  runPeriodStart: string;
  runPeriodEnd: string;
  kind: RemittanceKind;
  authorityName: string | null;
  workerCount: number;
  amountKobo: Kobo;
  offsetsInKobo: Kobo;
  outstandingKobo: Kobo;
  dueDate: string | null;
  status: RemittanceStatus;
  voided: boolean;
  paidOn: string | null;
  paidAmountKobo: Kobo | null;
}

const REMITTANCE_BASE_COLUMNS = [
  "Period from",
  "Period to",
  "Remittance",
  "Authority",
  "Workers",
  "Due date",
  "Status",
  "Paid on",
] as const;
const REMITTANCE_PAY_COLUMNS = ["Amount", "Offsets", "Still to pay", "Amount paid"] as const;

export function remittanceExportColumns(pay: boolean): string[] {
  return pay
    ? [...REMITTANCE_BASE_COLUMNS, ...REMITTANCE_PAY_COLUMNS]
    : [...REMITTANCE_BASE_COLUMNS];
}

/** The payment's date and amount only: never its bank reference or receipt. */
export function remittancesCsv(
  rows: readonly RemittanceExportRow[],
  options: { pay: boolean },
): string {
  return file(
    remittanceExportColumns(options.pay),
    rows.map((r) => [
      r.runPeriodStart,
      r.runPeriodEnd,
      REMITTANCE_KIND_LABELS[r.kind],
      authorityLabel(r.kind, r.authorityName),
      String(r.workerCount),
      r.dueDate ?? "",
      r.voided ? "Voided" : REMITTANCE_STATUS[r.status].label,
      r.paidOn ?? "",
      ...(options.pay
        ? [
            naira(r.amountKobo),
            naira(r.offsetsInKobo),
            naira(r.outstandingKobo),
            r.paidAmountKobo === null ? "" : naira(r.paidAmountKobo),
          ]
        : []),
    ]),
  );
}
