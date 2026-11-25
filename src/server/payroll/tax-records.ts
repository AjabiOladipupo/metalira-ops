import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatNaira, parseNairaToKobo, toKobo, type Kobo } from "@/lib/money";
import { PERSONAL_NUMBER_MESSAGE, hasPersonalNumber } from "@/lib/personal-number";
import {
  MAX_RECEIPT_BYTES,
  PAYROLL_LINK_SECONDS,
  RECEIPT_TYPES,
  checkUploadedReceipt,
  receiptExtensionOf,
  type ReceiptExt,
} from "@/lib/payroll/receipts";
import type { ManagerRole } from "@/lib/roles";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * Payroll tax records (slice 5.9a, the tax adviser's answers of 24 Nov 2026; migration
 * 20261122230000): opening balances at go-live, relief declarations (rent, NHIS or NHIA, life
 * assurance or deferred annuity) with their proof files and verification, NHF numbers on file,
 * and the company's ITF turnover switch. Owner and hr write; owner, hr and finance read. Every
 * write is one SQL function as the user (which checks the role and a trusted session again),
 * insert-only and audited; a money write has a preview.
 *
 * Proof files follow 5.6's receipts: the server gives the browser a signed upload token for one
 * exact path in the private `payroll-relief-proofs` bucket
 * ({organisation_id}/{worker_id}/{declaration_id}/{proof_id}.{ext}) after an RLS-checked read of
 * the declaration; then reads the object back, checks its type from its magic bytes and its size,
 * works out its sha256 and records it with the secret key naming the verified user. A file that
 * fails is deleted. Files open by 60-second signed links, audited. Never log a number or a file.
 * Module: payroll.
 */

type Client = SupabaseClient<Database>;

export const RELIEF_PROOFS_BUCKET = "payroll-relief-proofs";

export const TAX_RECORD_WRITERS = ["owner", "hr"] as const satisfies readonly ManagerRole[];
export const TAX_RECORD_READERS = [
  "owner",
  "hr",
  "finance",
] as const satisfies readonly ManagerRole[];

export function canWriteTaxRecords(role: ManagerRole): boolean {
  return (TAX_RECORD_WRITERS as readonly ManagerRole[]).includes(role);
}

export const RELIEF_KINDS = ["rent", "nhis", "life_assurance"] as const;
export type ReliefKind = (typeof RELIEF_KINDS)[number];

export const RELIEF_LABELS: Record<ReliefKind, string> = {
  rent: "Rent",
  nhis: "NHIS or NHIA contributions",
  life_assurance: "Life assurance or deferred annuity",
};

export const DOCUMENT_KINDS = [
  "tenancy_agreement",
  "rent_receipt",
  "payment_record",
  "contribution_statement",
  "policy_document",
  "premium_receipt",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  tenancy_agreement: "Tenancy agreement",
  rent_receipt: "Rent receipt",
  payment_record: "Payment record",
  contribution_statement: "Contribution statement",
  policy_document: "Policy document",
  premium_receipt: "Premium receipt",
  other: "Other proof",
};

const reload = "Reload the page and try again";
const money = (k: Kobo) => formatNaira(k, { whole: k % 100n === 0n });

const plain = (max: number, what: string, required: boolean) => {
  const message = `${what} in up to ${max} characters, with no web addresses or < >`;
  const base = z
    .string(message)
    .trim()
    .max(max, message)
    .refine((v) => !/[\u0000-\u001f\u007f-\u009f<>]/.test(v), message)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), message)
    .refine((v) => !hasPersonalNumber(v), PERSONAL_NUMBER_MESSAGE);
  return required ? base.min(1, message) : base;
};

const reason = plain(500, "Give a reason", true);

/** Naira as typed ("120,000" or "120000.50"), whole kobo from 0. */
const naira = (what: string) =>
  z
    .string(`Enter ${what} in naira, like 120000 or 120,000.00`)
    .trim()
    .transform((v, ctx): Kobo => {
      try {
        const kobo = parseNairaToKobo(v === "" ? "0" : v);
        if (kobo < 0n || kobo > 100_000_000_000_000n) throw new RangeError("out of range");
        return kobo;
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `Enter ${what} in naira, like 120000 or 120,000.00`,
        });
        return z.NEVER;
      }
    });

const taxYear = z.coerce
  .number("Choose the tax year")
  .int("Choose the tax year")
  .min(2000, "Choose the tax year")
  .max(2100, "Choose the tax year");

/** "2026-09" (a month input) → "2026-09-01". */
const month = z
  .string("Choose the last month the balance covers")
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose the last month the balance covers")
  .transform((v) => `${v}-01`);

