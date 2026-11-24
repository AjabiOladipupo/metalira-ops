import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatDateTime } from "@/lib/dates";
import { formatNaira, toKobo, type Kobo } from "@/lib/money";
import { formulaRefusal, nameList, type LeftOutReason } from "@/lib/payroll/payout";
import { runMonth } from "@/lib/payroll/run-format";
import {
  summariseSupplement,
  supplementItemsPayloadShape,
  supplementRefusal,
  WAITING_LABEL,
  type SupplementRow,
} from "@/lib/payroll/supplement";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database, Json } from "@/types/db";

import { BANK_FORMAT_IDS, bankFormat } from "./bank-formats";
import { PAYROLL_FILES_BUCKET, sweepPayrollFiles } from "./payout-sweep";
import { BANK_FILE_URL_SECONDS, decryptForFile, PAYOUT_MAKERS } from "./payouts";
import { loadRun, type PayrollRunRow } from "./run-data";

/**
 * Supplementary payout files (slice 5.7c, carried from 5.4): a bank file for the workers a
 * released run's file left out, once their bank details are in force. 5.4's whole safety model:
 *
 * 1. The plan (`payout_supplement_plan`) is read as the signed-in user first (owner or finance;
 *    no ciphertext), before anything is read with the secret key or decrypted.
 * 2. The secret-key read gets the encrypted numbers; each ready worker's number is decrypted here
 *    in memory only and its last 4 digits checked (by name on a mismatch). The numbers go into the
 *    file's bytes and nowhere else: never logged, never in an error, never stored, never returned.
 * 3. The file is rendered by its format, hashed (SHA-256) and stored with the secret key in the
 *    private `payroll-files` bucket at {organisation_id}/{run_id}/supplementary/{id}.csv.
 * 4. `make_payout_supplement`, as the user, checks the stored object and the items against the
 *    outstanding rows ready now, records the file and its control totals, and voids the current
 *    unconfirmed one (a reason; the not-uploaded statement when it was downloaded). A refusal
 *    deletes the stored object.
 * 5. Downloads (`payout_supplement_download`, audited with the file id only) open by 60-second
 *    signed URLs; a confirmed file needs a reason.
 * 6. "I uploaded it to the bank" (`confirm_payout_supplement`) names the file by id and SHA-256,
 *    never by whoever made it or prepared the run, and only after a download.
 *
 * Errors carry error names and codes only; nothing here logs a number, a path or a URL.
 */

type Client = SupabaseClient<Database>;

const reload = "Reload the page and try again";
const reasonMessage = "Say why in up to 500 characters, with no web addresses or account numbers";

const optionalReason = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .refine(
      (v) =>
        v.length <= max &&
        !/[\u0001-\u001f\u007f-\u009f<>]/.test(v) &&
        !/(:\/\/|www\.)/i.test(v) &&
        v.replace(/\D/g, "").length < 10,
      reasonMessage,
    )
    .transform((v) => (v === "" ? null : v));

const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");

export const makeSupplementSchema = z.object({
  runId: z.uuid(reload),
  format: z.enum(BANK_FORMAT_IDS, "Choose a bank file format"),
  voidReason: optionalReason(420),
  notUploaded: checkbox,
});

export const supplementIdSchema = z.object({
  supplementId: z.uuid(reload),
  reason: optionalReason(500),
});

export const confirmSupplementSchema = z.object({
  runId: z.uuid(reload),
  supplementId: z.uuid(reload),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/, reload),
});

export const SUPPLEMENT_MAKER_MESSAGE =
  "You made this supplementary file, so a different person must confirm it went to the bank.";
export const SUPPLEMENT_TWO_PERSON_MESSAGE =
  "You prepared or changed this run, so a different person must confirm its supplementary file. Ask Finance or another owner.";

/** Database refusals in plain English. Messages carry names, never numbers. */
export function fromSupplementDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "MLAR8") throw new MutationError("invalid", SUPPLEMENT_MAKER_MESSAGE);
  if (error.code === "MLAR9") throw new MutationError("invalid", SUPPLEMENT_TWO_PERSON_MESSAGE);
  if (error.code === "42501") {
    throw new MutationError(
      "forbidden",
      "Only Finance or an owner makes, downloads or confirms a supplementary bank file.",
    );
  }
  if (error.code === "P0002") throw new MutationError("invalid", `${error.message} Reload the page.`);
  if (/^MLAR[2-7AB]$/.test(error.code) || error.code === "22023") {
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
  original_item_id: string;
  left_out_reason: string | null;
  net_kobo: string;
  bank_name: string | null;
  bank_code: string | null;
  account_name: string | null;
  bank_account_last4: string | null;
  bank_detail_change_id: string | null;
  bank_account_enc: string | null;
  on_file: boolean;
  in_hold: boolean;
  ready: boolean;
}

