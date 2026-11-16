import { z } from "zod";

import type { Currency, Kobo } from "@/lib/money";

import type { ColumnKey } from "./columns";

/**
 * What the validator needs to know about the organisation, passed in as plain data. The library
 * never reads the database: the caller (slice 1.8) loads these with the user's own client.
 */
export const importContextSchema = z.object({
  existingWorkers: z
    .array(
      z.object({
        id: z.string().min(1),
        staffId: z.string().min(1),
        firstName: z.string(),
        lastName: z.string(),
        phone: z.string().nullable(),
        /** Staff ID of this worker's line manager, when that manager is a worker. */
        lineManagerStaffId: z.string().nullable(),
      }),
    )
    .default([]),
  /** Manager-app users who are not workers (memberships without `worker_id`). */
  managers: z
    .array(
      z.object({
        membershipId: z.string().min(1),
        email: z.string().min(1),
        name: z.string(),
      }),
    )
    .default([]),
  departments: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).default([]),
  clients: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).default([]),
  projects: z
    .array(
      z.object({ id: z.string().min(1), clientId: z.string().min(1), name: z.string().min(1) }),
    )
    .default([]),
  sites: z
    .array(
      z.object({ id: z.string().min(1), clientId: z.string().min(1), name: z.string().min(1) }),
    )
    .default([]),
  /** Prefix for generated staff IDs when neither the account nor the file shows a pattern. */
  defaultStaffIdPrefix: z.string().min(1).max(12).default("EMP-"),
});

export type ImportContextInput = z.input<typeof importContextSchema>;
export type ImportContext = z.output<typeof importContextSchema>;

/** A one-click fix: set these raw cells, then validate the file again. */
export interface SuggestedFix {
  label: string;
  patch: Partial<Record<ColumnKey, string>>;
}

export type ProblemCode =
  | "row_too_wide"
  | "value_too_long"
  | "not_plain_text"
  | "required_blank"
  | "phone_invalid"
  | "email_invalid"
  | "employment_type_invalid"
  | "date_invalid"
  | "pay_type_invalid"
  | "pay_type_hourly"
  | "pay_type_missing"
  | "pay_amount_conflict"
  | "pay_amount_zero"
  | "pay_basic_missing"
  | "amount_invalid"
  | "amount_too_large"
  | "bank_account_invalid"
  | "nin_invalid"
  | "rsa_pin_invalid"
  | "tin_invalid"
  | "next_of_kin_phone_invalid"
  | "yes_no_invalid"
  | "staff_id_invalid"
  | "staff_id_duplicate_in_file"
  | "staff_id_exists"
  | "line_manager_unknown"
  | "line_manager_self"
  | "line_manager_cycle"
  | "line_manager_held"
  | "client_not_found"
  | "project_not_found"
  | "site_not_found"
  | "client_missing";

/** A reason the row is held back. Copy is plain English and never shows NIN, bank or PIN. */
export interface ImportProblem {
  code: ProblemCode;
  column: ColumnKey | null;
  message: string;
  fix: SuggestedFix | null;
}

export type WarningCode = "duplicate_phone" | "needs_pay_details" | "staff_id_generated";

/** The row imports, with something worth knowing. `attention` warnings are listed for review. */
export interface ImportWarning {
  code: WarningCode;
  column: ColumnKey | null;
  message: string;
  attention: boolean;
  /** A fix that is already applied to the normalised row (for example supervisor clock-in). */
  appliedFix: string | null;
}

export type EmploymentType = "permanent" | "contract" | "casual" | "daily";
export type ImportPayType = "monthly" | "daily";

/** A name that matched an existing record, or a new name to create at commit. */
export type ResolvedName =
  { kind: "existing"; id: string; name: string } | { kind: "new"; name: string };

export type LineManagerRef =
  | { kind: "row"; rowNumber: number; staffId: string; name: string }
  | { kind: "worker"; workerId: string; staffId: string; name: string }
  | { kind: "membership"; membershipId: string; email: string; name: string };