const optionalId = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : null))
  .pipe(z.uuid(reload).nullable());

export const openingBalanceSchema = z
  .object({
    workerId: z.uuid(reload),
    taxYear,
    asOfMonth: month,
    gross: naira("gross pay"),
    chargeable: naira("chargeable pay"),
    paye: naira("the PAYE"),
    pension: naira("the pension"),
    reason,
    supersedesId: optionalId,
  })
  .superRefine((v, ctx) => {
    if (Number(v.asOfMonth.slice(0, 4)) !== v.taxYear) {
      ctx.addIssue({
        code: "custom",
        path: ["asOfMonth"],
        message: "Choose a month inside the tax year",
      });
    }
    if (v.paye > v.gross) {
      ctx.addIssue({ code: "custom", path: ["paye"], message: "PAYE is no more than gross pay" });
    }
  });

export const importOpeningSchema = z
  .object({
    taxYear,
    asOfMonth: month,
    rows: z
      .string("Paste the rows")
      .trim()
      .min(1, "Paste the rows: staff ID, gross, chargeable pay, PAYE, pension")
      .max(400_000, "Import up to 2,000 rows at a time"),
    reason,
  })
  .superRefine((v, ctx) => {
    if (Number(v.asOfMonth.slice(0, 4)) !== v.taxYear) {
      ctx.addIssue({
        code: "custom",
        path: ["asOfMonth"],
        message: "Choose a month inside the tax year",
      });
    }
  });

export const declareReliefSchema = z.object({
  workerId: z.uuid(reload),
  taxYear,
  kind: z.enum(RELIEF_KINDS, "Choose the relief"),
  amount: naira("the yearly amount"),
  reason,
  supersedesId: optionalId,
});

export const startProofSchema = z.object({
  declarationId: z.uuid(reload),
  documentKind: z.enum(DOCUMENT_KINDS, "Choose what the file is"),
  fileName: z
    .string()
    .trim()
    .min(1, "Choose the file.")
    .max(255, "Rename the file to something shorter and upload it again.")
    .refine((name) => receiptExtensionOf(name) !== null, "Upload a PDF, PNG or JPEG."),
  size: z.coerce
    .number()
    .int()
    .min(1, "The file is empty. Choose another.")
    .max(MAX_RECEIPT_BYTES, "The file is larger than 10 MB. Upload a smaller copy."),
});

export const recordProofSchema = z.object({
  declarationId: z.uuid(reload),
  documentKind: z.enum(DOCUMENT_KINDS, "Choose what the file is"),
  proofId: z.uuid("Upload the file again"),
  fileExt: z.enum(["pdf", "png", "jpg"], "Upload a PDF, PNG or JPEG"),
});

export const verifyReliefSchema = z
  .object({
    declarationId: z.uuid(reload),
    decision: z.enum(["verified", "rejected"], "Verify or reject the proof"),
    note: plain(500, "A note", false).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "rejected" && !v.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Say why the proof is rejected" });
    }
  });

export const proofLinkSchema = z.object({ proofId: z.uuid(reload) });

export const nhfNumberSchema = z.object({
  workerId: z.uuid(reload),
  nhfNumber: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .refine(
      (v) => v === "" || /^[A-Za-z0-9/-]{4,20}$/.test(v),
      "An NHF number is 4 to 20 letters, digits, / or -",
    ),
  reason,
});

export const itfFlagSchema = z.object({
  value: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "on"),
  reason,
});

