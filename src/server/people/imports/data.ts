import "server-only";

import { cache } from "react";
import { z } from "zod";

import { formatNaira, toKobo } from "@/lib/money";
import { createServerSupabase } from "@/lib/supabase/server";
import { getSession } from "@/server/identity/session";
import type { Database, Json } from "@/types/db";

/**
 * Reads for the import review screen, with the signed-in user's own client (RLS: owner, admin
 * and hr). The stored rows carry no personal data (see rows.ts), and nothing here decrypts.
 */

type BatchStatus = Database["public"]["Enums"]["import_batch_status"];
type RowStatus = Database["public"]["Enums"]["import_row_status"];

const nameSchema = z.object({ name: z.string() }).nullable().catch(null);

const normalisedSchema = z
  .object({
    worker: z.object({
      staffId: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      jobTitle: z.string(),
      needsPayDetails: z.boolean(),
      supervisorClockIn: z.boolean(),
    }),
    department: nameSchema,
    lineManager: nameSchema,
    payRate: z
      .object({
        payType: z.enum(["monthly", "daily"]),
        basicKobo: z.string(),
        housingKobo: z.string(),
        transportKobo: z.string(),
        otherAllowancesKobo: z.string(),
        dailyRateKobo: z.string(),
      })
      .nullable()
      .catch(null),
    mapping: z.object({ client: nameSchema, project: nameSchema, site: nameSchema }),
  })
  .nullable()
  .catch(null);

const problemsSchema = z
  .array(
    z.object({
      message: z.string(),
      fix: z.object({ label: z.string() }).nullable().catch(null),
    }),
  )
  .catch([]);

const warningsSchema = z
  .array(
    z.object({
      message: z.string(),
      attention: z.boolean(),
      appliedFix: z.string().nullable().catch(null),
    }),
  )
  .catch([]);

const summarySchema = z
  .object({
    rows: z.number(),
    foundLine: z.string(),
    needsPayDetails: z.number(),
    supervisorClockIn: z.number(),
    newNames: z.object({
      departments: z.array(z.string()),
      clients: z.array(z.string()),
      projects: z.array(z.object({ client: z.string(), name: z.string() })),
      sites: z.array(z.object({ client: z.string(), name: z.string() })),
    }),
  })
  .nullable()
  .catch(null);

const messagesSchema = z.array(z.object({ message: z.string() })).catch([]);
const stringsSchema = z.array(z.string()).catch([]);

function rawText(raw: Json, key: string): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

export interface AttentionRow {
  rowNumber: number;
  name: string;
  staffId: string;
  status: RowStatus;
  problems: { message: string; fixLabel: string | null }[];
  warnings: { message: string; appliedFix: string | null }[];
}

export interface PreviewRow {
  rowNumber: number;
  name: string;
  jobTitle: string;
  lineManager: string;
  clientProject: string;
  site: string;
  pay: string;
  flags: string[];
}

export interface ImportBatchView {
  id: string;
  fileName: string;
  status: BatchStatus;
  rowsTotal: number;
  rowsReady: number;
  rowsHeld: number;
  rowsImported: number;
  /** Rows listed for attention that still import (duplicate phone with the fix applied). */
  rowsAttention: number;
  foundLine: string | null;
  newNames: { departments: number; clients: number; projects: number; sites: number } | null;
  needsPayDetails: number;
  fileProblems: string[];
  fileNotes: string[];
  attention: AttentionRow[];
  preview: PreviewRow[];
  /** Imported workers with a department, line manager and site. */
  importedMapped: number;
}

/** Ready rows shown in the preview table. */
export const PREVIEW_ROWS = 25;

type Normalised = NonNullable<z.infer<typeof normalisedSchema>>;

function payText(n: Normalised): string {
  const r = n.payRate;
  if (!r) return "Needs pay details";
  if (r.payType === "daily")
    return `${formatNaira(toKobo(r.dailyRateKobo), { whole: true })} a day`;
  const monthly =
    toKobo(r.basicKobo) +
    toKobo(r.housingKobo) +
    toKobo(r.transportKobo) +
    toKobo(r.otherAllowancesKobo);
  return `${formatNaira(monthly, { whole: true })} a month`;
}

function joinNames(...names: (string | undefined)[]): string {
  return names.filter((n): n is string => Boolean(n)).join(" · ");
}

interface AttentionSource {
  row_number: number;
  raw: Json;
  status: RowStatus;
  errors: Json;
  warnings: Json;
}

function toAttentionRow(row: AttentionSource): AttentionRow {
  return {
    rowNumber: row.row_number,
    name: `${rawText(row.raw, "first_name")} ${rawText(row.raw, "last_name")}`.trim(),
    staffId: rawText(row.raw, "employee_id"),
    status: row.status,
    problems: problemsSchema
      .parse(row.errors)
      .map((p) => ({ message: p.message, fixLabel: p.fix?.label ?? null })),
    warnings: warningsSchema
      .parse(row.warnings)
      .filter((w) => w.attention)
      .map((w) => ({ message: w.message, appliedFix: w.appliedFix })),
  };
}

