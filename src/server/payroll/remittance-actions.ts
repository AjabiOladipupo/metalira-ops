"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CapabilityPreview } from "@/server/capabilities/types";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  REMITTANCE_RECORDERS,
  previewPaymentSchema,
  previewRecordPayment,
  previewVoidPayment,
  receiptLinkSpec,
  recordPaymentSpec,
  setDueDaysSpec,
  startReceiptSpec,
  voidPaymentSchema,
  voidPaymentSpec,
  type FileLink,
  type StartedReceipt,
} from "./remittances";
import {
  offsetSchema,
  previewOffset,
  previewRefund,
  previewRefundSchema,
  recordOffsetSpec,
  recordRefundSpec,
  startRefundReceiptSpec,
} from "./remittance-resolutions";

/**
 * Server Actions for statutory remittances (slice 5.6). Each goes through `mutate()` (role,
 * module, Zod, then one SQL function as the user, which checks the role and a trusted session
 * again). Messages are plain English and never carry file contents, object paths, links in logs
 * or personal numbers. Registered in src/server/capabilities/registry.ts.
 */

const FAILED = "That didn't work. Try again in a minute.";
const REMITTANCES_PATH = "/app/payroll/remittances";

type Failure = { ok: false; message: string; fieldErrors?: Partial<Record<string, string>> };

function failure(error: unknown): Failure {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, message: error.message };
    if (error.code === "invalid") {
      const field = Object.values(error.fieldErrors).find(Boolean);
      return { ok: false, message: field ?? error.message, fieldErrors: error.fieldErrors };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "statutory_remittances.failed:",
    cause instanceof Error ? cause.name : "unknown error",
  );
  return { ok: false, message: FAILED };
}

const previewPaymentSpec: MutationSpec<typeof previewPaymentSchema, CapabilityPreview> = {
  module: "payroll",
  schema: previewPaymentSchema,
  roles: REMITTANCE_RECORDERS,
  run: (ctx) => previewRecordPayment(ctx, ctx.data),
};

const previewVoidSpec: MutationSpec<typeof voidPaymentSchema, CapabilityPreview> = {
  module: "payroll",
  schema: voidPaymentSchema,
  roles: REMITTANCE_RECORDERS,
  run: (ctx) => previewVoidPayment(ctx, ctx.data),
};

export type PaymentPreviewResult = { ok: true; preview: CapabilityPreview } | Failure;

/** "Check the payment": what recording it will do, before any file is uploaded. */
/** The payment's details as the form sends them. */
export type PaymentDetails = {
  remittanceId: string;
  paidOn: string;
  amount: string;
  reference: string;
  amountDiffers: boolean;
};

export async function previewRemittancePaymentAction(
  input: PaymentDetails,
): Promise<PaymentPreviewResult> {
  try {
    return { ok: true, preview: await mutate(previewPaymentSpec, input) };
  } catch (error) {
    return failure(error);
  }
}

export type StartReceiptResult = ({ ok: true } & StartedReceipt) | Failure;

/** Step 1 of "Record payment": where the browser uploads the receipt. */
export async function startRemittanceReceiptAction(
  input: PaymentDetails & { fileName: string; size: number },
): Promise<StartReceiptResult> {
  try {
    return { ok: true, ...(await mutate(startReceiptSpec, input)) };
  } catch (error) {
    return failure(error);
  }
}

/** Step 2: the receipt is uploaded; check it and record the payment. */
export async function recordRemittancePaymentAction(
  input: PaymentDetails & { receiptId: string; fileExt: string },
): Promise<{ ok: true } | Failure> {
  try {
    await mutate(recordPaymentSpec, input);
  } catch (error) {
    return failure(error);
  }
  revalidatePath(REMITTANCES_PATH);
  return { ok: true };
}

export type RemittanceFormState =
  (NonNullable<CompanyFormState> & { preview?: CapabilityPreview }) | null;

/** "Void this record": preview first, then a void entry with the reason. */
export async function voidRemittancePaymentAction(
  _prev: RemittanceFormState,
  formData: FormData,
): Promise<RemittanceFormState> {
  const values = formFields(formData);
  const spec = values.intent === "save" ? voidPaymentSpec : previewVoidSpec;
  try {
    const result = await mutate(spec as MutationSpec<typeof voidPaymentSchema, unknown>, values);
    if (values.intent !== "save") {
      return { ok: true, status: 200, preview: result as CapabilityPreview, values };
    }
  } catch (error) {
    const failed = failure(error);
    return {
      ok: false,
      status: error instanceof MutationError && error.code === "forbidden" ? 403 : 400,
      formError: failed.message,
      fieldErrors: failed.fieldErrors,
      values,
    };
  }
  revalidatePath(REMITTANCES_PATH);
  return { ok: true, status: 200, message: "Payment record voided. Record the right one." };
}