/** Database refusals in plain English. */
export function fromTaxRecordsDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "42501") {
    throw new MutationError(
      "forbidden",
      "Your role can't change payroll tax records. The owner or HR does.",
    );
  }
  if (error.code === "P0002")
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  if (/^MLYA[1-5]$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code})`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface OpeningBalanceView {
  id: string;
  asOfMonth: string;
  grossKobo: Kobo;
  chargeableKobo: Kobo;
  payeKobo: Kobo;
  pensionKobo: Kobo;
  reason: string;
  createdAt: string;
  /** How many rows came before (corrections). */
  corrections: number;
}

export interface ProofView {
  id: string;
  documentKind: DocumentKind;
  fileExt: string;
  createdAt: string;
}

export type ReliefStatus = "not_verified" | "verified" | "rejected";

export interface ReliefView {
  id: string;
  kind: ReliefKind;
  annualKobo: Kobo;
  reason: string;
  createdAt: string;
  status: ReliefStatus;
  statusNote: string | null;
  proofs: ProofView[];
}

export interface WorkerTaxRecords {
  taxYear: number;
  opening: OpeningBalanceView | null;
  reliefs: ReliefView[];
  /** Last 4 characters of the NHF number on file, or null. */
  nhfLast4: string | null;
}

interface OpeningRow {
  id: string;
  as_of_month: string;
  ytd_gross_kobo: string;
  ytd_chargeable_kobo: string;
  ytd_paye_kobo: string;
  ytd_pension_kobo: string;
  supersedes_id: string | null;
  reason: string;
  created_at: string;
}

/** The row nobody superseded (the chain's head). */
function head<T extends { id: string; supersedes_id: string | null }>(rows: readonly T[]): T | null {
  const superseded = new Set(rows.flatMap((r) => (r.supersedes_id ? [r.supersedes_id] : [])));
  return rows.find((r) => !superseded.has(r.id)) ?? null;
}

/** The worker's tax records for a tax year (RLS: owner, hr and finance). */
export async function loadWorkerTaxRecords(
  supabase: Client,
  organisationId: string,
  workerId: string,
  year: number,
): Promise<WorkerTaxRecords> {
  const [openings, declarations, nhf] = await Promise.all([
    supabase
      .from("payroll_opening_balances")
      .select(
        "id, as_of_month, ytd_gross_kobo::text, ytd_chargeable_kobo::text, ytd_paye_kobo::text, ytd_pension_kobo::text, supersedes_id, reason, created_at",
      )
      .eq("organisation_id", organisationId)
      .eq("worker_id", workerId)
      .eq("tax_year", year),
    supabase
      .from("payroll_relief_declarations")
      .select("id, kind, annual_amount_kobo::text, supersedes_id, reason, created_at")
      .eq("organisation_id", organisationId)
      .eq("worker_id", workerId)
      .eq("tax_year", year),
    supabase
      .from("payroll_nhf_numbers")
      .select("nhf_number, created_at, id")
      .eq("organisation_id", organisationId)
      .eq("worker_id", workerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1),
  ]);
  if (openings.error || declarations.error || nhf.error) {
    throw new Error("Could not read the payroll tax records");
  }
  const openingRows = (openings.data ?? []) as unknown as OpeningRow[];
  const opening = head(openingRows);
  const declRows = (declarations.data ?? []) as unknown as {
    id: string;
    kind: ReliefKind;
    annual_amount_kobo: string;
    supersedes_id: string | null;
    reason: string;
    created_at: string;
  }[];
  // One chain per kind: its head is the declaration in force.
  const inForce = RELIEF_KINDS.flatMap((kind) => {
    const h = head(declRows.filter((d) => d.kind === kind));
    return h ? [h] : [];
  });
  const ids = inForce.map((d) => d.id);
  const [proofs, verifications] = ids.length
    ? await Promise.all([
        supabase
          .from("payroll_relief_proofs")
          .select("id, declaration_id, document_kind, file_ext, created_at")
          .eq("organisation_id", organisationId)
          .in("declaration_id", ids)
          .order("created_at"),
        supabase
          .from("payroll_relief_verifications")
          .select("declaration_id, decision, note, created_at, id")
          .eq("organisation_id", organisationId)
          .in("declaration_id", ids)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (proofs.error || verifications.error) throw new Error("Could not read the reliefs' proofs");
  const latest = new Map<string, { decision: string; note: string | null }>();
  for (const v of verifications.data ?? []) {
    if (!latest.has(v.declaration_id)) latest.set(v.declaration_id, v);
  }
  const number = nhf.data?.[0]?.nhf_number ?? null;
  return {
    taxYear: year,
    opening: opening
      ? {
          id: opening.id,
          asOfMonth: opening.as_of_month,
          grossKobo: toKobo(opening.ytd_gross_kobo),
          chargeableKobo: toKobo(opening.ytd_chargeable_kobo),
          payeKobo: toKobo(opening.ytd_paye_kobo),
          pensionKobo: toKobo(opening.ytd_pension_kobo),
          reason: opening.reason,
          createdAt: opening.created_at,
          corrections: openingRows.length - 1,
        }
      : null,
    reliefs: inForce.map((d) => {
      const v = latest.get(d.id);
      return {
        id: d.id,
        kind: d.kind,
        annualKobo: toKobo(d.annual_amount_kobo),
        reason: d.reason,
        createdAt: d.created_at,
        status: v?.decision === "verified" ? "verified" : v ? "rejected" : "not_verified",
        statusNote: v?.note ?? null,
        proofs: (proofs.data ?? [])
          .filter((p) => p.declaration_id === d.id)
          .map((p) => ({
            id: p.id,
            documentKind: p.document_kind as DocumentKind,
            fileExt: p.file_ext,
            createdAt: p.created_at,
          })),
      } satisfies ReliefView;
    }),
    nhfLast4: number ? number.slice(-4) : null,
  };
}

export interface AwaitingRelief {
  id: string;
  workerId: string;
  workerName: string;
  kind: ReliefKind;
  annualKobo: Kobo;
  proofs: number;
  rejected: boolean;
}

export interface CompanyTaxRecords {
  taxYear: number;
  itfTurnoverOver50m: boolean;
  openingBalances: number;
  awaiting: AwaitingRelief[];
}

/** Settings > Payroll rules: the ITF switch, opening balances on file and reliefs to verify. */
export async function loadCompanyTaxRecords(
  supabase: Client,
  organisationId: string,
  year: number,
): Promise<CompanyTaxRecords> {
  const [org, openings, declarations] = await Promise.all([
    supabase
      .from("organisations")
      .select("itf_turnover_over_50m")
      .eq("id", organisationId)
      .maybeSingle(),
    supabase
      .from("payroll_opening_balances")
      .select("id, worker_id, supersedes_id")
      .eq("organisation_id", organisationId)
      .eq("tax_year", year)
      .limit(10000),
    supabase
      .from("payroll_relief_declarations")
      .select("id, worker_id, kind, annual_amount_kobo::text, supersedes_id")
      .eq("organisation_id", organisationId)
      .eq("tax_year", year)
      .limit(10000),
  ]);
  if (org.error || openings.error || declarations.error) {
    throw new Error("Could not read the payroll tax records");
  }
  const superseded = new Set(
    (openings.data ?? []).flatMap((r) => (r.supersedes_id ? [r.supersedes_id] : [])),
  );
  const openingCount = (openings.data ?? []).filter((r) => !superseded.has(r.id)).length;
  const declRows = (declarations.data ?? []) as unknown as {
    id: string;
    worker_id: string;
    kind: ReliefKind;
    annual_amount_kobo: string;
    supersedes_id: string | null;
  }[];
  const replaced = new Set(declRows.flatMap((d) => (d.supersedes_id ? [d.supersedes_id] : [])));
  const current = declRows.filter((d) => !replaced.has(d.id));
  const ids = current.map((d) => d.id);
  const latest = new Map<string, string>();
  const proofCount = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [v, p] = await Promise.all([
      supabase
        .from("payroll_relief_verifications")
        .select("declaration_id, decision, created_at, id")
        .eq("organisation_id", organisationId)
        .in("declaration_id", chunk)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
      supabase
        .from("payroll_relief_proofs")
        .select("declaration_id")
        .eq("organisation_id", organisationId)
        .in("declaration_id", chunk),
    ]);
    if (v.error || p.error) throw new Error("Could not read the reliefs' proofs");
    for (const row of v.data ?? []) {
      if (!latest.has(row.declaration_id)) latest.set(row.declaration_id, row.decision);
    }
    for (const row of p.data ?? []) {
      proofCount.set(row.declaration_id, (proofCount.get(row.declaration_id) ?? 0) + 1);
    }
  }
  const waiting = current.filter((d) => latest.get(d.id) !== "verified");
  const workerIds = [...new Set(waiting.map((d) => d.worker_id))];
  const names = new Map<string, string>();
  for (let i = 0; i < workerIds.length; i += 200) {
    const { data, error } = await supabase
      .from("workers")
      .select("id, first_name, last_name")
      .eq("organisation_id", organisationId)
      .in("id", workerIds.slice(i, i + 200));
    if (error) throw new Error("Could not read the workers");
    for (const w of data ?? []) names.set(w.id, `${w.first_name} ${w.last_name}`.trim());
  }
  return {
    taxYear: year,
    itfTurnoverOver50m: org.data?.itf_turnover_over_50m === true,
    openingBalances: openingCount,
    awaiting: waiting
      .map((d) => ({
        id: d.id,
        workerId: d.worker_id,
        workerName: names.get(d.worker_id) ?? "A worker",
        kind: d.kind,
        annualKobo: toKobo(d.annual_amount_kobo),
        proofs: proofCount.get(d.id) ?? 0,
        rejected: latest.get(d.id) === "rejected",
      }))
      .sort((a, b) => a.workerName.localeCompare(b.workerName)),
  };
}

async function readDeclaration(
  supabase: Client,
  organisationId: string,
  id: string,
): Promise<{ id: string; workerId: string; kind: ReliefKind; taxYear: number; annualKobo: Kobo }> {
  const { data, error } = await supabase
    .from("payroll_relief_declarations")
    .select("id, worker_id, kind, tax_year, annual_amount_kobo::text")
    .eq("organisation_id", organisationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the declaration (${error.code})`);
  const d = data as unknown as {
    id: string;
    worker_id: string;
    kind: ReliefKind;
    tax_year: number;
    annual_amount_kobo: string;
  } | null;
  if (!d) throw new MutationError("invalid", "That declaration wasn't found. Reload the page.");
  return {
    id: d.id,
    workerId: d.worker_id,
    kind: d.kind,
    taxYear: d.tax_year,
    annualKobo: toKobo(d.annual_amount_kobo),
  };
}

