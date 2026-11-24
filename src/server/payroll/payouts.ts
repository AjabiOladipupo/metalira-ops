import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatNaira, toKobo, type Kobo } from "@/lib/money";
import {
  LEFT_OUT_LABEL,
  nameList,
  planRefusal,
  summarisePlan,
  type PayoutPlanRow,
} from "@/lib/payroll/payout";
import { runMonth } from "@/lib/payroll/run-format";
import type { ManagerRole } from "@/lib/roles";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { decryptPii, PiiDecryptError, PiiKeyError } from "@/server/crypto/pii";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database, Json } from "@/types/db";

import { BANK_FORMAT_IDS, bankFormat, salaryNarration, type BankFileItem } from "./bank-formats";
import { loadRun, type PayrollRunRow } from "./run-data";

/**
 * The bank file (slice 5.4, docs/PHASE_5.md 5.4, decisions 11 and 12; CLAUDE.md rules 6 and 9).
 *
 * Making a file (owner or finance):
 * 1. The plan: each payslip of the approved run with the bank details in force now
 *    (`payout_plan`), as the signed-in user for the preview (no ciphertext) and with the secret
 *    key for the file (the encrypted numbers). Who is paid, left out or refused follows
 *    src/lib/payroll/payout.ts; refusals name the workers.
 * 2. Each paid worker's account number is decrypted here, in memory only, and its last 4 digits
 *    compared with the stored ones (a mismatch, an unreadable number or one that isn't 10 digits
 *    refuses the file by name: MLBF1). The numbers go into the file's bytes and nowhere else:
 *    never logged, never in an error, never stored in a table, never returned.
 * 3. The file is rendered by its format (./bank-formats), hashed (SHA-256) and stored with the
 *    secret key in the private `payroll-files` bucket at {organisation_id}/{run_id}/{batch_id}.csv.
 * 4. `make_payout_batch`, as the user, checks the stored object, the items (no numbers) against
 *    the details in force and the rules again, records the batch and its control totals, and voids
 *    the previous batch with the reason. If it refuses, the stored object is deleted.
 *
 * Downloading: `payout_file_download` (as the user: owner or finance; audited with the batch id
 * only) gives the active file's path, and the server signs a 60-second URL for it. The URL is
 * never logged.
 *
 * Errors carry error names and codes only; nothing here logs a number, a path or a URL.
 */

type Client = SupabaseClient<Database>;

/** Owner and finance make, download and release the bank file (docs/PHASE_5.md "Roles and access"). */
export const PAYOUT_MAKERS = ["owner", "finance"] as const satisfies readonly ManagerRole[];

export function canMakeBankFile(role: ManagerRole): boolean {
  return (PAYOUT_MAKERS as readonly ManagerRole[]).includes(role);
}

export const PAYROLL_FILES_BUCKET = "payroll-files";
export const BANK_FILE_URL_SECONDS = 60;

const reload = "Reload the page and try again";
const reasonMessage = "Say why in up to 500 characters, with no web addresses or account numbers";

export const makeBankFileSchema = z.object({
  runId: z.uuid(reload),
  format: z.enum(BANK_FORMAT_IDS, "Choose a bank file format"),
  voidReason: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .refine(
      (v) =>
        v.length <= 500 &&
        !/[\u0001-\u001f\u007f-\u009f<>]/.test(v) &&
        !/(:\/\/|www\.)/i.test(v) &&
        !/\d{10}/.test(v),
      reasonMessage,
    )
    .transform((v) => (v === "" ? null : v)),
});

export const bankFileIdSchema = z.object({ batchId: z.uuid(reload) });

/** Rule 10 for release, as the person reads it. */
export const RELEASE_TWO_PERSON_MESSAGE =
  "You prepared or changed this run, so a different person must release it. Ask Finance or another owner.";

