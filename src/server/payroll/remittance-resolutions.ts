import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatDate, lagosToday } from "@/lib/dates";
import { formatNaira, parseNairaToKobo, toKobo, type Kobo } from "@/lib/money";
import {
  MAX_RECEIPT_BYTES,
  PAYROLL_EVIDENCE_BUCKET,
  RECEIPT_TYPES,
  checkUploadedReceipt,
  receiptExtensionOf,
  type ReceiptExt,
} from "@/lib/payroll/receipts";
import {
  maxOffset,
  resolutionRefusal,
  resolvePayment,
  type PaymentResolution,
} from "@/lib/payroll/remittance-offsets";
import { runMonth } from "@/lib/payroll/run-format";
import { remittanceTitle, type RemittanceKind } from "@/lib/payroll/statutory";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import { REMITTANCE_RECORDERS, fromRemittanceDbError, type StartedReceipt } from "./remittances";

/**
 * Refunds and offsets of a payment made against a remittance a reversal voided (slice 5.7c, after
 * 5.7a's void path). The payment stays as evidence; owner, hr or finance resolve it, wholly or in
 * parts, as a refund received from the authority (with its receipt, through 5.6's upload: a signed
 * token for one path in the private payroll-evidence bucket, the bytes checked on the server and
 * recorded with the secret key, then `record_remittance_refund` as the user) or an offset against
 * a later standing remittance to the same authority (`record_remittance_offset`). No rule decides
 * which an authority allows (RULES_NIGERIA open point 8): it is the person's choice, audited.
 * Each write has a preview. Nothing here logs a file, a path or a link.
 */

type Client = SupabaseClient<Database>;

const reload = "Reload the page and try again";
const amountMessage = "Enter the amount, like 156600 or 156,600.00";

const plain = (max: number, what: string, required: boolean) => {
  const message = `${what} in up to ${max} characters, with no web addresses, < > or account numbers`;
  const base = z
    .string(message)
    .trim()
    .max(max, message)
    .refine((v) => !/[\u0000-\u001f\u007f-\u009f<>]/.test(v), message)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), message)
    .refine((v) => v.replace(/\D/g, "").length < 10, message);
  return required ? base.min(1, message) : base;
};

const amount = z
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
  });

const refundFields = {
  paymentId: z.uuid(reload),
  receivedOn: z.iso.date("Choose the date the refund arrived"),
  amount,
  reference: z
    .string()
    .optional()
    .transform((v) => v ?? "")
    .pipe(plain(100, "The bank reference", false)),
};

