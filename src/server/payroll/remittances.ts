import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatDate } from "@/lib/dates";
import { formatNaira, parseNairaToKobo, toKobo, type Kobo } from "@/lib/money";
import {
  MAX_RECEIPT_BYTES,
  PAYROLL_EVIDENCE_BUCKET,
  PAYROLL_FILES_BUCKET,
  PAYROLL_LINK_SECONDS,
  RECEIPT_TYPES,
  checkUploadedReceipt,
  receiptExtensionOf,
  type ReceiptExt,
} from "@/lib/payroll/receipts";
import { runMonth } from "@/lib/payroll/run-format";
import { REMITTANCE_KINDS, remittanceTitle, type RemittanceKind } from "@/lib/payroll/statutory";
import type { ManagerRole } from "@/lib/roles";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { decryptPii } from "@/server/crypto/pii";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import { renderSchedule, type ScheduleWorkerRow } from "./schedules/render";

/**
 * Statutory remittances (slice 5.6; docs/PHASE_5.md 5.6 and "Roles and access"): owner, hr and
 * finance record a payment with its receipt, void a wrong record with a reason, and download the
 * schedules; owner and hr set the company's own due days. Every write is one SQL function as the
 * user (which checks the role and a trusted session again), audited; a money write has a preview.
 *
 * Receipts (rule 9, no custody of anything but the evidence): the server gives the browser a
 * signed upload token for one exact path in the private `payroll-evidence` bucket
 * ({organisation_id}/{remittance_id}/{receipt_id}.{ext}); the browser uploads there; then the
 * server reads the object back, checks its type from its magic bytes and its size, works out its
 * sha256 and records the receipt with the secret key (`record_statutory_receipt`, naming the user
 * `mutate()` verified); only then does the user's own call record the payment. A file that fails
 * is deleted. Nothing a user sends picks another company's path: the organisation is the
 * session's.
 *
 * Schedules (rule 9): made on request from the posted payslips, read as the user under RLS; RSA
 * PINs are decrypted here only, written into the CSV in the private `payroll-files` bucket at
 * {organisation_id}/{run_id}/schedules/{remittance_id}.csv, and opened by a 60-second signed URL.
 * The download is audited with ids only. Never log a PIN, the file or the URL. Module: payroll.
 */

type Client = SupabaseClient<Database>;

export const REMITTANCE_RECORDERS = [
  "owner",
  "hr",
  "finance",
] as const satisfies readonly ManagerRole[];
export const REMITTANCE_SETTINGS_EDITORS = [
  "owner",
  "hr",
] as const satisfies readonly ManagerRole[];

export function canRecordRemittances(role: ManagerRole): boolean {
  return (REMITTANCE_RECORDERS as readonly ManagerRole[]).includes(role);
}

export function canSetRemittanceDueDays(role: ManagerRole): boolean {
  return (REMITTANCE_SETTINGS_EDITORS as readonly ManagerRole[]).includes(role);
}

const reload = "Reload the page and try again";
const remittanceId = z.uuid(reload);
const amountMessage = "Enter the amount paid, like 156600 or 156,600.00";

const plain = (max: number, what: string, required: boolean) => {
  const message = `${what} in up to ${max} characters, with no web addresses or < >`;
  const base = z
    .string(message)
    .trim()
    .max(max, message)
    .refine((v) => !/[\u0000-\u001f\u007f-\u009f<>]/.test(v), message)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), message);
  return required ? base.min(1, message) : base;
};

const paymentFields = {
  remittanceId,
  paidOn: z.iso.date("Choose the date it was paid"),
  amount: z
    .string(amountMessage)
    .trim()
    .transform((v, ctx): Kobo => {
      try {
        const kobo = parseNairaToKobo(v);
        if (kobo <= 0n || kobo > 100_000_000_000_000n) throw new RangeError("out of range");
        return kobo;
      } catch {
        ctx.addIssue({ code: "custom", message: amountMessage });
        return z.NEVER;
      }
    }),
  reference: z
    .string()
    .optional()
    .transform((v) => v ?? "")
    .pipe(plain(100, "The bank reference", false)),
};