async function workerName(supabase: Client, organisationId: string, id: string): Promise<string> {
  const { data, error } = await supabase
    .from("workers")
    .select("first_name, last_name")
    .eq("organisation_id", organisationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the worker (${error.code})`);
  if (!data) throw new MutationError("invalid", "That worker wasn't found. Reload the page.");
  return `${data.first_name} ${data.last_name}`.trim();
}

// ---------------------------------------------------------------------------
// Previews (the confirm step's, and the capability registry's)
// ---------------------------------------------------------------------------

type Ctx = Pick<MutationContext, "supabase" | "organisationId">;

const monthLabel = (iso: string) =>
  new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export async function previewOpeningBalance(
  ctx: Ctx,
  data: z.output<typeof openingBalanceSchema>,
): Promise<CapabilityPreview> {
  const [name, records] = await Promise.all([
    workerName(ctx.supabase, ctx.organisationId, data.workerId),
    loadWorkerTaxRecords(ctx.supabase, ctx.organisationId, data.workerId, data.taxYear),
  ]);
  const before = records.opening;
  if ((before?.id ?? null) !== data.supersedesId) {
    throw new MutationError(
      "invalid",
      before
        ? "An opening balance for this year is already on file. Correct the one in force."
        : "That opening balance isn't the one in force. Reload the page.",
    );
  }
  const row = (label: string, b: Kobo | undefined, a: Kobo) => ({
    label,
    ...(b !== undefined ? { before: money(b) } : {}),
    after: money(a),
  });
  return {
    summary: `${before ? "Corrects" : "Records"} ${name}'s ${data.taxYear} opening balance to ${monthLabel(data.asOfMonth)}: PAYE ${money(data.paye)} withheld on chargeable pay of ${money(data.chargeable)}. Year-to-date PAYE counts it from the next run; the earlier row is kept.`,
    changes: [
      row("Gross pay to date", before?.grossKobo, data.gross),
      row("Chargeable pay to date", before?.chargeableKobo, data.chargeable),
      row("PAYE withheld to date", before?.payeKobo, data.paye),
      row("Pension to date", before?.pensionKobo, data.pension),
      {
        label: "Covers to",
        ...(before ? { before: monthLabel(before.asOfMonth) } : {}),
        after: monthLabel(data.asOfMonth),
      },
    ],
  };
}