export interface NormalisedWorker {
  staffId: string;
  staffIdGenerated: boolean;
  firstName: string;
  lastName: string;
  /** Nigerian mobile number in local 11-digit form, for example 08031234567. */
  phone: string;
  email: string | null;
  jobTitle: string;
  employmentType: EmploymentType;
  /** ISO date, YYYY-MM-DD. */
  startDate: string;
  shiftPattern: string | null;
  bankName: string | null;
  accountName: string | null;
  /** Personal data: encrypt before storing (slice 1.2). */
  bankAccountNumber: string | null;
  /** Personal data: encrypt before storing (slice 1.2). */
  nin: string | null;
  tin: string | null;
  taxState: string | null;
  pfaName: string | null;
  /** Personal data: encrypt before storing (slice 1.2). */
  rsaPin: string | null;
  nhfOptIn: boolean;
  annualRentDeclaredKobo: Kobo | null;
  currency: Currency;
  nextOfKinName: string | null;
  nextOfKinPhone: string | null;
  needsPayDetails: boolean;
  supervisorClockIn: boolean;
}

export interface NormalisedPayRate {
  payType: ImportPayType;
  basicKobo: Kobo;
  housingKobo: Kobo;
  transportKobo: Kobo;
  otherAllowancesKobo: Kobo;
  dailyRateKobo: Kobo;
  currency: Currency;
  /** The worker's start date. */
  effectiveFrom: string;
}

export interface NormalisedRow {
  worker: NormalisedWorker;
  department: ResolvedName;
  lineManager: LineManagerRef | null;
  payRate: NormalisedPayRate | null;
  mapping: {
    client: ResolvedName | null;
    project: ResolvedName | null;
    site: ResolvedName | null;
  };
}

export type RowStatus = "ready" | "warning" | "held";

export interface RowResult {
  /** Row number as seen in a spreadsheet: the header is row 1, the first employee row 2. */
  rowNumber: number;
  raw: Record<ColumnKey, string>;
  /** `ready`: imports. `warning`: imports and is listed for attention. `held`: held back. */
  status: RowStatus;
  problems: ImportProblem[];
  warnings: ImportWarning[];
  /** Null when the row is held back. */
  normalised: NormalisedRow | null;
  /** Non-blank cells beyond the header (kept so a stored row can be checked again as read). */
  extraValues: number;
  /** .xlsx only: columns whose cell in this row was a number cell (same reason). */
  numericColumns: ColumnKey[];
}

export interface FoundCounts {
  departments: number;
  lineManagers: number;
  clients: number;
  projects: number;
  sites: number;
}

export interface ImportSummary {
  rows: number;
  /** Rows with nothing listed for attention. */
  ready: number;
  /** Rows listed for attention: held back plus importable with an attention warning. */
  needFixing: number;
  held: number;
  /** Rows that import as they are: ready plus attention warnings with the fix applied. */
  importable: number;
  needsPayDetails: number;
  generatedStaffIds: number;
  supervisorClockIn: number;
  found: FoundCounts;
  /** "4 departments · 14 line managers · 3 clients · 4 projects · 5 sites" */
  foundLine: string;
  /** Names that do not exist yet and become name-only records at commit. */
  newNames: {
    departments: string[];
    clients: string[];
    projects: { client: string; name: string }[];
    sites: { client: string; name: string }[];
  };
}

export type FileProblemCode =
  | "file_too_large"
  | "file_type_unsupported"
  | "file_unreadable"
  | "file_empty"
  | "too_many_rows"
  | "columns_missing"
  | "column_duplicated"
  | "csv_unclosed_quote";

export interface FileProblem {
  code: FileProblemCode;
  message: string;
}

export type ImportFormat = "csv" | "xlsx";

export type ImportResult =
  | {
      ok: true;
      format: ImportFormat | null;
      columns: { present: ColumnKey[]; missingOptional: ColumnKey[]; ignored: string[] };
      /** Notes about the file as a whole, such as ignored columns. */
      fileNotes: string[];
      rows: RowResult[];
      /** Rows needing attention, in row order (held and attention warnings). */
      attention: RowResult[];
      summary: ImportSummary;
    }
  | { ok: false; format: ImportFormat | null; problems: FileProblem[] };
