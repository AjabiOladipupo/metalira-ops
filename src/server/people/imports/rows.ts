import "server-only";

import { randomUUID } from "node:crypto";

import { decryptPii, encryptPiiForDb, sealPii, type PiiContext } from "@/server/crypto/pii";
import type { Json } from "@/types/db";

import { TEMPLATE_COLUMNS, type ColumnKey } from "../import/columns";
import type { ImportRecord } from "../import/validate";
import type {
  ImportProblem,
  ImportWarning,
  NormalisedRow,
  ResolvedName,
  RowResult,
} from "../import/types";
import { toPayRateRecord, type PayRateRecord } from "../schemas";

/**
 * Converting between the validator's rows (slice 1.4) and what slice 1.8 stores and commits.
 *
 * Personal data: the validator hands back NIN, bank account number and RSA PIN in clear (in
 * `raw` and `normalised.worker`). Here they are taken out of both documents and encrypted:
 * - for `import_rows`, bound to the import row (its `nin_enc`, `bank_account_enc`,
 *   `rsa_pin_enc`), so a held row can be fixed and checked again later;
 * - at commit, decrypted and encrypted again for the new worker's row (`workers.*_enc`), as
 *   src/server/crypto/pii.ts requires when a value moves.
 * Nothing in this file logs; never log a raw row or a record built from one.
 */

/** Cells that hold personal data, and the `import_rows` column each is encrypted into. */
export const PII_CELLS = {
  nin: "nin_enc",
  bank_account_number: "bank_account_enc",
  rsa_pin: "rsa_pin_enc",
} as const satisfies Partial<Record<ColumnKey, string>>;

type PiiCell = keyof typeof PII_CELLS;

const PII_CELL_KEYS = Object.keys(PII_CELLS) as PiiCell[];

function isPiiCell(key: ColumnKey): key is PiiCell {
  return key in PII_CELLS;
}

/** Template columns stored in clear in `import_rows.raw`. */
export const RAW_COLUMNS = TEMPLATE_COLUMNS.filter((key) => !isPiiCell(key));

const IMPORT_ROWS = "import_rows";

function rowContext(organisationId: string, rowId: string, column: string): PiiContext {
  return { organisationId, table: IMPORT_ROWS, column, rowId };
}

/** A fix applied to a row with one click, kept with the row. */
export interface AppliedFix {
  label: string;
  at: string;
}

/** An `import_rows` row as the server reads it back. */
export interface StoredImportRow {
  id: string;
  row_number: number;
  raw: Json;
  nin_enc: string | null;
  bank_account_enc: string | null;
  rsa_pin_enc: string | null;
  numeric_columns: string[];
  extra_values: number;
  fixes: Json;
}

/** What `save_import_check` stores for one row (bytea as `\x` hex text). */
export interface ImportRowDoc {
  id: string;
  row_number: number;
  raw: Record<string, string>;
  nin_enc: string | null;
  bank_account_enc: string | null;
  rsa_pin_enc: string | null;
  numeric_columns: ColumnKey[];
  extra_values: number;
  normalised: Json | null;
  errors: Json;
  warnings: Json;
  attention: boolean;
  fixes: Json;
  status: "ready" | "held" | "fixed";
}

const COLUMN_SET = new Set<string>(TEMPLATE_COLUMNS);

function isColumnKey(value: string): value is ColumnKey {
  return COLUMN_SET.has(value);
}

/** The applied fixes stored with a row, ignoring anything malformed. */
export function readFixes(value: Json): AppliedFix[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item) && typeof item.label === "string"
      ? [{ label: item.label, at: typeof item.at === "string" ? item.at : "" }]
      : [],
  );
}

/**
 * A stored row back as the validator's input: the clear cells plus the personal data decrypted
 * for this row. `patch` (a one-click fix) is applied on top.
 */
export function recordFromStored(
  organisationId: string,
  row: StoredImportRow,
  patch: Partial<Record<ColumnKey, string>> = {},
): ImportRecord {
  const values = {} as Record<ColumnKey, string>;
  const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? row.raw : {};
  for (const key of TEMPLATE_COLUMNS) {
    const cell = isPiiCell(key) ? null : raw[key];
    values[key] = typeof cell === "string" ? cell : "";
  }
  for (const key of PII_CELL_KEYS) {
    const enc = row[PII_CELLS[key]];
    values[key] = enc ? decryptPii(enc, rowContext(organisationId, row.id, PII_CELLS[key])) : "";
  }
  for (const [key, value] of Object.entries(patch)) {
    if (isColumnKey(key) && typeof value === "string") values[key] = value;
  }
  return {
    rowNumber: row.row_number,
    values,
    extraValues: row.extra_values,
    numericColumns: row.numeric_columns.filter(isColumnKey),
  };
}