/** What the preview needs: the payment's details, before any file is uploaded. */
export const previewPaymentSchema = z.object(paymentFields);

/** Recording it: the details and the receipt the browser uploaded. */
export const recordPaymentSchema = z.object({
  ...paymentFields,
  receiptId: z.uuid("Upload the receipt again"),
  fileExt: z.enum(["pdf", "png", "jpg"], "Upload a PDF, PNG or JPEG receipt"),
});

export const startReceiptSchema = z.object({
  remittanceId,
  fileName: z
    .string()
    .trim()
    .min(1, "Choose the receipt file.")
    .max(255, "Rename the file to something shorter and upload it again.")
    .refine((name) => receiptExtensionOf(name) !== null, "Upload a PDF, PNG or JPEG receipt."),
  size: z.coerce
    .number()
    .int()
    .min(1, "The file is empty. Choose another.")
    .max(MAX_RECEIPT_BYTES, "The file is larger than 10 MB. Upload a smaller copy."),
});

export const voidPaymentSchema = z.object({
  paymentId: z.uuid(reload),
  reason: plain(500, "Say why the record is wrong", true),
});

const dueDay = z
  .string()
  .optional()
  .transform((v, ctx): number | null => {
    const t = (v ?? "").trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 28) {
      ctx.addIssue({ code: "custom", message: "A day from 1 to 28, or leave it empty" });
      return z.NEVER;
    }
    return n;
  });

export const dueDaysSchema = z.object({
  paye: dueDay,
  nhf: dueDay,
  nsitf: dueDay,
  itf: dueDay,
});

export const remittanceIdSchema = z.object({ remittanceId });
export const receiptLinkSchema = z.object({ paymentId: z.uuid(reload) });

/** Database refusals in plain English. */
export function fromRemittanceDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (error.code === "42501") {
    throw new MutationError(
      "forbidden",
      "Your role can't record remittances. The owner, HR or Finance does.",
    );
  }
  if (error.code === "P0002")
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  if (/^MLSR[1-7]$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code})`);
}

// ---------------------------------------------------------------------------
// Reads used by the writes
// ---------------------------------------------------------------------------

interface RemittanceTarget {
  id: string;
  runId: string;
  kind: RemittanceKind;
  authorityKey: string | null;
  amountKobo: Kobo;
  standingPaymentId: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
}

async function readRemittance(
  supabase: Client,
  organisationId: string,
  id: string,
): Promise<RemittanceTarget> {
  const { data, error } = await supabase
    .from("statutory_remittances")
    .select("id, run_id, kind, authority_key, amount_kobo::text")
    .eq("organisation_id", organisationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the remittance (${error.code})`);
  const rem = data as unknown as {
    id: string;
    run_id: string;
    kind: string;
    authority_key: string | null;
    amount_kobo: string;
  } | null;
  if (!rem) throw new MutationError("invalid", "That remittance wasn't found. Reload the page.");
  const [{ data: run, error: runError }, { data: pays, error: payError }] = await Promise.all([
    supabase
      .from("payroll_runs")
      .select("period_start, period_end, pay_date")
      .eq("organisation_id", organisationId)
      .eq("id", rem.run_id)
      .maybeSingle(),
    supabase
      .from("statutory_payments")
      .select("id, entry, voids_payment_id")
      .eq("organisation_id", organisationId)
      .eq("remittance_id", id),
  ]);
  if (runError || payError) throw new Error("Could not read the remittance's run or payments");
  if (!run) throw new MutationError("invalid", "That remittance wasn't found. Reload the page.");
  const voided = new Set(
    (pays ?? []).flatMap((p) => (p.voids_payment_id ? [p.voids_payment_id] : [])),
  );
  const standing = (pays ?? []).find((p) => p.entry === "payment" && !voided.has(p.id));
  if (!(REMITTANCE_KINDS as readonly string[]).includes(rem.kind)) {
    throw new Error("Unknown remittance kind");
  }
  return {
    id: rem.id,
    runId: rem.run_id,
    kind: rem.kind as RemittanceKind,
    authorityKey: rem.authority_key,
    amountKobo: toKobo(rem.amount_kobo),
    standingPaymentId: standing?.id ?? null,
    periodStart: run.period_start,
    periodEnd: run.period_end,
    payDate: run.pay_date,
  };
}