/** Database refusals in plain English. Messages carry names, never numbers. */
export function fromPayoutDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "MLBF8") throw new MutationError("invalid", RELEASE_TWO_PERSON_MESSAGE);
  if (error.code === "42501") {
    throw new MutationError(
      "forbidden",
      "Only Finance or an owner makes, downloads or releases the bank file.",
    );
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  }
  if (/^MLBF[2-79]$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code})`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface PlanRecord {
  payslip_id: string;
  worker_id: string;
  worker_name: string;
  staff_id: string;
  net_kobo: string;
  bank_name: string | null;
  bank_code: string | null;
  account_name: string | null;
  bank_account_last4: string | null;
  bank_detail_change_id: string | null;
  bank_account_enc: string | null;
  on_file: boolean;
  in_hold: boolean;
  acknowledged_code: string | null;
}

export interface PlanWithCiphertext {
  rows: PayoutPlanRow[];
  /** Encrypted account numbers by payslip id (secret-key reads only). */
  ciphertext: Map<string, string>;
}

/**
 * The run's plan: `client` is the signed-in user's (no ciphertext) or the secret-key client
 * (with it). Net pay arrives as text and becomes `bigint`.
 */
export async function loadPayoutPlan(
  client: Client,
  organisationId: string,
  runId: string,
  withCiphertext = false,
): Promise<PlanWithCiphertext> {
  const { data, error } = await client.rpc("payout_plan", {
    p_organisation_id: organisationId,
    p_run_id: runId,
    p_with_ciphertext: withCiphertext,
  });
  if (error) fromPayoutDbError(error);
  const rows: PayoutPlanRow[] = [];
  const ciphertext = new Map<string, string>();
  for (const r of (data ?? []) as unknown as PlanRecord[]) {
    rows.push({
      payslipId: r.payslip_id,
      workerId: r.worker_id,
      workerName: r.worker_name,
      staffId: r.staff_id,
      netKobo: toKobo(r.net_kobo),
      bankName: r.bank_name,
      bankCode: r.bank_code,
      accountName: r.account_name,
      bankAccountLast4: r.bank_account_last4,
      bankDetailChangeId: r.bank_detail_change_id,
      onFile: r.on_file,
      inHold: r.in_hold,
      acknowledgedCode: r.acknowledged_code,
    });
    if (withCiphertext && r.bank_account_enc) ciphertext.set(r.payslip_id, r.bank_account_enc);
  }
  return { rows, ciphertext };
}

export interface ActiveBatch {
  id: string;
  itemCount: number;
  totalKobo: Kobo;
  fileSha256: string;
}

export async function loadActiveBatch(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<ActiveBatch | null> {
  const { data, error } = await supabase
    .from("payout_batches")
    .select("id, item_count, total_kobo::text, file_sha256")
    .eq("organisation_id", organisationId)
    .eq("run_id", runId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`Could not read the bank file (${error.code})`);
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    item_count: number;
    total_kobo: string;
    file_sha256: string;
  };
  return {
    id: row.id,
    itemCount: row.item_count,
    totalKobo: toKobo(row.total_kobo),
    fileSha256: row.file_sha256,
  };
}

/** The run, approved and not released, or a refusal the person can act on. */
export async function approvedRun(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<PayrollRunRow> {
  const run = await loadRun(supabase, organisationId, runId);
  if (!run) throw new MutationError("invalid", "That payroll run wasn't found. Reload the page.");
  if (run.status === "released") {
    throw new MutationError(
      "invalid",
      "This run is released: its bank file went to the bank and stays.",
    );
  }
  if (run.status !== "approved") {
    throw new MutationError("invalid", "The bank file is made once the run is approved.");
  }
  return run;
}

// ---------------------------------------------------------------------------
// The file, in memory
// ---------------------------------------------------------------------------

const NUBAN = /^\d{10}$/;

export interface DecryptedItems {
  items: BankFileItem[];
  /** Workers whose number doesn't end in their stored last 4 digits, or isn't 10 digits. */
  mismatched: string[];
  /** Workers whose stored number fails its integrity check. */
  unreadable: string[];
}

/**
 * Decrypts each paid worker's account number (encrypted for workers.bank_account_enc of the
 * worker, as bank-detail changes are too) and checks it against the stored last 4 digits. The
 * numbers stay in the returned items only. A missing key throws by name (`PiiKeyError`).
 */
export function decryptForFile(
  organisationId: string,
  paid: readonly PayoutPlanRow[],
  ciphertext: ReadonlyMap<string, string>,
  periodEnd: string,
): DecryptedItems {
  const out: DecryptedItems = { items: [], mismatched: [], unreadable: [] };
  for (const row of paid) {
    const enc = ciphertext.get(row.payslipId);
    if (!enc) {
      out.unreadable.push(row.workerName);
      continue;
    }
    let digits: string;
    try {
      digits = decryptPii(enc, {
        organisationId,
        table: "workers",
        column: "bank_account_enc",
        rowId: row.workerId,
      }).replace(/\s+/g, "");
    } catch (error) {
      if (error instanceof PiiKeyError) throw new Error("PiiKeyError");
      if (error instanceof PiiDecryptError) {
        out.unreadable.push(row.workerName);
        continue;
      }
      throw new Error("Bank details could not be read");
    }
    if (!NUBAN.test(digits) || digits.slice(-4) !== row.bankAccountLast4) {
      out.mismatched.push(row.workerName);
      continue;
    }
    out.items.push({
      beneficiaryName: row.accountName ?? row.workerName,
      accountNumber: digits,
      bankCode: row.bankCode ?? "",
      bankName: row.bankName ?? "",
      amountKobo: row.netKobo,
      narration: salaryNarration(periodEnd, row.staffId),
    });
  }
  return out;
}

/** What `make_payout_batch` receives: positions and details, never a number. */
export function itemsPayload(
  paid: readonly PayoutPlanRow[],
  leftOut: readonly { row: PayoutPlanRow; reason: string }[],
): Json {
  return [
    ...paid.map((r, i) => ({
      payslip_id: r.payslipId,
      position: i + 1,
      status: "pending",
      left_out_reason: null,
      bank_name: r.bankName,
      bank_code: r.bankCode,
      account_name: r.accountName,
      bank_account_last4: r.bankAccountLast4,
      bank_detail_change_id: r.bankDetailChangeId,
      amount_kobo: r.netKobo.toString(),
    })),
    ...leftOut.map(({ row, reason }, i) => ({
      payslip_id: row.payslipId,
      position: paid.length + i + 1,
      status: "left_out",
      left_out_reason: reason,
      bank_name: null,
      bank_code: null,
      account_name: null,
      bank_account_last4: null,
      bank_detail_change_id: null,
      amount_kobo: "0",
    })),
  ] as Json;
}

/** Deletes a stored file the database refused. A failure is reported by error name only. */
async function removeStored(admin: Client, path: string): Promise<void> {
  try {
    const { error } = await admin.storage.from(PAYROLL_FILES_BUCKET).remove([path]);
    if (error) throw error;
  } catch (cause) {
    console.error(
      "payroll.bank_file_cleanup_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
  }
}

// ---------------------------------------------------------------------------
// Preview and specs
// ---------------------------------------------------------------------------

const money = (k: Kobo) => formatNaira(k, { whole: true });
const workers = (n: number) => `${n} ${n === 1 ? "worker" : "workers"}`;

/**
 * "Make file": who is paid, the total and who is left out, from the details in force now, as the
 * signed-in user (no ciphertext). Refuses as the file would: by name.
 */
export async function previewMakeBankFile(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof makeBankFileSchema>,
): Promise<CapabilityPreview> {
  const run = await approvedRun(ctx.supabase, ctx.organisationId, data.runId);
  const active = await loadActiveBatch(ctx.supabase, ctx.organisationId, run.id);
  if (active && !data.voidReason) {
    throw new MutationError(
      "invalid",
      "This run already has a bank file. Say why it is replaced.",
      { voidReason: "Say why the current file is replaced" },
    );
  }
  const { rows } = await loadPayoutPlan(ctx.supabase, ctx.organisationId, run.id);
  const summary = summarisePlan(rows);
  const refusal = planRefusal(summary);
  if (refusal) throw new MutationError("invalid", refusal);
  const format = bankFormat(data.format);
  let text = `Makes the ${runMonth(run.periodEnd)} bank file (${format?.label ?? data.format}): ${workers(summary.paid.length)}, ${money(summary.totalKobo)}; ${summary.leftOut.length} left out.`;
  if (active) {
    text += ` Replaces the current file (${workers(active.itemCount)}, ${money(active.totalKobo)}), which is voided: "${data.voidReason}".`;
  }
  text +=
    " Each account number is checked against its last 4 digits as the file is made. Nothing is paid until the company uploads the file to its own bank.";
  return {
    summary: text,
    changes: [
      { label: "Workers in the file", after: String(summary.paid.length) },
      { label: "Total", after: money(summary.totalKobo) },
      { label: "Left out", after: String(summary.leftOut.length) },
      ...summary.leftOut.map(({ row, reason }) => ({
        label: `Left out: ${row.workerName}`,
        after: LEFT_OUT_LABEL[reason],
      })),
    ],
  };
}

export interface MadeBankFile {
  runId: string;
  batchId: string;
  itemCount: number;
  totalKobo: string;
  leftOutCount: number;
  sha256: string;
}

/** Makes, stores and records the run's bank file (owner or finance). */
export const makeBankFileSpec: MutationSpec<typeof makeBankFileSchema, MadeBankFile> = {
  module: "payroll",
  schema: makeBankFileSchema,
  roles: PAYOUT_MAKERS,
  run: async ({ supabase, organisationId, data }) => {
    const run = await approvedRun(supabase, organisationId, data.runId);
    const active = await loadActiveBatch(supabase, organisationId, run.id);
    if (active && !data.voidReason) {
      throw new MutationError(
        "invalid",
        "This run already has a bank file. Say why it is replaced.",
        { voidReason: "Say why the current file is replaced" },
      );
    }
    const format = bankFormat(data.format);
    if (!format) throw new MutationError("invalid", "Choose a bank file format.");

    const admin = createAdminSupabase();
    const plan = await loadPayoutPlan(admin, organisationId, run.id, true);
    const summary = summarisePlan(plan.rows);
    const refusal = planRefusal(summary);
    if (refusal) throw new MutationError("invalid", refusal);

    const decrypted = decryptForFile(organisationId, summary.paid, plan.ciphertext, run.periodEnd);
    plan.ciphertext.clear();
    if (decrypted.mismatched.length > 0 || decrypted.unreadable.length > 0) {
      decrypted.items.length = 0;
      if (decrypted.mismatched.length > 0) {
        throw new MutationError(
          "invalid",
          `The account number on file for ${nameList(decrypted.mismatched)} doesn't match its last 4 digits. Check their bank details on their page, then make the file again.`,
        );
      }
      throw new MutationError(
        "invalid",
        `The bank details on file for ${nameList(decrypted.unreadable)} can't be read. Raise a bank-detail change for them, then make the file again.`,
      );
    }

    const bytes = format.render(decrypted.items);
    decrypted.items.length = 0;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const batchId = randomUUID();
    const path = `${organisationId}/${run.id}/${batchId}.${format.extension}`;

    const stored = await admin.storage
      .from(PAYROLL_FILES_BUCKET)
      .upload(path, bytes, { contentType: format.contentType, upsert: false });
    bytes.fill(0);
    if (stored.error) throw new Error(`Could not store the bank file (${stored.error.name})`);

    const { data: made, error } = await supabase.rpc("make_payout_batch", {
      p_organisation_id: organisationId,
      p_run_id: run.id,
      p_batch_id: batchId,
      p_bank_format: format.id,
      p_file_sha256: sha256,
      p_file_bytes: bytes.byteLength,
      p_items: itemsPayload(summary.paid, summary.leftOut),
      ...(data.voidReason ? { p_void_reason: data.voidReason } : {}),
    });
    if (error) {
      await removeStored(admin, path);
      fromPayoutDbError(error);
    }
    const result = (made ?? {}) as {
      item_count?: number;
      total_kobo?: string;
      left_out_count?: number;
    };
    return {
      runId: run.id,
      batchId,
      itemCount: result.item_count ?? summary.paid.length,
      totalKobo: result.total_kobo ?? summary.totalKobo.toString(),
      leftOutCount: result.left_out_count ?? summary.leftOut.length,
      sha256,
    };
  },
};

/** Opens the active file for 60 seconds (owner or finance); the database audits the download. */
export const downloadBankFileSpec: MutationSpec<typeof bankFileIdSchema, { url: string }> = {
  module: "payroll",
  schema: bankFileIdSchema,
  roles: PAYOUT_MAKERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: path, error } = await supabase.rpc("payout_file_download", {
      p_organisation_id: organisationId,
      p_batch_id: data.batchId,
    });
    if (error) fromPayoutDbError(error);
    const { data: signed, error: signError } = await createAdminSupabase()
      .storage.from(PAYROLL_FILES_BUCKET)
      .createSignedUrl(path!, BANK_FILE_URL_SECONDS, {
        download: `bank-file-${data.batchId.slice(0, 8)}.csv`,
      });
    if (signError || !signed?.signedUrl) {
      throw new Error(`Could not open the bank file (${signError?.name ?? "no link"})`);
    }
    return { url: signed.signedUrl };
  },
};