function nameDoc(name: ResolvedName | null): Json {
  if (!name) return null;
  return name.kind === "existing"
    ? { kind: "existing", id: name.id, name: name.name }
    : { kind: "new", name: name.name };
}

/**
 * The normalised row as stored for the review screen: no personal data (only whether each
 * field is present), amounts as strings of whole kobo.
 */
export function storedNormalised(normalised: NormalisedRow | null): Json | null {
  if (!normalised) return null;
  const w = normalised.worker;
  const rate = normalised.payRate;
  const ref = normalised.lineManager;
  return {
    worker: {
      staffId: w.staffId,
      staffIdGenerated: w.staffIdGenerated,
      firstName: w.firstName,
      lastName: w.lastName,
      phone: w.phone,
      email: w.email,
      jobTitle: w.jobTitle,
      employmentType: w.employmentType,
      startDate: w.startDate,
      shiftPattern: w.shiftPattern,
      bankName: w.bankName,
      accountName: w.accountName,
      hasBankAccount: w.bankAccountNumber !== null,
      hasNin: w.nin !== null,
      hasRsaPin: w.rsaPin !== null,
      tin: w.tin,
      taxState: w.taxState,
      pfaName: w.pfaName,
      nhfOptIn: w.nhfOptIn,
      annualRentDeclaredKobo: w.annualRentDeclaredKobo?.toString() ?? null,
      currency: w.currency,
      nextOfKinName: w.nextOfKinName,
      nextOfKinPhone: w.nextOfKinPhone,
      needsPayDetails: w.needsPayDetails,
      supervisorClockIn: w.supervisorClockIn,
    },
    department: nameDoc(normalised.department),
    lineManager: ref
      ? ref.kind === "membership"
        ? { kind: ref.kind, name: ref.name, email: ref.email }
        : { kind: ref.kind, name: ref.name, staffId: ref.staffId }
      : null,
    payRate: rate
      ? {
          payType: rate.payType,
          basicKobo: rate.basicKobo.toString(),
          housingKobo: rate.housingKobo.toString(),
          transportKobo: rate.transportKobo.toString(),
          otherAllowancesKobo: rate.otherAllowancesKobo.toString(),
          dailyRateKobo: rate.dailyRateKobo.toString(),
          currency: rate.currency,
          effectiveFrom: rate.effectiveFrom,
        }
      : null,
    mapping: {
      client: nameDoc(normalised.mapping.client),
      project: nameDoc(normalised.mapping.project),
      site: nameDoc(normalised.mapping.site),
    },
  };
}

function problemDoc(problem: ImportProblem): Json {
  return {
    code: problem.code,
    column: problem.column,
    message: problem.message,
    fix: problem.fix ? { label: problem.fix.label } : null,
  };
}

function warningDoc(warning: ImportWarning): Json {
  return {
    code: warning.code,
    column: warning.column,
    message: warning.message,
    attention: warning.attention,
    appliedFix: warning.appliedFix,
  };
}

/**
 * One checked row as `save_import_check` stores it. Personal data is encrypted for `rowId`;
 * a fix's patch values are not stored (only its label: the server takes the patch from a fresh
 * check when the fix is applied).
 */
export function toRowDoc(
  organisationId: string,
  rowId: string,
  result: RowResult,
  fixes: readonly AppliedFix[],
): ImportRowDoc {
  const raw: Record<string, string> = {};
  for (const key of RAW_COLUMNS) raw[key] = result.raw[key];
  const enc = (cell: PiiCell): string | null => {
    const value = result.raw[cell];
    return value === ""
      ? null
      : encryptPiiForDb(value, rowContext(organisationId, rowId, PII_CELLS[cell]));
  };
  const held = result.status === "held";
  return {
    id: rowId,
    row_number: result.rowNumber,
    raw,
    nin_enc: enc("nin"),
    bank_account_enc: enc("bank_account_number"),
    rsa_pin_enc: enc("rsa_pin"),
    numeric_columns: result.numericColumns,
    extra_values: result.extraValues,
    normalised: storedNormalised(result.normalised),
    errors: result.problems.map(problemDoc),
    warnings: result.warnings.map(warningDoc),
    attention: result.warnings.some((w) => w.attention),
    fixes: fixes.map((fix) => ({ label: fix.label, at: fix.at })),
    status: held ? "held" : fixes.length > 0 ? "fixed" : "ready",
  };
}

// ---------------------------------------------------------------------------------------------
// Commit payload
// ---------------------------------------------------------------------------------------------

type NameRef = { id: string } | { name: string };

export interface CommitItem {
  row_id: string;
  worker: Record<string, Json>;
  pay_rate: PayRateRecord | null;
  department: NameRef;
  line_manager: { worker_id: string } | { membership_id: string } | null;
  client: NameRef | null;
  site: NameRef | null;
  project: NameRef | null;
}

function nameRef(name: ResolvedName | null): NameRef | null {
  if (!name) return null;
  return name.kind === "existing" ? { id: name.id } : { name: name.name };
}