const money = (k: Kobo) => formatNaira(k, { whole: k % 100n === 0n });

function titleOf(r: RemittanceTarget): string {
  return `${remittanceTitle(r.kind, r.authorityKey)} for ${runMonth(r.periodEnd)}`;
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

export async function previewRecordPayment(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof previewPaymentSchema>,
): Promise<CapabilityPreview> {
  const r = await readRemittance(ctx.supabase, ctx.organisationId, data.remittanceId);
  if (r.standingPaymentId) {
    throw new MutationError(
      "invalid",
      "A payment is already recorded for this remittance. Void it first if it was wrong.",
    );
  }
  const difference = data.amount - r.amountKobo;
  const changes: CapabilityPreview["changes"] = [
    { label: "Amount due", after: money(r.amountKobo) },
    { label: "Amount paid", after: money(data.amount) },
    { label: "Paid on", after: formatDate(data.paidOn) },
  ];
  if (data.reference) changes.push({ label: "Bank reference", after: data.reference });
  changes.push({ label: "Status", before: "Unpaid", after: "Paid, with receipt" });
  const gap =
    difference === 0n
      ? "the amount due"
      : difference < 0n
        ? `${money(-difference)} less than due`
        : `${money(difference)} more than due`;
  return {
    summary: `Records ${money(data.amount)} paid on ${formatDate(data.paidOn)} for ${titleOf(r)}: ${gap}. The receipt is kept with it; the record never changes, and a wrong one is voided with a reason.`,
    changes,
  };
}

export async function previewVoidPayment(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof voidPaymentSchema>,
): Promise<CapabilityPreview> {
  const { data: pay, error } = await ctx.supabase
    .from("statutory_payments")
    .select("remittance_id, paid_on, paid_amount_kobo::text, entry")
    .eq("organisation_id", ctx.organisationId)
    .eq("id", data.paymentId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the payment (${error.code})`);
  const p = pay as unknown as {
    remittance_id: string;
    paid_on: string | null;
    paid_amount_kobo: string | null;
    entry: string;
  } | null;
  if (!p || p.entry !== "payment") {
    throw new MutationError("invalid", "That payment wasn't found. Reload the page.");
  }
  const r = await readRemittance(ctx.supabase, ctx.organisationId, p.remittance_id);
  if (r.standingPaymentId !== data.paymentId) {
    throw new MutationError("invalid", "Only a standing payment can be voided.");
  }
  const amount = toKobo(p.paid_amount_kobo ?? "0");
  return {
    summary: `Voids the record of ${money(amount)} paid on ${formatDate(p.paid_on ?? r.payDate)} for ${titleOf(r)}. It stays on file as voided, with your reason, and the remittance shows as unpaid again.`,
    changes: [
      { label: "Status", before: "Paid", after: "Unpaid" },
      { label: "Reason", after: data.reason },
    ],
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface StartedReceipt {
  receiptId: string;
  path: string;
  token: string;
  fileExt: ReceiptExt;
  contentType: string;
}

/**
 * Step 1 of recording a payment: where the browser uploads the receipt. A signed upload token for
 * one path in the private bucket, made with the secret key after an RLS-checked read of the
 * remittance. Changes no row.
 */
export const startReceiptSpec: MutationSpec<typeof startReceiptSchema, StartedReceipt> = {
  module: "payroll",
  schema: startReceiptSchema,
  roles: REMITTANCE_RECORDERS,
  run: async ({ supabase, organisationId, data }) => {
    const r = await readRemittance(supabase, organisationId, data.remittanceId);
    if (r.standingPaymentId) {
      throw new MutationError(
        "invalid",
        "A payment is already recorded for this remittance. Void it first if it was wrong.",
      );
    }
    const fileExt = receiptExtensionOf(data.fileName) as ReceiptExt;
    const receiptId = randomUUID();
    const path = `${organisationId}/${r.id}/${receiptId}.${fileExt}`;
    const { data: signed, error } = await createAdminSupabase()
      .storage.from(PAYROLL_EVIDENCE_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !signed) throw new Error("Could not prepare the receipt upload");
    return {
      receiptId,
      path,
      token: signed.token,
      fileExt,
      contentType: RECEIPT_TYPES[fileExt].mime,
    };
  },
};

/** Deletes a refused upload. A failure is left in the private bucket, logged by error name only. */
async function deleteRefusedReceipt(path: string): Promise<void> {
  try {
    const { error } = await createAdminSupabase()
      .storage.from(PAYROLL_EVIDENCE_BUCKET)
      .remove([path]);
    if (error) throw error;
  } catch (cause) {
    console.error(
      "statutory_receipts.cleanup_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
  }
}

/**
 * Step 2: the receipt is in the bucket. Check its bytes, record it with the secret key naming the
 * verified user, then record the payment as the user.
 */
export const recordPaymentSpec: MutationSpec<
  typeof recordPaymentSchema,
  { remittanceId: string; paymentId: string }
> = {
  module: "payroll",
  schema: recordPaymentSchema,
  roles: REMITTANCE_RECORDERS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const r = await readRemittance(supabase, organisationId, data.remittanceId);
    if (r.standingPaymentId) {
      throw new MutationError(
        "invalid",
        "A payment is already recorded for this remittance. Void it first if it was wrong.",
      );
    }
    const path = `${organisationId}/${r.id}/${data.receiptId}.${data.fileExt}`;
    const admin = createAdminSupabase();
    const download = await admin.storage.from(PAYROLL_EVIDENCE_BUCKET).download(path);
    if (download.error || !download.data) {
      throw new MutationError("invalid", "The receipt didn't arrive. Choose the file again.");
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const check = checkUploadedReceipt(bytes, data.fileExt);
    if (!check.ok) {
      await deleteRefusedReceipt(path);
      throw new MutationError("invalid", check.message);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { error: receiptError } = await admin.rpc("record_statutory_receipt", {
      p_organisation_id: organisationId,
      p_remittance_id: r.id,
      p_receipt_id: data.receiptId,
      p_actor: userId,
      p_file_ext: data.fileExt,
      p_size_bytes: bytes.length,
      p_sha256: sha256,
    });
    if (receiptError) {
      if (receiptError.code === "MLSR5") await deleteRefusedReceipt(path);
      fromRemittanceDbError(receiptError);
    }
    const { data: paymentId, error } = await supabase.rpc("record_statutory_payment", {
      p_organisation_id: organisationId,
      p_remittance_id: r.id,
      p_receipt_id: data.receiptId,
      p_paid_on: data.paidOn,
      p_paid_amount_kobo: data.amount.toString(),
      p_reference: data.reference,
    });
    if (error) fromRemittanceDbError(error);
    return { remittanceId: r.id, paymentId: paymentId! };
  },
};

export const voidPaymentSpec: MutationSpec<typeof voidPaymentSchema, { voidId: string }> = {
  module: "payroll",
  schema: voidPaymentSchema,
  roles: REMITTANCE_RECORDERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: voidId, error } = await supabase.rpc("void_statutory_payment", {
      p_organisation_id: organisationId,
      p_payment_id: data.paymentId,
      p_reason: data.reason,
    });
    if (error) fromRemittanceDbError(error);
    return { voidId: voidId! };
  },
};

export const setDueDaysSpec: MutationSpec<typeof dueDaysSchema, null> = {
  module: "payroll",
  schema: dueDaysSchema,
  roles: REMITTANCE_SETTINGS_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("set_remittance_due_days", {
      p_organisation_id: organisationId,
      ...(data.paye === null ? {} : { p_paye: data.paye }),
      ...(data.nhf === null ? {} : { p_nhf: data.nhf }),
      ...(data.nsitf === null ? {} : { p_nsitf: data.nsitf }),
      ...(data.itf === null ? {} : { p_itf: data.itf }),
    });
    if (error) fromRemittanceDbError(error);
    return null;
  },
};

// ---------------------------------------------------------------------------
// Files: schedules and receipts (60-second links, audited with ids only)
// ---------------------------------------------------------------------------

export interface FileLink {
  url: string;
  fileName: string;
}

type SlipRecord = {
  id: string;
  worker_id: string;
  tax_state: string | null;
  pfa_name: string | null;
  gross_kobo: string;
  paye_kobo: string;
  pension_employee_kobo: string;
  pension_employer_kobo: string;
  nhf_kobo: string;
  nsitf_kobo: string;
  itf_kobo: string;
};

type WorkerRecord = {
  id: string;
  staff_id: string;
  first_name: string;
  last_name: string;
  tin: string | null;
  rsa_pin_enc: string | null;
};

/** The payslip's annual taxable income from its stored trace (`taxable` step), or null. */
function annualTaxable(trace: unknown): Kobo | null {
  const steps = (trace as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return null;
  const step = steps.find(
    (s): s is { step: string; value_kobo: unknown } =>
      typeof s === "object" && s !== null && (s as { step?: unknown }).step === "taxable",
  );
  return typeof step?.value_kobo === "string" && /^[0-9]+$/.test(step.value_kobo)
    ? toKobo(step.value_kobo)
    : null;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "none"
  );
}

/**
 * Makes one remittance's schedule from its run's posted payslips (read as the user, under RLS),
 * puts it in the private bucket and returns a 60-second link that downloads it. RSA PINs are
 * decrypted here for pension and never logged; a PIN that won't decrypt stops the file.
 */
export const scheduleLinkSpec: MutationSpec<typeof remittanceIdSchema, FileLink> = {
  module: "payroll",
  schema: remittanceIdSchema,
  roles: REMITTANCE_RECORDERS,
  run: async ({ supabase, organisationId, data }) => {
    const r = await readRemittance(supabase, organisationId, data.remittanceId);
    const kind = r.kind;
    let slipQuery = supabase
      .from("payslips")
      .select(
        `id, worker_id, tax_state, pfa_name, gross_kobo::text, paye_kobo::text, pension_employee_kobo::text, pension_employer_kobo::text, nhf_kobo::text, nsitf_kobo::text, itf_kobo::text${kind === "paye" ? ", trace" : ""}`,
      )
      .eq("organisation_id", organisationId)
      .eq("run_id", r.runId);
    if (kind === "paye") {
      slipQuery =
        r.authorityKey === null
          ? slipQuery.is("tax_state", null)
          : slipQuery.eq("tax_state", r.authorityKey);
    }
    if (kind === "pension") {
      slipQuery =
        r.authorityKey === null
          ? slipQuery.is("pfa_name", null)
          : slipQuery.eq("pfa_name", r.authorityKey);
    }
    const { data: slipData, error: slipError } = await slipQuery;
    if (slipError) throw new Error(`Could not read the payslips (${slipError.code})`);
    const slips = (slipData ?? []) as unknown as (SlipRecord & { trace?: unknown })[];
    const workerIds = [...new Set(slips.map((s) => s.worker_id))];

    const basic = new Map<string, Kobo>();
    if (kind === "nhf" && slips.length > 0) {
      const { data: lines, error } = await supabase
        .from("payslip_lines")
        .select("payslip_id, amount_kobo::text")
        .eq("organisation_id", organisationId)
        .eq("run_id", r.runId)
        .eq("code", "basic");
      if (error) throw new Error(`Could not read the payslip lines (${error.code})`);
      for (const l of (lines ?? []) as unknown as { payslip_id: string; amount_kobo: string }[]) {
        basic.set(l.payslip_id, (basic.get(l.payslip_id) ?? 0n) + toKobo(l.amount_kobo));
      }
    }

    const workers = new Map<string, WorkerRecord>();
    if (workerIds.length > 0) {
      const columns = `id, staff_id, first_name, last_name${kind === "paye" ? ", tin" : ""}${kind === "pension" ? ", rsa_pin_enc" : ""}`;
      const { data: rows, error } = await supabase
        .from("workers")
        .select(columns)
        .eq("organisation_id", organisationId)
        .in("id", workerIds);
      if (error) throw new Error(`Could not read the workers (${error.code})`);
      for (const w of (rows ?? []) as unknown as WorkerRecord[]) workers.set(w.id, w);
    }

    const rows: ScheduleWorkerRow[] = slips.map((s) => {
      const w = workers.get(s.worker_id);
      if (!w) throw new Error("A payslip's worker couldn't be read");
      let rsaPin: string | null = null;
      if (kind === "pension" && w.rsa_pin_enc) {
        try {
          rsaPin = decryptPii(w.rsa_pin_enc, {
            organisationId,
            table: "workers",
            column: "rsa_pin_enc",
            rowId: w.id,
          });
        } catch {
          throw new MutationError(
            "invalid",
            `The RSA PIN on file for staff ID ${w.staff_id} can't be read. Ask HR to enter it again, then download the schedule.`,
          );
        }
      }
      return {
        staffId: w.staff_id,
        name: `${w.first_name} ${w.last_name}`.trim(),
        tin: w.tin ?? null,
        rsaPin,
        grossKobo: toKobo(s.gross_kobo),
        annualTaxableKobo: kind === "paye" ? annualTaxable(s.trace) : null,
        basicKobo: basic.get(s.id) ?? 0n,
        payeKobo: toKobo(s.paye_kobo),
        pensionEmployeeKobo: toKobo(s.pension_employee_kobo),
        pensionEmployerKobo: toKobo(s.pension_employer_kobo),
        nhfKobo: toKobo(s.nhf_kobo),
        nsitfKobo: toKobo(s.nsitf_kobo),
        itfKobo: toKobo(s.itf_kobo),
      };
    });
    const schedule = renderSchedule(kind, rows);
    if (schedule.totalKobo !== r.amountKobo) {
      // The payslips are posted and the remittance was made from them: this never happens.
      throw new Error("The schedule doesn't add up to the remittance");
    }

    const path = `${organisationId}/${r.runId}/schedules/${r.id}.csv`;
    const fileName = `${slug(remittanceTitle(kind, r.authorityKey))}-${r.periodEnd.slice(0, 7)}.csv`;
    const admin = createAdminSupabase();
    const upload = await admin.storage
      .from(PAYROLL_FILES_BUCKET)
      .upload(path, schedule.bytes, { contentType: "text/csv", upsert: true });
    if (upload.error) throw new Error("Could not store the schedule");
    const { data: signed, error: signError } = await admin.storage
      .from(PAYROLL_FILES_BUCKET)
      .createSignedUrl(path, PAYROLL_LINK_SECONDS, { download: fileName });
    if (signError || !signed?.signedUrl) throw new Error("Could not make the schedule's link");
    return { url: signed.signedUrl, fileName };
  },
  event: ({ data }) => ({
    action: "payroll.schedule_downloaded",
    entity: "statutory_remittances",
    entityId: data.remittanceId,
  }),
};

