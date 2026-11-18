import "server-only";

import { randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { IMPORTS_BUCKET } from "@/lib/people-import";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";
import type { Database, Json } from "@/types/db";

import { validatePeopleImport } from "../import";
import type { ColumnKey } from "../import/columns";
import { IMPORT_LIMITS } from "../import/limits";
import type { FileProblem, ImportFormat, ImportResult, RowResult } from "../import/types";
import { validateImportRecords } from "../import/validate";
import { PEOPLE_EDITORS } from "../workers";
import { loadImportContext } from "./context";
import {
  buildCommitPayload,
  importableCount,
  isColumnKey,
  readFixes,
  recordFromStored,
  toRowDoc,
  type AppliedFix,
  type ImportRowDoc,
  type StoredImportRow,
} from "./rows";

/**
 * The import flow (slice 1.8): start an upload, check it, apply one-click fixes, commit,
 * cancel. Each step is a `mutate()` spec (owner, admin and hr; docs/PHASE_1.md 1.8) that
 * writes with the signed-in user's own client, so RLS, grants and the tables' triggers apply.
 *
 * Every check after the first works from the stored rows, not the file: the clear cells in
 * `import_rows.raw` plus the personal data decrypted for that row. A fix patches one row and
 * the whole batch is checked again (duplicates, line managers and names are cross-row checks).
 * Commit checks the batch again against the account as it is at that moment and sends only
 * the rows that import; the stored review is never trusted for what gets created.
 */

type Client = SupabaseClient<Database>;

export const IMPORT_CONTENT_TYPES: Record<ImportFormat, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Rows sent to `save_import_check` per call (a 5,000-row file goes in ten calls). */
const SAVE_CHUNK = 500;
const PAGE = 1000;

const NOT_FOUND = "That import wasn't found. Upload the file again.";

const batchIdSchema = z.uuid("That import wasn't found.");

interface BatchRow {
  id: string;
  status: Database["public"]["Enums"]["import_batch_status"];
  file_name: string;
  file_format: string;
  file_path: string;
  file_removed_at: string | null;
  columns: string[];
  file_notes: Json;
  file_problems: Json;
  created_by: string | null;
}

async function loadBatch(supabase: Client, organisationId: string, batchId: string) {
  const { data, error } = await supabase
    .from("import_batches")
    .select(
      "id, status, file_name, file_format, file_path, file_removed_at, columns, file_notes, file_problems, created_by",
    )
    .eq("id", batchId)
    .eq("organisation_id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the import: ${error.message}`);
  if (!data) throw new MutationError("invalid", NOT_FOUND);
  return data satisfies BatchRow;
}

function formatOf(batch: BatchRow): ImportFormat {
  return batch.file_format === "xlsx" ? "xlsx" : "csv";
}

function stringList(value: Json): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The rows of a batch not imported yet, a page at a time. */
async function loadOpenRows(
  supabase: Client,
  organisationId: string,
  batchId: string,
): Promise<StoredImportRow[]> {
  const rows: StoredImportRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("import_rows")
      .select(
        "id, row_number, raw, nin_enc, bank_account_enc, rsa_pin_enc, numeric_columns, extra_values, fixes",
      )
      .eq("batch_id", batchId)
      .eq("organisation_id", organisationId)
      .neq("status", "imported")
      .order("row_number")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read the import rows: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

type CheckedResult = Extract<ImportResult, { ok: true }>;

/**
 * Stores checked rows and refreshes the batch counts, in chunks. On a first check
 * `rowsExpected` is the file's row count: the database moves the batch to `validated` only on
 * the last chunk and only once that many rows are stored, so a check that stops part way
 * leaves the batch `uploaded` rather than reviewable with some of its rows missing.
 */
async function saveCheck(
  supabase: Client,
  organisationId: string,
  batchId: string,
  check: {
    columns: readonly string[];
    fileNotes: readonly string[];
    summary: Json | null;
    rowsExpected?: number;
  },
  docs: readonly ImportRowDoc[],
): Promise<void> {
  const pCheck: Record<string, Json> = {
    columns: [...check.columns],
    file_notes: [...check.fileNotes],
  };
  if (check.summary !== null) pCheck.summary = check.summary;
  if (check.rowsExpected !== undefined) pCheck.rows_expected = check.rowsExpected;
  const chunks: (readonly ImportRowDoc[])[] = [];
  for (let i = 0; i < docs.length; i += SAVE_CHUNK) chunks.push(docs.slice(i, i + SAVE_CHUNK));
  if (chunks.length === 0) chunks.push([]);
  for (const [index, chunk] of chunks.entries()) {
    const { error } = await supabase.rpc("save_import_check", {
      p_organisation_id: organisationId,
      p_batch_id: batchId,
      p_check: pCheck,
      p_rows: chunk as unknown as Json,
      p_final: index === chunks.length - 1,
    });
    if (error) fromDbError(error);
  }
}

/** Ids of rows already stored for a batch by row number (a first check that stopped part way). */
async function storedRowIds(
  supabase: Client,
  organisationId: string,
  batchId: string,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("import_rows")
      .select("id, row_number")
      .eq("batch_id", batchId)
      .eq("organisation_id", organisationId)
      .order("row_number")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read the import rows: ${error.message}`);
    for (const row of data ?? []) ids.set(row.row_number, row.id);
    if (!data || data.length < PAGE) return ids;
  }
}

function summaryDoc(result: CheckedResult): Json {
  return JSON.parse(JSON.stringify(result.summary)) as Json;
}

/** Database refusals the user can act on; anything else is a failure. */
function fromDbError(error: PostgrestError): never {
  const text = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", "Your role can't import employees.");
    case "P0002":
    case "MLIM1":
    case "MLIM2":
    case "MLIM3":
    case "MLIM4":
    case "MLLM1":
    case "MLLM2":
    case "MLPR1":
    case "MLPR2":
    case "MLPR3":
      throw new MutationError("invalid", error.message);
    case "23505":
      if (text.includes("workers_staff_id_key")) {
        throw new MutationError(
          "invalid",
          "A staff ID in this file was just given to another employee. Check the file again.",
        );
      }
      break;
    case "MLSI3":
      // A staff ID retired or reserved by a correction since the file was checked (slice 1.11).
      throw new MutationError(
        "invalid",
        "A staff ID in this file was used before in your company. Check the file again.",
      );
  }
  throw new Error(`Database refused the import (${error.code}): ${error.message}`);
}

interface Recheck {
  result: CheckedResult | null;
  rows: { stored: StoredImportRow; result: RowResult }[];
  docs: ImportRowDoc[];
}

/**
 * Checks the open rows of a batch again, from the stored rows and the account as it is now.
 * `fix` patches one row first and records the fix on it.
 */
async function recheck(
  supabase: Client,
  organisationId: string,
  batch: BatchRow,
  fix: { rowNumber: number; patch: Partial<Record<ColumnKey, string>>; label: string } | null,
): Promise<Recheck> {
  const stored = await loadOpenRows(supabase, organisationId, batch.id);
  if (stored.length === 0) return { result: null, rows: [], docs: [] };
  const records = stored.map((row) =>
    recordFromStored(organisationId, row, row.row_number === fix?.rowNumber ? fix.patch : {}),
  );
  const context = await loadImportContext(supabase, organisationId);
  const result = validateImportRecords(records, batch.columns.filter(isColumnKey), context, {
    format: formatOf(batch),
    fileNotes: stringList(batch.file_notes),
  });
  if (!result.ok) throw new Error("A stored import could not be checked again.");

  const byRowNumber = new Map(stored.map((row) => [row.row_number, row]));
  const at = new Date().toISOString();
  const rows: Recheck["rows"] = [];
  const docs: ImportRowDoc[] = [];
  for (const row of result.rows) {
    const storedRow = byRowNumber.get(row.rowNumber);
    if (!storedRow) continue;
    const fixes: AppliedFix[] = readFixes(storedRow.fixes);
    if (fix && row.rowNumber === fix.rowNumber) fixes.push({ label: fix.label, at });
    rows.push({ stored: storedRow, result: row });
    docs.push(toRowDoc(organisationId, storedRow.id, row, fixes));
  }
  return { result, rows, docs };
}

/**
 * Removes a batch's upload from Storage and records it. Storage removes only objects the
 * caller can read, and only the uploader (the batch's creator) can read an upload: for them an
 * empty answer means the file isn't there; for anyone else it may be someone else's file, which
 * is left (not marked removed) for the sweep (sweep.ts) to remove with the secret key.
 */
async function removeUpload(
  supabase: Client,
  organisationId: string,
  userId: string,
  batch: BatchRow,
): Promise<void> {
  if (batch.file_removed_at) return;
  const { data, error } = await supabase.storage.from(IMPORTS_BUCKET).remove([batch.file_path]);
  if (error) throw new Error(`Could not remove the upload: ${error.message}`);
  if ((data ?? []).length === 0 && batch.created_by !== userId) return;
  const { error: updateError } = await supabase
    .from("import_batches")
    .update({ file_removed_at: new Date().toISOString() })
    .eq("id", batch.id)
    .eq("organisation_id", organisationId)
    .is("file_removed_at", null);
  if (updateError) throw new Error(`Could not record the upload's removal: ${updateError.message}`);
}

/** removeUpload where a failure must not stop the step: the sweep removes what is left. */
async function removeUploadQuietly(
  supabase: Client,
  organisationId: string,
  userId: string,
  batch: BatchRow,
): Promise<void> {
  try {
    await removeUpload(supabase, organisationId, userId, batch);
  } catch (cause) {
    console.error(
      "people.import_upload_not_removed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
  }
}

const CHECK_UNFINISHED = "The check didn't finish, so nothing was saved. Upload the file again.";
const UPLOAD_GONE = "This upload was removed before it was checked. Upload the file again.";

interface StoredProblem {
  code: string;
  message: string;
}

/** The file problems stored on a batch, or why it can't be checked any more. */
function storedProblems(batch: BatchRow): StoredProblem[] {
  const problems = Array.isArray(batch.file_problems)
    ? batch.file_problems.flatMap((p) =>
        p && typeof p === "object" && !Array.isArray(p) && typeof p.message === "string"
          ? [{ code: typeof p.code === "string" ? p.code : "file_problem", message: p.message }]
          : [],
      )
    : [];
  return problems.length > 0 ? problems : [{ code: "upload_removed", message: UPLOAD_GONE }];
}

/**
 * A first check that failed part way: say so on the batch (only while it is still
 * `uploaded`, so a check that did finish in the database is never marked failed). Best effort:
 * this runs while another error is on its way to the user.
 */
async function recordUnfinishedCheck(supabase: Client, organisationId: string, batchId: string) {
  try {
    const { error } = await supabase
      .from("import_batches")
      .update({ file_problems: [{ code: "check_unfinished", message: CHECK_UNFINISHED }] })
      .eq("id", batchId)
      .eq("organisation_id", organisationId)
      .eq("status", "uploaded");
    if (error) console.error("people.import_check_not_recorded:", error.code);
  } catch (cause) {
    console.error(
      "people.import_check_not_recorded:",
      cause instanceof Error ? cause.name : "unknown error",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Start: a batch to upload into
// ---------------------------------------------------------------------------------------------

export const startImportSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1, "Choose a file.")
    .max(255, "Rename the file to something shorter and upload it again.")
    .regex(/^[^\p{Cc}<>]*$/u, "Rename the file without < or > and upload it again.")
    .refine((name) => /\.(csv|xlsx)$/i.test(name), "Upload a CSV or Excel (.xlsx) file."),
  size: z.coerce
    .number()
    .int()
    .min(1, "The file is empty. Fill the template and upload it again.")
    .max(
      IMPORT_LIMITS.maxFileBytes,
      "The file is larger than 5 MB. Split it into smaller files and upload each one.",
    ),
});

export interface StartedImport {
  batchId: string;
  path: string;
  contentType: string;
}

export const startImportSpec: MutationSpec<typeof startImportSchema, StartedImport> = {
  schema: startImportSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const format: ImportFormat = /\.xlsx$/i.test(data.fileName) ? "xlsx" : "csv";
    const id = randomUUID();
    const path = `${organisationId}/${id}.${format}`;
    const { error } = await supabase.from("import_batches").insert({
      id,
      organisation_id: organisationId,
      file_name: data.fileName,
      file_format: format,
      file_path: path,
    });
    if (error) fromDbError(error);
    return { batchId: id, path, contentType: IMPORT_CONTENT_TYPES[format] };
  },
};

// ---------------------------------------------------------------------------------------------
// Check: read the upload, validate every row, store them, remove the upload
// ---------------------------------------------------------------------------------------------

export type CheckedImport =
  | { ok: true; batchId: string }
  | { ok: false; batchId: string; problems: (FileProblem | StoredProblem)[] };

export const checkImportSpec: MutationSpec<
  z.ZodObject<{ batchId: typeof batchIdSchema }>,
  CheckedImport
> = {
  schema: z.object({ batchId: batchIdSchema }),
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const batch = await loadBatch(supabase, organisationId, data.batchId);
    if (batch.status !== "uploaded") {
      // Checked already. Make sure the upload is gone (its removal may have failed last time).
      await removeUploadQuietly(supabase, organisationId, userId, batch);
      return { ok: true, batchId: batch.id };
    }
    if (batch.file_removed_at) {
      // Refused, failed part way or past its time: the file has to be uploaded again.
      return { ok: false, batchId: batch.id, problems: storedProblems(batch) };
    }

    const download = await supabase.storage.from(IMPORTS_BUCKET).download(batch.file_path);
    if (download.error || !download.data) {
      throw new MutationError("invalid", "The upload didn't arrive. Choose the file again.");
    }

    // From here on the upload is removed however the check ends. A check that throws is
    // recorded on the batch, which stays `uploaded` and is never reviewed or imported.
    let finished = false;
    try {
      const bytes = new Uint8Array(await download.data.arrayBuffer());
      const context = await loadImportContext(supabase, organisationId);
      const result = await validatePeopleImport({ name: batch.file_name, bytes }, context);

      if (!result.ok) {
        const { error } = await supabase
          .from("import_batches")
          .update({
            file_problems: result.problems.map((p) => ({ code: p.code, message: p.message })),
          })
          .eq("id", batch.id)
          .eq("organisation_id", organisationId);
        if (error) fromDbError(error);
        finished = true;
        return { ok: false, batchId: batch.id, problems: result.problems };
      }

      // Rows a check that stopped part way already stored keep their ids, so they are
      // rewritten rather than skipped (personal data is encrypted for the row id).
      const ids = await storedRowIds(supabase, organisationId, batch.id);
      const docs = result.rows.map((row) =>
        toRowDoc(organisationId, ids.get(row.rowNumber) ?? randomUUID(), row, []),
      );
      await saveCheck(
        supabase,
        organisationId,
        batch.id,
        {
          columns: result.columns.present,
          fileNotes: result.fileNotes,
          summary: summaryDoc(result),
          rowsExpected: docs.length,
        },
        docs,
      );
      finished = true;
      return { ok: true, batchId: batch.id };
    } finally {
      if (!finished) await recordUnfinishedCheck(supabase, organisationId, batch.id);
      await removeUploadQuietly(supabase, organisationId, userId, batch);
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Fix: apply one suggested fix to a held row, then check the batch again
// ---------------------------------------------------------------------------------------------

export const applyImportFixSchema = z.object({
  batchId: batchIdSchema,
  rowNumber: z.coerce.number().int().min(2).max(1_000_000),
  fixLabel: z.string().trim().min(1).max(300),
});

export const applyImportFixSpec: MutationSpec<
  typeof applyImportFixSchema,
  { rowNumber: number; label: string; columns: string[] }
> = {
  schema: applyImportFixSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const batch = await loadBatch(supabase, organisationId, data.batchId);
    if (batch.status !== "validated" && batch.status !== "committed") {
      throw new MutationError("invalid", "This import can't be changed any more.");
    }
    // The fix comes from a fresh check of the batch, never from the stored review or the form.
    const fresh = await recheck(supabase, organisationId, batch, null);
    const row = fresh.rows.find((r) => r.result.rowNumber === data.rowNumber);
    const fix = row?.result.problems.find((p) => p.fix?.label === data.fixLabel)?.fix;
    if (!row || !fix) {
      await saveFresh(supabase, organisationId, batch, fresh);
      throw new MutationError(
        "invalid",
        `Row ${data.rowNumber} has changed since this list was shown. Check it again.`,
      );
    }
    const fixed = await recheck(supabase, organisationId, batch, {
      rowNumber: data.rowNumber,
      patch: fix.patch,
      label: fix.label,
    });
    await saveFresh(supabase, organisationId, batch, fixed);
    return { rowNumber: data.rowNumber, label: fix.label, columns: Object.keys(fix.patch) };
  },
  // Which fix, on which row and columns; never the values (a fix can clear an account number).
  event: ({ result, data }) => ({
    action: "people.import_row_fixed",
    entity: "import_batches",
    entityId: data.batchId,
    after: { row_number: result.rowNumber, fix: result.label, columns: result.columns },
  }),
};

async function saveFresh(
  supabase: Client,
  organisationId: string,
  batch: BatchRow,
  check: Recheck,
) {
  if (!check.result) return;
  await saveCheck(
    supabase,
    organisationId,
    batch.id,
    {
      columns: batch.columns,
      fileNotes: stringList(batch.file_notes),
      // The summary describes the file as checked before anything was imported.
      summary: batch.status === "committed" ? null : summaryDoc(check.result),
    },
    check.docs,
  );
}

// ---------------------------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------------------------

export const commitImportSchema = z.object({
  batchId: batchIdSchema,
  /** The number on the button the user pressed ("Import 160 employees"). */
  expected: z.coerce.number().int().min(0).max(IMPORT_LIMITS.maxRows),
});

export type CommittedImport =
  | {
      status: "imported";
      created: number;
      alreadyImported: number;
      departments: number;
      clients: number;
      sites: number;
      projects: number;
      /**
       * Workers whose bank details were saved without a second approver: the owner's import
       * while company setup is unfinished (owner decision 20, slice 1.11). Otherwise 0, and the
       * bank details wait in Bank-detail approvals.
       */
      bankDetailsSaved: number;
    }
  | { status: "changed"; importable: number };

const commitResultSchema = z.object({
  created: z.number().int(),
  already_imported: z.number().int(),
  departments: z.number().int(),
  clients: z.number().int(),
  sites: z.number().int(),
  projects: z.number().int(),
  bank_details_saved: z.number().int().default(0),
});

export const commitImportSpec: MutationSpec<typeof commitImportSchema, CommittedImport> = {
  schema: commitImportSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const batch = await loadBatch(supabase, organisationId, data.batchId);
    if (batch.status === "uploaded") {
      throw new MutationError("invalid", "Check the file before importing it.");
    }
    if (batch.status === "cancelled") {
      throw new MutationError("invalid", "This import was cancelled. Upload the file again.");
    }
    // Everything commit needs is in the stored rows; an upload left behind goes now.
    await removeUploadQuietly(supabase, organisationId, userId, batch);

    const fresh = await recheck(supabase, organisationId, batch, null);
    const importable = importableCount(fresh.rows.map((r) => r.result));
    // Nothing left to import (for example the same button pressed twice): nothing happens.
    if (importable === 0) {
      return {
        status: "imported",
        created: 0,
        alreadyImported: 0,
        departments: 0,
        clients: 0,
        sites: 0,
        projects: 0,
        bankDetailsSaved: 0,
      };
    }
    if (importable !== data.expected) {
      await saveFresh(supabase, organisationId, batch, fresh);
      return { status: "changed", importable };
    }

    const payload = buildCommitPayload(
      organisationId,
      fresh.rows.map((r) => ({ rowId: r.stored.id, result: r.result })),
    );
    const { data: committed, error } = await supabase.rpc("commit_import_batch", {
      p_organisation_id: organisationId,
      p_batch_id: batch.id,
      p_rows: payload as unknown as Json,
    });
    if (error) fromDbError(error);
    const counts = commitResultSchema.parse(committed);

    // The rows still held are checked again against the account as it is now (their line
    // managers may have just been created). The import above has already happened, so a
    // failure here only leaves the review a step behind.
    try {
      const after = await recheck(
        supabase,
        organisationId,
        { ...batch, status: "committed" },
        null,
      );
      await saveFresh(supabase, organisationId, { ...batch, status: "committed" }, after);
    } catch (cause) {
      console.error(
        "people.import_recheck_failed:",
        cause instanceof Error ? cause.name : "unknown error",
      );
    }

    return {
      status: "imported",
      created: counts.created,
      alreadyImported: counts.already_imported,
      departments: counts.departments,
      clients: counts.clients,
      sites: counts.sites,
      projects: counts.projects,
      bankDetailsSaved: counts.bank_details_saved,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

export const cancelImportSpec: MutationSpec<
  z.ZodObject<{ batchId: typeof batchIdSchema }>,
  { batchId: string }
> = {
  schema: z.object({ batchId: batchIdSchema }),
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const batch = await loadBatch(supabase, organisationId, data.batchId);
    const { error } = await supabase.rpc("cancel_import_batch", {
      p_organisation_id: organisationId,
      p_batch_id: batch.id,
    });
    if (error) fromDbError(error);
    // An upload that was never checked: remove it too. Best effort; the batch is cancelled.
    await removeUploadQuietly(supabase, organisationId, userId, batch);
    return { batchId: batch.id };
  },
};