export interface ImportRow {
  staffId: string;
  gross: Kobo;
  chargeable: Kobo;
  paye: Kobo;
  pension: Kobo;
}

/** "MLS-0001, 1200000, 1000000, 90000, 96000" per line; a header line is skipped. */
export function parseOpeningRows(text: string): { rows: ImportRow[]; errors: string[] } {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  lines.forEach((line, i) => {
    // Quoted cells keep their commas ("1,200,000").
    const cells = [...line.matchAll(/"([^"]*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2] ?? "").trim());
    if (i === 0 && /staff/i.test(cells[0] ?? "")) return;
    if (cells.length !== 5) {
      errors.push(`Line ${i + 1}: give staff ID, gross, chargeable pay, PAYE and pension`);
      return;
    }
    try {
      const [staffId, ...amounts] = cells as [string, string, string, string, string];
      const [gross, chargeable, paye, pension] = amounts.map((a) => parseNairaToKobo(a)) as [
        Kobo,
        Kobo,
        Kobo,
        Kobo,
      ];
      if ([gross, chargeable, paye, pension].some((k) => k < 0n) || paye > gross) {
        throw new RangeError("range");
      }
      rows.push({ staffId, gross, chargeable, paye, pension });
    } catch {
      errors.push(`Line ${i + 1}: amounts are naira from 0, and PAYE is no more than gross`);
    }
  });
  if (rows.length > 2000) errors.push("Import up to 2,000 rows at a time");
  return { rows, errors };
}