/** A 60-second link that opens a payment's receipt, after an RLS-checked read of its row. */
export const receiptLinkSpec: MutationSpec<typeof receiptLinkSchema, FileLink> = {
  module: "payroll",
  schema: receiptLinkSchema,
  roles: REMITTANCE_RECORDERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: pay, error } = await supabase
      .from("statutory_payments")
      .select("receipt_id")
      .eq("organisation_id", organisationId)
      .eq("id", data.paymentId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the payment (${error.code})`);
    if (!pay?.receipt_id)
      throw new MutationError("invalid", "That receipt wasn't found. Reload the page.");
    const { data: receipt, error: receiptError } = await supabase
      .from("statutory_receipts")
      .select("storage_path, file_ext")
      .eq("organisation_id", organisationId)
      .eq("id", pay.receipt_id)
      .maybeSingle();
    if (receiptError) throw new Error(`Could not read the receipt (${receiptError.code})`);
    if (!receipt) throw new MutationError("invalid", "That receipt wasn't found. Reload the page.");
    const { data: signed, error: signError } = await createAdminSupabase()
      .storage.from(PAYROLL_EVIDENCE_BUCKET)
      .createSignedUrl(receipt.storage_path, PAYROLL_LINK_SECONDS);
    if (signError || !signed?.signedUrl) throw new Error("Could not make the receipt's link");
    return { url: signed.signedUrl, fileName: `receipt.${receipt.file_ext}` };
  },
  event: ({ data }) => ({
    action: "payroll.remittance_receipt_opened",
    entity: "statutory_payments",
    entityId: data.paymentId,
  }),
};