export const previewRefundSchema = z.object(refundFields);
export const startRefundReceiptSchema = z.object({
  ...refundFields,
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
export const recordRefundSchema = z.object({
  ...refundFields,
  receiptId: z.uuid("Upload the receipt again"),
  fileExt: z.enum(["pdf", "png", "jpg"], "Upload a PDF, PNG or JPEG receipt"),
});

export const offsetSchema = z.object({
  paymentId: z.uuid(reload),
  targetRemittanceId: z.uuid("Choose the remittance to offset it against"),
  amount,
  note: plain(500, "Say why it is offset (for example, what the authority agreed)", true),
});

/** Database refusals in plain English. */
export function fromResolutionDbError(error: Pick<PostgrestError, "code" | "message">): never {
  if (/^MLAR[C-I]$/.test(error.code)) throw new MutationError("invalid", error.message);
  fromRemittanceDbError(error);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ResolutionRow {
  id: string;
  /** An offset whose target remittance a later reversal voided: it no longer counts. */
  lapsed?: boolean;
  kind: "refund" | "offset";
  amountKobo: Kobo;
  receivedOn: string | null;
  reference: string | null;
  targetRemittanceId: string | null;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface OffsetTarget {
  remittanceId: string;
  label: string;
  /** What the later remittance can still take: its amount less offsets in and any payment. */
  roomKobo: Kobo;
}

export interface VoidedPayment {
  paymentId: string;
  remittanceId: string;
  kind: RemittanceKind;
  title: string;
  periodEnd: string;
  payDate: string;
  paidOn: string;
  voidReason: string;
  resolution: PaymentResolution;
  resolutions: ResolutionRow[];
  targets: OffsetTarget[];
}

type RemRecord = {
  id: string;
  run_id: string;
  kind: string;
  authority_key: string | null;
  authority_name: string | null;
  amount_kobo: string;
};

/** Standing payments by remittance (recorded and not voided as wrong). */
async function standingPayments(
  supabase: Client,
  organisationId: string,
  remittanceIds: readonly string[],
): Promise<Map<string, { id: string; paidOn: string; paidKobo: Kobo }>> {
  const out = new Map<string, { id: string; paidOn: string; paidKobo: Kobo }>();
  if (remittanceIds.length === 0) return out;
  const { data, error } = await supabase
    .from("statutory_payments")
    .select("id, remittance_id, entry, paid_on, paid_amount_kobo::text, voids_payment_id")
    .eq("organisation_id", organisationId)
    .in("remittance_id", [...remittanceIds]);
  if (error) throw new Error(`Could not read remittance payments (${error.code})`);
  const rows = (data ?? []) as unknown as {
    id: string;
    remittance_id: string;
    entry: string;
    paid_on: string | null;
    paid_amount_kobo: string | null;
    voids_payment_id: string | null;
  }[];
  const voided = new Set(rows.flatMap((r) => (r.voids_payment_id ? [r.voids_payment_id] : [])));
  for (const r of rows) {
    if (r.entry !== "payment" || voided.has(r.id)) continue;
    out.set(r.remittance_id, {
      id: r.id,
      paidOn: r.paid_on ?? "",
      paidKobo: toKobo(r.paid_amount_kobo ?? "0"),
    });
  }
  return out;
}

/**
 * Payments recorded against remittances a reversal voided, with how far each is refunded or
 * offset, and the later standing remittances to the same authority each could be offset against.
 * Owner, hr and finance (RLS); anyone else gets nothing.
 */
export async function loadVoidedPayments(
  supabase: Client,
  organisationId: string,
): Promise<VoidedPayment[]> {
  const { data: voids, error } = await supabase
    .from("statutory_remittance_voids")
    .select("remittance_id, reason")
    .eq("organisation_id", organisationId)
    .limit(1000);
  if (error) throw new Error(`Could not read voided remittances (${error.code})`);
  const voidReason = new Map((voids ?? []).map((v) => [v.remittance_id, v.reason] as const));
  if (voidReason.size === 0) return [];
  const voidedIds = [...voidReason.keys()];
  const paid = await standingPayments(supabase, organisationId, voidedIds);
  if (paid.size === 0) return [];

  const { data: rems, error: remError } = await supabase
    .from("statutory_remittances")
    .select("id, run_id, kind, authority_key, authority_name, amount_kobo::text")
    .eq("organisation_id", organisationId)
    .limit(5000);
  if (remError) throw new Error(`Could not read remittances (${remError.code})`);
  const all = (rems ?? []) as unknown as RemRecord[];
  const { data: runs, error: runError } = await supabase
    .from("payroll_runs")
    .select("id, period_end, pay_date, status")
    .eq("organisation_id", organisationId)
    .in("id", [...new Set(all.map((r) => r.run_id))]);
  if (runError) throw new Error(`Could not read payroll runs (${runError.code})`);
  const runOf = new Map((runs ?? []).map((r) => [r.id, r] as const));

  const { data: res, error: resError } = await supabase
    .from("statutory_payment_resolutions")
    .select(
      "id, payment_id, kind, amount_kobo::text, received_on, reference, target_remittance_id, note, recorded_by, created_at",
    )
    .eq("organisation_id", organisationId)
    .order("created_at")
    .limit(5000);
  if (resError) throw new Error(`Could not read refunds and offsets (${resError.code})`);
  const resolutions = (
    (res ?? []) as unknown as {
      id: string;
      payment_id: string;
      kind: string;
      amount_kobo: string;
      received_on: string | null;
      reference: string | null;
      target_remittance_id: string | null;
      note: string | null;
      recorded_by: string;
      created_at: string;
    }[]
  ).map((r) => ({
    paymentId: r.payment_id,
    row: <ResolutionRow>{
      id: r.id,
      kind: r.kind === "offset" ? ("offset" as const) : ("refund" as const),
      amountKobo: toKobo(r.amount_kobo),
      receivedOn: r.received_on,
      reference: r.reference,
      targetRemittanceId: r.target_remittance_id,
      note: r.note,
      recordedBy: r.recorded_by,
      createdAt: r.created_at,
    },
  }));
  const offsetsIn = new Map<string, Kobo>();
  for (const { row } of resolutions) {
    if (row.kind === "offset" && row.targetRemittanceId) {
      offsetsIn.set(
        row.targetRemittanceId,
        (offsetsIn.get(row.targetRemittanceId) ?? 0n) + row.amountKobo,
      );
    }
  }
  const standingTargets = all.filter((r) => {
    const run = runOf.get(r.run_id);
    return !voidReason.has(r.id) && run && (run.status === "approved" || run.status === "released");
  });
  const targetPaid = await standingPayments(
    supabase,
    organisationId,
    standingTargets.map((r) => r.id),
  );

  const out: VoidedPayment[] = [];
  for (const rem of all) {
    const payment = paid.get(rem.id);
    const run = runOf.get(rem.run_id);
    if (!payment || !voidReason.has(rem.id) || !run) continue;
    const mine = resolutions.filter((r) => r.paymentId === payment.id).map((r) => r.row);
    // An offset whose target a later reversal voided resolves nothing any more (money review M3).
    const resolution = resolvePayment(
      payment.paidKobo,
      mine.filter(
        (r) =>
          !(r.kind === "offset" && r.targetRemittanceId && voidReason.has(r.targetRemittanceId)),
      ),
    );
    const kind = rem.kind as RemittanceKind;
    const targets: OffsetTarget[] = standingTargets
      .filter((t) => {
        const tr = runOf.get(t.run_id)!;
        return (
          t.kind === rem.kind &&
          t.authority_key === rem.authority_key &&
          tr.pay_date >= run.pay_date
        );
      })
      .map((t) => {
        const tr = runOf.get(t.run_id)!;
        const room = maxOffset(
          { ...resolution, unresolvedKobo: 100_000_000_000_000n },
          {
            amountKobo: toKobo(t.amount_kobo),
            offsetsInKobo: offsetsIn.get(t.id) ?? 0n,
            paidKobo: targetPaid.get(t.id)?.paidKobo ?? null,
          },
        );
        return {
          remittanceId: t.id,
          label: `${remittanceTitle(kind, t.authority_name)} for ${runMonth(tr.period_end)}`,
          roomKobo: room,
        };
      })
      .filter((t) => t.roomKobo > 0n);
    for (const r of mine) {
      if (r.kind === "offset" && r.targetRemittanceId && voidReason.has(r.targetRemittanceId)) {
        r.lapsed = true;
      }
    }
    out.push({
      paymentId: payment.id,
      remittanceId: rem.id,
      kind,
      title: `${remittanceTitle(kind, rem.authority_name)} for ${runMonth(run.period_end)}`,
      periodEnd: run.period_end,
      payDate: run.pay_date,
      paidOn: payment.paidOn,
      voidReason: voidReason.get(rem.id) ?? "",
      resolution,
      resolutions: mine,
      targets,
    });
  }
  return out.sort((a, b) => b.payDate.localeCompare(a.payDate) || a.title.localeCompare(b.title));
}

async function sourceOf(
  supabase: Client,
  organisationId: string,
  paymentId: string,
): Promise<VoidedPayment> {
  const found = (await loadVoidedPayments(supabase, organisationId)).find(
    (p) => p.paymentId === paymentId,
  );
  if (!found) {
    throw new MutationError(
      "invalid",
      "Only a payment recorded against a voided remittance is refunded or offset. Reload the page.",
    );
  }
  return found;
}

const money = (k: Kobo) => formatNaira(k, { whole: k % 100n === 0n });

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

function checkRefund(src: VoidedPayment, data: { receivedOn: string; amount: Kobo }): void {
  const refusal = resolutionRefusal("refund", data.amount, src.resolution);
  if (refusal) throw new MutationError("invalid", refusal, { amount: refusal });
  if (data.receivedOn > lagosToday() || data.receivedOn < src.paidOn) {
    throw new MutationError("invalid", "The refund date is from the payment's date to today.", {
      receivedOn: `Choose a date from ${formatDate(src.paidOn)} to today`,
    });
  }
}

export async function previewRefund(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof previewRefundSchema>,
): Promise<CapabilityPreview> {
  const src = await sourceOf(ctx.supabase, ctx.organisationId, data.paymentId);
  checkRefund(src, data);
  const left = src.resolution.unresolvedKobo - data.amount;
  return {
    summary: `Records a refund of ${money(data.amount)} received on ${formatDate(data.receivedOn)} for ${src.title}, which a reversal voided after it was paid. The receipt is kept with it; the record never changes.`,
    changes: [
      { label: "Paid to the authority", after: money(src.resolution.paidKobo) },
      {
        label: "Refunded",
        before: money(src.resolution.refundedKobo),
        after: money(src.resolution.refundedKobo + data.amount),
      },
      {
        label: "Still to resolve",
        before: money(src.resolution.unresolvedKobo),
        after: money(left),
      },
    ],
  };
}

/** Step 1 of a refund: where the browser uploads its receipt (one path; no row changes). */
export const startRefundReceiptSpec: MutationSpec<typeof startRefundReceiptSchema, StartedReceipt> =
  {
    module: "payroll",
    schema: startRefundReceiptSchema,
    roles: REMITTANCE_RECORDERS,
    run: async ({ supabase, organisationId, data }) => {
      const src = await sourceOf(supabase, organisationId, data.paymentId);
      checkRefund(src, data);
      const fileExt = receiptExtensionOf(data.fileName) as ReceiptExt;
      const receiptId = randomUUID();
      const path = `${organisationId}/${src.remittanceId}/${receiptId}.${fileExt}`;
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

async function deleteRefused(path: string): Promise<void> {
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

/** Step 2: check the receipt's bytes, record it (secret key), then record the refund as the user. */
export const recordRefundSpec: MutationSpec<
  typeof recordRefundSchema,
  { paymentId: string; resolutionId: string }
> = {
  module: "payroll",
  schema: recordRefundSchema,
  roles: REMITTANCE_RECORDERS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const src = await sourceOf(supabase, organisationId, data.paymentId);
    checkRefund(src, data);
    const path = `${organisationId}/${src.remittanceId}/${data.receiptId}.${data.fileExt}`;
    const admin = createAdminSupabase();
    const download = await admin.storage.from(PAYROLL_EVIDENCE_BUCKET).download(path);
    if (download.error || !download.data) {
      throw new MutationError("invalid", "The receipt didn't arrive. Choose the file again.");
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const check = checkUploadedReceipt(bytes, data.fileExt);
    if (!check.ok) {
      await deleteRefused(path);
      throw new MutationError("invalid", check.message);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { error: receiptError } = await admin.rpc("record_statutory_receipt", {
      p_organisation_id: organisationId,
      p_remittance_id: src.remittanceId,
      p_receipt_id: data.receiptId,
      p_actor: userId,
      p_file_ext: data.fileExt,
      p_size_bytes: bytes.length,
      p_sha256: sha256,
    });
    if (receiptError) {
      if (receiptError.code === "MLSR5") await deleteRefused(path);
      fromRemittanceDbError(receiptError);
    }
    const { data: id, error } = await supabase.rpc("record_remittance_refund", {
      p_organisation_id: organisationId,
      p_payment_id: data.paymentId,
      p_receipt_id: data.receiptId,
      p_received_on: data.receivedOn,
      p_amount_kobo: data.amount.toString(),
      ...(data.reference ? { p_reference: data.reference } : {}),
    });
    if (error) fromResolutionDbError(error);
    return { paymentId: data.paymentId, resolutionId: id! };
  },
};

// ---------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------

function checkOffset(src: VoidedPayment, data: z.output<typeof offsetSchema>): OffsetTarget {
  const target = src.targets.find((t) => t.remittanceId === data.targetRemittanceId);
  if (!target) {
    throw new MutationError(
      "invalid",
      "An offset goes against a later remittance to the same authority that stands.",
      { targetRemittanceId: "Choose a later remittance to the same authority" },
    );
  }
  const refusal = resolutionRefusal("offset", data.amount, src.resolution, target.roomKobo);
  if (refusal) throw new MutationError("invalid", refusal, { amount: refusal });
  return target;
}

export async function previewOffset(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  data: z.output<typeof offsetSchema>,
): Promise<CapabilityPreview> {
  const src = await sourceOf(ctx.supabase, ctx.organisationId, data.paymentId);
  const target = checkOffset(src, data);
  return {
    summary: `Offsets ${money(data.amount)} of the payment for ${src.title}, which a reversal voided, against ${target.label}: that remittance then owes ${money(data.amount)} less. Record this only if the authority accepts it; the app doesn't decide that. The record never changes.`,
    changes: [
      {
        label: "Still to resolve",
        before: money(src.resolution.unresolvedKobo),
        after: money(src.resolution.unresolvedKobo - data.amount),
      },
      {
        label: `${target.label}: still to pay`,
        before: money(target.roomKobo),
        after: money(target.roomKobo - data.amount),
      },
      { label: "Why", after: data.note },
    ],
  };
}

export const recordOffsetSpec: MutationSpec<
  typeof offsetSchema,
  { paymentId: string; resolutionId: string }
> = {
  module: "payroll",
  schema: offsetSchema,
  roles: REMITTANCE_RECORDERS,
  run: async ({ supabase, organisationId, data }) => {
    const src = await sourceOf(supabase, organisationId, data.paymentId);
    checkOffset(src, data);
    const { data: id, error } = await supabase.rpc("record_remittance_offset", {
      p_organisation_id: organisationId,
      p_payment_id: data.paymentId,
      p_target_remittance_id: data.targetRemittanceId,
      p_amount_kobo: data.amount.toString(),
      p_note: data.note,
    });
    if (error) fromResolutionDbError(error);
    return { paymentId: data.paymentId, resolutionId: id! };
  },
};