const PAGE = 1000;

/** The batch and its rows for review, or null when it isn't in the active organisation. */
export const getImportBatchView = cache(
  async (batchId: string): Promise<ImportBatchView | null> => {
    if (!z.uuid().safeParse(batchId).success) return null;
    const session = await getSession();
    if (!session?.active) return null;
    const organisationId = session.active.organisationId;
    const supabase = await createServerSupabase();

    const { data: batch, error } = await supabase
      .from("import_batches")
      .select(
        "id, file_name, status, rows_total, rows_ready, rows_held, rows_imported, summary, file_notes, file_problems",
      )
      .eq("id", batchId)
      .eq("organisation_id", organisationId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the import: ${error.message}`);
    if (!batch) return null;

    const [attention, preview, imported] = await Promise.all([
      supabase
        .from("import_rows")
        .select("row_number, raw, status, errors, warnings")
        .eq("batch_id", batchId)
        .eq("organisation_id", organisationId)
        .neq("status", "imported")
        .or("status.eq.held,attention.eq.true")
        .order("row_number")
        .limit(PAGE),
      supabase
        .from("import_rows")
        .select("row_number, status, normalised")
        .eq("batch_id", batchId)
        .eq("organisation_id", organisationId)
        .in("status", ["ready", "fixed"])
        .order("row_number")
        .limit(PREVIEW_ROWS),
      (async () => {
        let mapped = 0;
        for (let from = 0; ; from += PAGE) {
          const { data, error: readError } = await supabase
            .from("import_rows")
            .select("normalised")
            .eq("batch_id", batchId)
            .eq("organisation_id", organisationId)
            .eq("status", "imported")
            .order("row_number")
            .range(from, from + PAGE - 1);
          if (readError) throw new Error(`Could not read imported rows: ${readError.message}`);
          for (const row of data ?? []) {
            const n = normalisedSchema.parse(row.normalised);
            if (n?.department && n.lineManager && n.mapping.site) mapped += 1;
          }
          if (!data || data.length < PAGE) return mapped;
        }
      })(),
    ]);
    if (attention.error)
      throw new Error(`Could not read the import rows: ${attention.error.message}`);
    if (preview.error) throw new Error(`Could not read the import rows: ${preview.error.message}`);

    const summary = summarySchema.parse(batch.summary);
    const attentionRows: AttentionRow[] = (attention.data ?? []).map(toAttentionRow);

    const previewRows: PreviewRow[] = (preview.data ?? []).flatMap((row) => {
      const n = normalisedSchema.parse(row.normalised);
      if (!n) return [];
      const flags: string[] = [];
      if (n.worker.needsPayDetails) flags.push("Needs pay details");
      if (n.worker.supervisorClockIn) flags.push("Supervisor clock-in");
      return [
        {
          rowNumber: row.row_number,
          name: `${n.worker.firstName} ${n.worker.lastName}`.trim(),
          jobTitle: n.worker.jobTitle,
          lineManager: n.lineManager?.name ?? "",
          clientProject: joinNames(n.mapping.client?.name, n.mapping.project?.name),
          site: n.mapping.site?.name ?? "",
          pay: payText(n),
          flags,
        },
      ];
    });

    return {
      id: batch.id,
      fileName: batch.file_name,
      status: batch.status,
      rowsTotal: batch.rows_total,
      rowsReady: batch.rows_ready,
      rowsHeld: batch.rows_held,
      rowsImported: batch.rows_imported,
      rowsAttention: attentionRows.filter((r) => r.status !== "held").length,
      foundLine: summary?.foundLine ?? null,
      newNames: summary
        ? {
            departments: summary.newNames.departments.length,
            clients: summary.newNames.clients.length,
            projects: summary.newNames.projects.length,
            sites: summary.newNames.sites.length,
          }
        : null,
      needsPayDetails: summary?.needsPayDetails ?? 0,
      fileProblems: messagesSchema.parse(batch.file_problems).map((p) => p.message),
      fileNotes: stringsSchema.parse(batch.file_notes),
      attention: attentionRows,
      preview: previewRows,
      importedMapped: imported,
    };
  },
);

/** Every row listed for attention, for "Download problems (.csv)". */
export async function listImportProblemRows(
  organisationId: string,
  batchId: string,
): Promise<AttentionRow[]> {
  const supabase = await createServerSupabase();
  const rows: AttentionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("import_rows")
      .select("row_number, raw, status, errors, warnings")
      .eq("batch_id", batchId)
      .eq("organisation_id", organisationId)
      .neq("status", "imported")
      .or("status.eq.held,attention.eq.true")
      .order("row_number")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read the import rows: ${error.message}`);
    rows.push(...(data ?? []).map(toAttentionRow));
    if (!data || data.length < PAGE) return rows;
  }
}