/** The outstanding items of a released run: the user's client (no ciphertext) or the secret key's. */
export async function loadSupplementPlan(
  client: Client,
  organisationId: string,
  runId: string,
  withCiphertext = false,
): Promise<{ rows: SupplementRow[]; ciphertext: Map<string, string> }> {
  const { data, error } = await client.rpc("payout_supplement_plan", {
    p_organisation_id: organisationId,
    p_run_id: runId,
    p_with_ciphertext: withCiphertext,
  });
  if (error) fromSupplementDbError(error);
  const rows: SupplementRow[] = [];
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
      acknowledgedCode: null,
      originalItemId: r.original_item_id,
      leftOutReason: r.left_out_reason as LeftOutReason | null,
      ready: r.ready,
    });
    if (withCiphertext && r.bank_account_enc) ciphertext.set(r.payslip_id, r.bank_account_enc);
  }
  return { rows, ciphertext };
}

export interface SupplementFile {
  id: string;
  status: "active" | "confirmed" | "voided";
  bankFormat: string;
  fileSha256: string;
  itemCount: number;
  totalKobo: Kobo;
  madeBy: string;
  createdAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface SupplementItem {
  id: string;
  supplementId: string;
  payslipId: string;
  workerId: string;
  position: number;
  status: "pending" | "voided";
  bankName: string;
  bankCode: string;
  accountName: string;
  bankAccountLast4: string;
  amountKobo: Kobo;
}

export interface SupplementDownload {
  supplementId: string;
  actorId: string | null;
  downloadedAt: string;
}

export interface SupplementDetail {
  files: SupplementFile[];
  active: SupplementFile | null;
  items: SupplementItem[];
  downloads: SupplementDownload[];
}

/** The run's supplementary files, their items and downloads (owner, hr, finance; RLS). */
export async function loadSupplements(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<SupplementDetail> {
  const { data, error } = await supabase
    .from("payout_supplements")
    .select(
      "id, status, bank_format, file_sha256, item_count, total_kobo::text, made_by, created_at, confirmed_by, confirmed_at, voided_by, voided_at, void_reason",
    )
    .eq("organisation_id", organisationId)
    .eq("run_id", runId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not read the supplementary files (${error.code})`);
  const files: SupplementFile[] = (
    (data ?? []) as unknown as {
      id: string;
      status: string;
      bank_format: string;
      file_sha256: string;
      item_count: number;
      total_kobo: string;
      made_by: string;
      created_at: string;
      confirmed_by: string | null;
      confirmed_at: string | null;
      voided_by: string | null;
      voided_at: string | null;
      void_reason: string | null;
    }[]
  ).map((s) => ({
    id: s.id,
    status: s.status as SupplementFile["status"],
    bankFormat: s.bank_format,
    fileSha256: s.file_sha256,
    itemCount: s.item_count,
    totalKobo: toKobo(s.total_kobo),
    madeBy: s.made_by,
    createdAt: s.created_at,
    confirmedBy: s.confirmed_by,
    confirmedAt: s.confirmed_at,
    voidedBy: s.voided_by,
    voidedAt: s.voided_at,
    voidReason: s.void_reason,
  }));
  let items: SupplementItem[] = [];
  if (files.length > 0) {
    const { data: itemData, error: itemError } = await supabase
      .from("payout_supplement_items")
      .select(
        "id, supplement_id, payslip_id, worker_id, position, status, bank_name, bank_code, account_name, bank_account_last4, amount_kobo::text",
      )
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .order("position")
      .limit(5000);
    if (itemError) throw new Error(`Could not read the supplementary items (${itemError.code})`);
    items = (
      (itemData ?? []) as unknown as {
        id: string;
        supplement_id: string;
        payslip_id: string;
        worker_id: string;
        position: number;
        status: string;
        bank_name: string;
        bank_code: string;
        account_name: string;
        bank_account_last4: string;
        amount_kobo: string;
      }[]
    ).map((i) => ({
      id: i.id,
      supplementId: i.supplement_id,
      payslipId: i.payslip_id,
      workerId: i.worker_id,
      position: i.position,
      status: i.status === "voided" ? "voided" : "pending",
      bankName: i.bank_name,
      bankCode: i.bank_code,
      accountName: i.account_name,
      bankAccountLast4: i.bank_account_last4,
      amountKobo: toKobo(i.amount_kobo),
    }));
  }
  let downloads: SupplementDownload[] = [];
  if (files.length > 0) {
    const { data: d, error: dError } = await supabase.rpc("payout_supplement_downloads", {
      p_organisation_id: organisationId,
      p_run_id: runId,
    });
    if (dError) fromSupplementDbError(dError);
    downloads = (d ?? []).map((x) => ({
      supplementId: x.supplement_id,
      actorId: x.actor_id,
      downloadedAt: x.downloaded_at,
    }));
  }
  return { files, active: files.find((f) => f.status === "active") ?? null, items, downloads };
}

/** The run, released, or a refusal the person can act on. */
async function releasedRun(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<PayrollRunRow> {
  const run = await loadRun(supabase, organisationId, runId);
  if (!run) throw new MutationError("invalid", "That payroll run wasn't found. Reload the page.");
  if (run.status !== "released") {
    throw new MutationError("invalid", "A supplementary file is made once the run is released.");
  }
  return run;
}

async function personName(supabase: Client, userId: string | null): Promise<string> {
  if (!userId) return "a manager";
  const { data } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.full_name || "a manager";
}

// ---------------------------------------------------------------------------
// Make
// ---------------------------------------------------------------------------

const money = (k: Kobo) => formatNaira(k, { whole: true });
const workers = (n: number) => `${n} ${n === 1 ? "worker" : "workers"}`;

const NOT_UPLOADED =
  "Tick that the current supplementary file was not uploaded to the bank, or two files may be paid. If it was uploaded, don't replace it: confirm it instead.";

/** A reason to replace the current file and, when it was downloaded, the not-uploaded statement. */
async function replacementCheck(
  supabase: Client,
  organisationId: string,
  runId: string,
  data: z.output<typeof makeSupplementSchema>,
): Promise<{ active: SupplementFile | null; downloadedNote: string | null }> {
  const detail = await loadSupplements(supabase, organisationId, runId);
  const active = detail.active;
  if (!active) return { active, downloadedNote: null };
  if (!data.voidReason) {
    throw new MutationError(
      "invalid",
      "This run already has a supplementary file waiting. Say why it is replaced.",
      { voidReason: "Say why the current file is replaced" },
    );
  }
  const download = detail.downloads.find((d) => d.supplementId === active.id) ?? null;
  if (!download) return { active, downloadedNote: null };
  const note = `The current supplementary file was downloaded by ${await personName(supabase, download.actorId)} at ${formatDateTime(download.downloadedAt)}.`;
  if (!data.notUploaded) {
    throw new MutationError("invalid", `${note} ${NOT_UPLOADED}`, { notUploaded: NOT_UPLOADED });
  }
  return { active, downloadedNote: note };
}

/** "Make a supplementary file": who it pays, the total and who still waits (as the user). */
export async function previewMakeSupplement(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof makeSupplementSchema>,
): Promise<CapabilityPreview> {
  const run = await releasedRun(ctx.supabase, ctx.organisationId, data.runId);
  const { active, downloadedNote } = await replacementCheck(
    ctx.supabase,
    ctx.organisationId,
    run.id,
    data,
  );
  const { rows } = await loadSupplementPlan(ctx.supabase, ctx.organisationId, run.id);
  const summary = summariseSupplement(rows);
  const refusal = supplementRefusal(summary) ?? formulaRefusal(summary.ready);
  if (refusal) throw new MutationError("invalid", refusal);
  const format = bankFormat(data.format);
  let text = `Makes a supplementary ${runMonth(run.periodEnd)} bank file (${format?.label ?? data.format}): ${workers(summary.ready.length)}, ${money(summary.readyKobo)}, each their net pay left out of the run's file.`;
  if (summary.waiting.length > 0) {
    text += ` ${workers(summary.waiting.length)} still ${summary.waiting.length === 1 ? "waits" : "wait"} for bank details.`;
  }
  if (active) {
    text += ` Replaces the current supplementary file (${workers(active.itemCount)}, ${money(active.totalKobo)}), which is voided: "${data.voidReason}".`;
    if (downloadedNote) text += ` ${downloadedNote} You confirm it was not uploaded to the bank.`;
  }
  text +=
    " Each account number is checked against its last 4 digits as the file is made. Nothing is paid until the company uploads the file to its own bank.";
  return {
    summary: text,
    changes: [
      { label: "Workers in the file", after: String(summary.ready.length) },
      { label: "Total", after: money(summary.readyKobo) },
      { label: "Still waiting", after: String(summary.waiting.length) },
      ...summary.waiting.map(({ row, reason }) => ({
        label: `Waiting: ${row.workerName}`,
        after: WAITING_LABEL[reason],
      })),
    ],
  };
}

export interface MadeSupplement {
  runId: string;
  supplementId: string;
  itemCount: number;
  totalKobo: string;
  sha256: string;
}

function samePlan(a: readonly SupplementRow[], b: readonly SupplementRow[]): boolean {
  const key = (r: SupplementRow) =>
    [
      r.payslipId,
      r.netKobo.toString(),
      r.bankDetailChangeId ?? "",
      r.bankAccountLast4 ?? "",
      r.bankCode ?? "",
      r.ready ? "1" : "0",
    ].join("|");
  return a.length === b.length && a.map(key).join(",") === b.map(key).join(",");
}

/** What `make_payout_supplement` receives: positions and details, never a number. */
export function supplementItemsPayload(ready: readonly SupplementRow[]): Json {
  return supplementItemsPayloadShape(ready) as unknown as Json;
}

async function removeStored(admin: Client, path: string): Promise<void> {
  try {
    const { error } = await admin.storage.from(PAYROLL_FILES_BUCKET).remove([path]);
    if (error) throw error;
  } catch (cause) {
    console.error(
      "payroll.supplementary_file_cleanup_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
  }
}

const REFUSAL_CODE = /^(MLAR[0-9A-Z]|22023|42501|P0002)$/;

/** After a failed record: a real refusal deletes the file; otherwise only once it isn't recorded. */
async function cleanUpAfterFailure(
  admin: Client,
  error: Pick<PostgrestError, "code">,
  organisationId: string,
  supplementId: string,
  path: string,
): Promise<void> {
  if (REFUSAL_CODE.test(error.code ?? "")) {
    await removeStored(admin, path);
    return;
  }
  const { data, error: readError } = await admin
    .from("payout_supplements")
    .select("id")
    .eq("organisation_id", organisationId)
    .eq("id", supplementId)
    .maybeSingle();
  if (!readError && !data) await removeStored(admin, path);
}

/** Makes, stores and records a supplementary file (owner or finance). */
export const makeSupplementSpec: MutationSpec<typeof makeSupplementSchema, MadeSupplement> = {
  module: "payroll",
  schema: makeSupplementSchema,
  roles: PAYOUT_MAKERS,
  run: async ({ supabase, organisationId, data }) => {
    const run = await releasedRun(supabase, organisationId, data.runId);
    await replacementCheck(supabase, organisationId, run.id, data);
    const format = bankFormat(data.format);
    if (!format) throw new MutationError("invalid", "Choose a bank file format.");

    // The signed-in user's own read first, before anything is read with the secret key.
    const mine = await loadSupplementPlan(supabase, organisationId, run.id, false);
    const mineSummary = summariseSupplement(mine.rows);
    const refusal = supplementRefusal(mineSummary) ?? formulaRefusal(mineSummary.ready);
    if (refusal) throw new MutationError("invalid", refusal);

    const admin = createAdminSupabase();
    const plan = await loadSupplementPlan(admin, organisationId, run.id, true);
    if (!samePlan(mine.rows, plan.rows)) {
      plan.ciphertext.clear();
      throw new MutationError("invalid", "Bank details changed while the file was being made. Try again.");
    }
    const summary = summariseSupplement(plan.rows);
    const decrypted = decryptForFile(organisationId, summary.ready, plan.ciphertext, run.periodEnd);
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
    const size = bytes.byteLength;
    const supplementId = randomUUID();
    const path = `${organisationId}/${run.id}/supplementary/${supplementId}.${format.extension}`;

    const stored = await admin.storage
      .from(PAYROLL_FILES_BUCKET)
      .upload(path, bytes, { contentType: format.contentType, upsert: false });
    bytes.fill(0);
    if (stored.error) throw new Error(`Could not store the supplementary file (${stored.error.name})`);

    const { data: made, error } = await supabase.rpc("make_payout_supplement", {
      p_organisation_id: organisationId,
      p_run_id: run.id,
      p_supplement_id: supplementId,
      p_bank_format: format.id,
      p_file_sha256: sha256,
      p_file_bytes: size,
      p_items: supplementItemsPayload(summary.ready),
      ...(data.voidReason ? { p_void_reason: data.voidReason } : {}),
      p_not_uploaded: data.notUploaded,
    });
    if (error) {
      await cleanUpAfterFailure(admin, error, organisationId, supplementId, path);
      fromSupplementDbError(error);
    }
    await sweepPayrollFiles(admin, organisationId).catch((e: unknown) =>
      console.error("payroll.bank_file_sweep_failed:", e instanceof Error ? e.name : "unknown"),
    );
    const result = (made ?? {}) as { item_count?: number; total_kobo?: string };
    return {
      runId: run.id,
      supplementId,
      itemCount: result.item_count ?? summary.ready.length,
      totalKobo: result.total_kobo ?? summary.readyKobo.toString(),
      sha256,
    };
  },
};

/** Opens a supplementary file for 60 seconds (owner or finance); the database audits it. */
export const downloadSupplementSpec: MutationSpec<typeof supplementIdSchema, { url: string }> = {
  module: "payroll",
  schema: supplementIdSchema,
  roles: PAYOUT_MAKERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: path, error } = await supabase.rpc("payout_supplement_download", {
      p_organisation_id: organisationId,
      p_supplement_id: data.supplementId,
      ...(data.reason ? { p_reason: data.reason } : {}),
    });
    if (error) fromSupplementDbError(error);
    const { data: signed, error: signError } = await createAdminSupabase()
      .storage.from(PAYROLL_FILES_BUCKET)
      .createSignedUrl(path!, BANK_FILE_URL_SECONDS, {
        download: `supplementary-file-${data.supplementId.slice(0, 8)}.csv`,
      });
    if (signError || !signed?.signedUrl) {
      throw new Error(`Could not open the supplementary file (${signError?.name ?? "no link"})`);
    }
    return { url: signed.signedUrl };
  },
};

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/** "I uploaded it to the bank": the file's control totals; refuses what the database will. */
export async function previewConfirmSupplement(
  ctx: Pick<MutationContext, "supabase" | "organisationId" | "userId">,
  data: z.output<typeof confirmSupplementSchema>,
): Promise<CapabilityPreview> {
  const run = await releasedRun(ctx.supabase, ctx.organisationId, data.runId);
  if ([run.preparedBy, run.submittedBy, run.calculatedBy].includes(ctx.userId)) {
    throw new MutationError("invalid", SUPPLEMENT_TWO_PERSON_MESSAGE);
  }
  const detail = await loadSupplements(ctx.supabase, ctx.organisationId, run.id);
  const file = detail.active;
  if (!file || file.id !== data.supplementId || file.fileSha256 !== data.fileSha256) {
    throw new MutationError(
      "invalid",
      "The supplementary file changed since you looked. Reload the page, check the control totals and confirm again.",
    );
  }
  if (file.madeBy === ctx.userId) throw new MutationError("invalid", SUPPLEMENT_MAKER_MESSAGE);
  if (!detail.downloads.some((d) => d.supplementId === file.id)) {
    throw new MutationError(
      "invalid",
      "Nobody has downloaded this supplementary file yet. Download it and upload it to the bank first.",
    );
  }
  return {
    summary: `You confirm the supplementary ${runMonth(run.periodEnd)} bank file (${workers(file.itemCount)}, ${money(file.totalKobo)}, SHA-256 ${file.fileSha256.slice(0, 12)}…) was uploaded to the company's bank. Those workers are then paid and no longer outstanding. This can't be undone.`,
    changes: [
      { label: "Status", before: "Waiting", after: "Uploaded to the bank" },
      { label: "Workers in the file", after: String(file.itemCount) },
      { label: "Total", after: money(file.totalKobo) },
    ],
  };
}

export const confirmSupplementSpec: MutationSpec<
  typeof confirmSupplementSchema,
  { runId: string; supplementId: string }
> = {
  module: "payroll",
  schema: confirmSupplementSchema,
  roles: PAYOUT_MAKERS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("confirm_payout_supplement", {
      p_organisation_id: organisationId,
      p_supplement_id: data.supplementId,
      p_file_sha256: data.fileSha256,
    });
    if (error) fromSupplementDbError(error);
    return { runId: data.runId, supplementId: data.supplementId };
  },
};