/** Staff IDs to worker ids, through an RLS read; unknown or repeated IDs refuse the import. */
async function mapImportRows(
  ctx: Ctx,
  data: z.output<typeof importOpeningSchema>,
): Promise<{ workerId: string; row: ImportRow }[]> {
  const parsed = parseOpeningRows(data.rows);
  if (parsed.errors.length > 0) {
    throw new MutationError("invalid", parsed.errors.slice(0, 3).join(". "), {
      rows: parsed.errors[0]!,
    });
  }
  if (parsed.rows.length === 0) {
    throw new MutationError("invalid", "Paste at least one row.", { rows: "Paste the rows" });
  }
  const ids = parsed.rows.map((r) => r.staffId);
  if (new Set(ids).size !== ids.length) {
    throw new MutationError("invalid", "Each staff ID appears once in an import.", {
      rows: "Each staff ID appears once",
    });
  }
  const found = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: workers, error } = await ctx.supabase
      .from("workers")
      .select("id, staff_id")
      .eq("organisation_id", ctx.organisationId)
      .in("staff_id", ids.slice(i, i + 200));
    if (error) throw new Error(`Could not read the workers (${error.code})`);
    for (const w of workers ?? []) found.set(w.staff_id, w.id);
  }
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const message = `No worker has staff ID ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}.`;
    throw new MutationError("invalid", message, { rows: message });
  }
  return parsed.rows.map((row) => ({ workerId: found.get(row.staffId)!, row }));
}

export async function previewImportOpening(
  ctx: Ctx,
  data: z.output<typeof importOpeningSchema>,
): Promise<CapabilityPreview> {
  const mapped = await mapImportRows(ctx, data);
  const existing = new Set<string>();
  const workerIds = mapped.map((m) => m.workerId);
  for (let i = 0; i < workerIds.length; i += 200) {
    const { data: rows, error } = await ctx.supabase
      .from("payroll_opening_balances")
      .select("worker_id")
      .eq("organisation_id", ctx.organisationId)
      .eq("tax_year", data.taxYear)
      .in("worker_id", workerIds.slice(i, i + 200));
    if (error) throw new Error(`Could not read opening balances (${error.code})`);
    for (const r of rows ?? []) existing.add(r.worker_id);
  }
  const sum = (pick: (r: ImportRow) => Kobo) => mapped.reduce((n, m) => n + pick(m.row), 0n);
  const corrected = mapped.filter((m) => existing.has(m.workerId)).length;
  return {
    summary: `Imports ${mapped.length} ${mapped.length === 1 ? "opening balance" : "opening balances"} for ${data.taxYear} to ${monthLabel(data.asOfMonth)}${corrected > 0 ? `, ${corrected} correcting one already on file` : ""}: PAYE ${money(sum((r) => r.paye))} withheld in all. Earlier rows are kept.`,
    changes: [
      { label: "Workers", after: String(mapped.length) },
      { label: "Gross pay to date", after: money(sum((r) => r.gross)) },
      { label: "Chargeable pay to date", after: money(sum((r) => r.chargeable)) },
      { label: "PAYE withheld to date", after: money(sum((r) => r.paye)) },
      { label: "Pension to date", after: money(sum((r) => r.pension)) },
    ],
  };
}

export async function previewDeclareRelief(
  ctx: Ctx,
  data: z.output<typeof declareReliefSchema>,
): Promise<CapabilityPreview> {
  const [name, records] = await Promise.all([
    workerName(ctx.supabase, ctx.organisationId, data.workerId),
    loadWorkerTaxRecords(ctx.supabase, ctx.organisationId, data.workerId, data.taxYear),
  ]);
  const before = records.reliefs.find((r) => r.kind === data.kind) ?? null;
  if ((before?.id ?? null) !== data.supersedesId) {
    throw new MutationError(
      "invalid",
      "This relief is already declared for the year. Correct the one in force.",
    );
  }
  const what = RELIEF_LABELS[data.kind];
  return {
    summary: `${before ? "Corrects" : "Declares"} ${name}'s ${what.toLowerCase()} for ${data.taxYear}: ${money(data.amount)} a year. It counts only once its proof is uploaded and verified${before?.status === "verified" ? "; the verified one it replaces stops counting" : ""}.`,
    changes: [
      {
        label: data.kind === "rent" ? "Annual rent" : "Yearly amount",
        ...(before ? { before: money(before.annualKobo) } : {}),
        after: money(data.amount),
      },
      { label: "Counts in PAYE", after: "After its proof is verified" },
    ],
  };
}