const WORKERS = "workers";

/**
 * The `commit_import_batch` payload for the rows that import, managers before the people who
 * report to them (a worker's line manager must exist when the worker is inserted). Each worker
 * gets its id here so personal data can be encrypted for it, and so a reportee can point at a
 * manager created in the same commit.
 */
export function buildCommitPayload(
  organisationId: string,
  rows: readonly { rowId: string; result: RowResult }[],
  newId: () => string = randomUUID,
): CommitItem[] {
  const importable = rows.filter(
    (row): row is { rowId: string; result: RowResult & { normalised: NormalisedRow } } =>
      row.result.status !== "held" && row.result.normalised !== null,
  );
  const byRowNumber = new Map(importable.map((row) => [row.result.rowNumber, row]));
  const workerIds = new Map(importable.map((row) => [row.result.rowNumber, newId()]));

  // Depth-first: a row comes after the row of its line manager. The validator has already
  // refused loops and held reportees of held rows, so this always finishes.
  const ordered: typeof importable = [];
  const placed = new Set<number>();
  const visiting = new Set<number>();
  const place = (row: (typeof importable)[number]) => {
    const rowNumber = row.result.rowNumber;
    if (placed.has(rowNumber)) return;
    if (visiting.has(rowNumber)) throw new Error("Line managers form a loop in this import.");
    visiting.add(rowNumber);
    const ref = row.result.normalised.lineManager;
    if (ref?.kind === "row") {
      const manager = byRowNumber.get(ref.rowNumber);
      if (!manager) throw new Error(`Row ${rowNumber}'s line manager is not being imported.`);
      place(manager);
    }
    visiting.delete(rowNumber);
    placed.add(rowNumber);
    ordered.push(row);
  };
  for (const row of importable) place(row);

  return ordered.map(({ rowId, result }) => {
    const n = result.normalised;
    const w = n.worker;
    const id = workerIds.get(result.rowNumber) ?? newId();
    const ctx = (column: string): PiiContext => ({
      organisationId,
      table: WORKERS,
      column,
      rowId: id,
    });
    const bank = w.bankAccountNumber ? sealPii(w.bankAccountNumber, ctx("bank_account_enc")) : null;
    const rsa = w.rsaPin ? sealPii(w.rsaPin, ctx("rsa_pin_enc")) : null;
    const ref = n.lineManager;
    const rate = n.payRate;
    return {
      row_id: rowId,
      worker: {
        id,
        staff_id: w.staffId,
        first_name: w.firstName,
        last_name: w.lastName,
        phone: w.phone,
        email: w.email,
        job_title: w.jobTitle,
        employment_type: w.employmentType,
        start_date: w.startDate,
        bank_name: w.bankName,
        account_name: w.accountName,
        bank_account_enc: bank?.enc ?? null,
        bank_account_last4: bank?.last4 ?? null,
        nin_enc: w.nin ? encryptPiiForDb(w.nin, ctx("nin_enc")) : null,
        tin: w.tin,
        tax_state: w.taxState,
        pfa_name: w.pfaName,
        rsa_pin_enc: rsa?.enc ?? null,
        rsa_pin_last4: rsa?.last4 ?? null,
        nhf_opt_in: w.nhfOptIn,
        annual_rent_declared_kobo: w.annualRentDeclaredKobo?.toString() ?? null,
        next_of_kin_name: w.nextOfKinName,
        next_of_kin_phone: w.nextOfKinPhone,
        supervisor_clock_in: w.supervisorClockIn,
      },
      pay_rate: rate
        ? toPayRateRecord(
            rate.payType,
            {
              basic: rate.payType === "monthly" ? rate.basicKobo : null,
              housing: rate.payType === "monthly" ? rate.housingKobo : null,
              transport: rate.payType === "monthly" ? rate.transportKobo : null,
              otherAllowances: rate.payType === "monthly" ? rate.otherAllowancesKobo : null,
              dailyRate: rate.payType === "daily" ? rate.dailyRateKobo : null,
              hourlyRate: null,
            },
            rate.effectiveFrom,
          )
        : null,
      department: nameRef(n.department) ?? { name: "" },
      line_manager: !ref
        ? null
        : ref.kind === "membership"
          ? { membership_id: ref.membershipId }
          : ref.kind === "worker"
            ? { worker_id: ref.workerId }
            : { worker_id: workerIds.get(ref.rowNumber) ?? "" },
      client: nameRef(n.mapping.client),
      site: n.mapping.client ? nameRef(n.mapping.site) : null,
      project: n.mapping.client ? nameRef(n.mapping.project) : null,
    };
  });
}

/** Rows to commit and the ones held back, counted the way the review screen shows them. */
export function importableCount(results: readonly RowResult[]): number {
  return results.filter((row) => row.status !== "held").length;
}

export { isColumnKey };