/** Settings > Payroll rules: the company's own remittance due days (open question 13). */
export async function setRemittanceDueDaysAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const values = formFields(formData);
  try {
    await mutate(setDueDaysSpec, values);
  } catch (error) {
    const failed = failure(error);
    return {
      ok: false,
      status: error instanceof MutationError && error.code === "forbidden" ? 403 : 400,
      formError: failed.message,
      fieldErrors: failed.fieldErrors,
      values,
    };
  }
  revalidatePath("/app/settings/payroll");
  revalidatePath(REMITTANCES_PATH);
  return {
    ok: true,
    status: 200,
    message:
      "Due days saved. Runs approved from now on use them; due dates already worked out stay.",
  };
}

export type FileLinkResult = ({ ok: true } & FileLink) | Failure;

/** "View receipt": a 60-second link to the receipt, audited. */
export async function remittanceReceiptLinkAction(input: {
  paymentId: string;
}): Promise<FileLinkResult> {
  try {
    return { ok: true, ...(await mutate(receiptLinkSpec, input)) };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Refunds and offsets of payments on voided remittances (slice 5.7c)
// ---------------------------------------------------------------------------

const previewRefundSpec: MutationSpec<typeof previewRefundSchema, CapabilityPreview> = {
  module: "payroll",
  schema: previewRefundSchema,
  roles: REMITTANCE_RECORDERS,
  run: (ctx) => previewRefund(ctx, ctx.data),
};

const previewOffsetSpec: MutationSpec<typeof offsetSchema, CapabilityPreview> = {
  module: "payroll",
  schema: offsetSchema,
  roles: REMITTANCE_RECORDERS,
  run: (ctx) => previewOffset(ctx, ctx.data),
};

/** A refund's details as the form sends them. */
export type RefundDetails = {
  paymentId: string;
  receivedOn: string;
  amount: string;
  reference: string;
};

/** "Check the refund": what recording it will do, before any file is uploaded. */
export async function previewRemittanceRefundAction(
  input: RefundDetails,
): Promise<PaymentPreviewResult> {
  try {
    return { ok: true, preview: await mutate(previewRefundSpec, input) };
  } catch (error) {
    return failure(error);
  }
}

/** Step 1 of "Record a refund": where the browser uploads its receipt. */
export async function startRefundReceiptAction(
  input: RefundDetails & { fileName: string; size: number },
): Promise<StartReceiptResult> {
  try {
    return { ok: true, ...(await mutate(startRefundReceiptSpec, input)) };
  } catch (error) {
    return failure(error);
  }
}

/** Step 2: the receipt is uploaded; check it and record the refund. */
export async function recordRemittanceRefundAction(
  input: RefundDetails & { receiptId: string; fileExt: string },
): Promise<{ ok: true } | Failure> {
  try {
    await mutate(recordRefundSpec, input);
  } catch (error) {
    return failure(error);
  }
  revalidatePath(REMITTANCES_PATH);
  return { ok: true };
}

/** "Offset against a later remittance": preview first, then the offset. */
export async function offsetRemittancePaymentAction(
  _prev: RemittanceFormState,
  formData: FormData,
): Promise<RemittanceFormState> {
  const values = formFields(formData);
  const spec = values.intent === "save" ? recordOffsetSpec : previewOffsetSpec;
  try {
    const result = await mutate(spec as MutationSpec<typeof offsetSchema, unknown>, values);
    if (values.intent !== "save") {
      return { ok: true, status: 200, preview: result as CapabilityPreview, values };
    }
  } catch (error) {
    const failed = failure(error);
    return {
      ok: false,
      status: error instanceof MutationError && error.code === "forbidden" ? 403 : 400,
      formError: failed.message,
      fieldErrors: failed.fieldErrors,
      values,
    };
  }
  revalidatePath(REMITTANCES_PATH);
  return {
    ok: true,
    status: 200,
    message: "Offset recorded. The later remittance owes that much less.",
  };
}