export async function previewVerifyRelief(
  ctx: Ctx,
  data: z.output<typeof verifyReliefSchema>,
): Promise<CapabilityPreview> {
  const d = await readDeclaration(ctx.supabase, ctx.organisationId, data.declarationId);
  const name = await workerName(ctx.supabase, ctx.organisationId, d.workerId);
  const what = RELIEF_LABELS[d.kind].toLowerCase();
  return {
    summary:
      data.decision === "verified"
        ? `Verifies ${name}'s ${what} of ${money(d.annualKobo)} for ${d.taxYear}. PAYE counts it from the next calculation of a run paid in ${d.taxYear}.`
        : `Rejects ${name}'s ${what} proof for ${d.taxYear}. PAYE stops counting it from the next calculation.`,
    changes: [
      { label: "Relief", after: `${RELIEF_LABELS[d.kind]}, ${money(d.annualKobo)} a year` },
      { label: "Status", after: data.decision === "verified" ? "Verified" : "Rejected" },
    ],
  };
}

export async function previewItfFlag(
  ctx: Ctx,
  data: z.output<typeof itfFlagSchema>,
): Promise<CapabilityPreview> {
  const { data: org, error } = await ctx.supabase
    .from("organisations")
    .select("itf_turnover_over_50m")
    .eq("id", ctx.organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the company (${error.code})`);
  const before = org?.itf_turnover_over_50m === true;
  return {
    summary: data.value
      ? "Says the company's turnover is ₦50 million or more, so ITF applies to runs calculated from now on whatever the headcount."
      : "Says the company's turnover is under ₦50 million, so ITF applies only with 5 or more employees on the pay date, from the next calculation.",
    changes: [
      {
        label: "Turnover ₦50 million or more",
        before: before ? "Yes" : "No",
        after: data.value ? "Yes" : "No",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const recordOpeningSpec: MutationSpec<typeof openingBalanceSchema, { id: string }> = {
  module: "payroll",
  schema: openingBalanceSchema,
  roles: TAX_RECORD_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("record_payroll_opening_balance", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_tax_year: data.taxYear,
      p_as_of_month: data.asOfMonth,
      // Whole kobo as text: no number ever holds kobo.
      p_gross_kobo: data.gross.toString(),
      p_chargeable_kobo: data.chargeable.toString(),
      p_paye_kobo: data.paye.toString(),
      p_pension_kobo: data.pension.toString(),
      p_reason: data.reason,
      ...(data.supersedesId ? { p_supersedes_id: data.supersedesId } : {}),
    });
    if (error) fromTaxRecordsDbError(error);
    return { id: id! };
  },
};

export const importOpeningSpec: MutationSpec<typeof importOpeningSchema, { count: number }> = {
  module: "payroll",
  schema: importOpeningSchema,
  roles: TAX_RECORD_WRITERS,
  run: async (ctx) => {
    const mapped = await mapImportRows(ctx, ctx.data);
    const { data: count, error } = await ctx.supabase.rpc("import_payroll_opening_balances", {
      p_organisation_id: ctx.organisationId,
      p_tax_year: ctx.data.taxYear,
      p_as_of_month: ctx.data.asOfMonth,
      p_rows: mapped.map((m) => ({
        worker_id: m.workerId,
        gross_kobo: m.row.gross.toString(),
        chargeable_kobo: m.row.chargeable.toString(),
        paye_kobo: m.row.paye.toString(),
        pension_kobo: m.row.pension.toString(),
      })),
      p_reason: ctx.data.reason,
    });
    if (error) fromTaxRecordsDbError(error);
    return { count: count ?? mapped.length };
  },
};

export const declareReliefSpec: MutationSpec<typeof declareReliefSchema, { id: string }> = {
  module: "payroll",
  schema: declareReliefSchema,
  roles: TAX_RECORD_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("declare_payroll_relief", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_tax_year: data.taxYear,
      p_kind: data.kind,
      p_annual_kobo: data.amount.toString(),
      p_reason: data.reason,
      ...(data.supersedesId ? { p_supersedes_id: data.supersedesId } : {}),
    });
    if (error) fromTaxRecordsDbError(error);
    return { id: id! };
  },
};

export interface StartedProof {
  proofId: string;
  path: string;
  token: string;
  fileExt: ReceiptExt;
  contentType: string;
}

/**
 * Step 1 of adding a proof: where the browser uploads the file. A signed upload token for one path
 * in the private bucket, made with the secret key after an RLS-checked read of the declaration.
 * Changes no row.
 */
export const startProofSpec: MutationSpec<typeof startProofSchema, StartedProof> = {
  module: "payroll",
  schema: startProofSchema,
  roles: TAX_RECORD_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const d = await readDeclaration(supabase, organisationId, data.declarationId);
    const fileExt = receiptExtensionOf(data.fileName) as ReceiptExt;
    const proofId = randomUUID();
    const path = `${organisationId}/${d.workerId}/${d.id}/${proofId}.${fileExt}`;
    const { data: signed, error } = await createAdminSupabase()
      .storage.from(RELIEF_PROOFS_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !signed) throw new Error("Could not prepare the proof upload");
    return { proofId, path, token: signed.token, fileExt, contentType: RECEIPT_TYPES[fileExt].mime };
  },
};

/** Deletes a refused upload. A failure is left in the private bucket, logged by error name only. */
async function deleteRefusedProof(path: string): Promise<void> {
  try {
    const { error } = await createAdminSupabase().storage.from(RELIEF_PROOFS_BUCKET).remove([path]);
    if (error) throw error;
  } catch (cause) {
    console.error(
      "relief_proofs.cleanup_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
  }
}

/**
 * Step 2: the file is in the bucket. Check its bytes and record it with the secret key, naming the
 * user `mutate()` verified.
 */
export const recordProofSpec: MutationSpec<typeof recordProofSchema, { proofId: string }> = {
  module: "payroll",
  schema: recordProofSchema,
  roles: TAX_RECORD_WRITERS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const d = await readDeclaration(supabase, organisationId, data.declarationId);
    const path = `${organisationId}/${d.workerId}/${d.id}/${data.proofId}.${data.fileExt}`;
    const admin = createAdminSupabase();
    const download = await admin.storage.from(RELIEF_PROOFS_BUCKET).download(path);
    if (download.error || !download.data) {
      throw new MutationError("invalid", "The file didn't arrive. Choose it again.");
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const check = checkUploadedReceipt(bytes, data.fileExt);
    if (!check.ok) {
      await deleteRefusedProof(path);
      throw new MutationError("invalid", check.message);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { error } = await admin.rpc("record_payroll_relief_proof", {
      p_organisation_id: organisationId,
      p_declaration_id: d.id,
      p_proof_id: data.proofId,
      p_actor: userId,
      p_document_kind: data.documentKind,
      p_file_ext: data.fileExt,
      p_size_bytes: bytes.length,
      p_sha256: sha256,
    });
    if (error) {
      if (error.code === "22023") await deleteRefusedProof(path);
      fromTaxRecordsDbError(error);
    }
    return { proofId: data.proofId };
  },
};

export const verifyReliefSpec: MutationSpec<typeof verifyReliefSchema, { id: string }> = {
  module: "payroll",
  schema: verifyReliefSchema,
  roles: TAX_RECORD_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("verify_payroll_relief", {
      p_organisation_id: organisationId,
      p_declaration_id: data.declarationId,
      p_decision: data.decision,
      ...(data.note ? { p_note: data.note } : {}),
    });
    if (error) fromTaxRecordsDbError(error);
    return { id: id! };
  },
};

export interface ProofLink {
  url: string;
  fileName: string;
}

/** A 60-second link to a proof file, after an RLS-checked read of its row. Audited. */
export const proofLinkSpec: MutationSpec<typeof proofLinkSchema, ProofLink> = {
  module: "payroll",
  schema: proofLinkSchema,
  roles: TAX_RECORD_READERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: proof, error } = await supabase
      .from("payroll_relief_proofs")
      .select("storage_path, file_ext, document_kind")
      .eq("organisation_id", organisationId)
      .eq("id", data.proofId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the proof (${error.code})`);
    if (!proof) throw new MutationError("invalid", "That file wasn't found. Reload the page.");
    const { data: signed, error: signError } = await createAdminSupabase()
      .storage.from(RELIEF_PROOFS_BUCKET)
      .createSignedUrl(proof.storage_path, PAYROLL_LINK_SECONDS);
    if (signError || !signed?.signedUrl) throw new Error("Could not make the file's link");
    return { url: signed.signedUrl, fileName: `${proof.document_kind}.${proof.file_ext}` };
  },
  event: ({ data }) => ({
    action: "payroll.relief_proof_opened",
    entity: "payroll_relief_proofs",
    entityId: data.proofId,
  }),
};

export const nhfNumberSpec: MutationSpec<typeof nhfNumberSchema, { id: string }> = {
  module: "payroll",
  schema: nhfNumberSchema,
  roles: TAX_RECORD_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("set_payroll_nhf_number", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_nhf_number: data.nhfNumber === "" ? null : data.nhfNumber,
      p_reason: data.reason,
    });
    if (error) fromTaxRecordsDbError(error);
    return { id: id! };
  },
};

export const itfFlagSpec: MutationSpec<typeof itfFlagSchema, null> = {
  module: "payroll",
  schema: itfFlagSchema,
  roles: TAX_RECORD_WRITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("set_itf_turnover_flag", {
      p_organisation_id: organisationId,
      p_value: data.value,
      p_reason: data.reason,
    });
    if (error) fromTaxRecordsDbError(error);
    return null;
  },
};
