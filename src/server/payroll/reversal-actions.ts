"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  addCorrectionSpec,
  approveReversalSchema,
  approveReversalSpec,
  correctionSchema,
  PAYROLL_REVERSERS,
  previewApproveReversal,
  previewCorrection,
  previewReverse,
  reverseRunSchema,
  reverseRunSpec,
} from "./reversal";
import type { RunFormState } from "./run-actions";
import { PAYROLL_PREPARERS } from "./runs";
import { errorTag } from "./error-tag";

/**
 * Server Actions for payroll reversal and corrections (slice 5.7a). Each is two presses: the
 * first runs the preview (the negative totals, or the worker's net before and after), the second
 * makes the change through `mutate()` and one SQL function as the user. Registered in
 * src/server/capabilities/registry.ts (all agent: false).
 */

const FAILED = "That was not saved. Try again in a minute.";
const PAYROLL_PATH = "/app/payroll";

function refusal(error: unknown, values?: Record<string, string>): RunFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden")
      return { ok: false, status: 403, formError: error.message, values };
    if (error.code === "invalid") {
      return {
        ok: false,
        status: 400,
        formError: error.message,
        fieldErrors: error.fieldErrors,
        values,
      };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error("payroll_reversal.save_failed:", errorTag(cause));
  return { ok: false, status: 500, formError: FAILED, values };
}

function previewSpec<S extends z.ZodType>(
  schema: S,
  roles: MutationSpec<S, unknown>["roles"],
  preview: (
    ctx: Parameters<MutationSpec<S, CapabilityPreview>["run"]>[0],
    data: z.output<S>,
  ) => Promise<CapabilityPreview>,
): MutationSpec<S, CapabilityPreview> {
  return { module: "payroll", schema, roles, run: async (ctx) => preview(ctx, ctx.data) };
}

const previewReverseSpec = previewSpec(reverseRunSchema, PAYROLL_REVERSERS, previewReverse);
const previewApproveSpec = previewSpec(
  approveReversalSchema,
  PAYROLL_REVERSERS,
  previewApproveReversal,
);
const previewCorrectionSpec = previewSpec(correctionSchema, PAYROLL_PREPARERS, previewCorrection);

async function twoStep<R>(
  formData: FormData,
  preview: MutationSpec<z.ZodType, CapabilityPreview>,
  write: MutationSpec<z.ZodType, R>,
  done: (result: R) => RunFormState | never,
): Promise<RunFormState> {
  const values = formFields(formData);
  if (values.intent !== "save") {
    try {
      return { ok: true, status: 200, preview: await mutate(preview, values), values };
    } catch (error) {
      return refusal(error, values);
    }
  }
  let result: R;
  try {
    result = await mutate(write, values);
  } catch (error) {
    return refusal(error, values);
  }
  return done(result);
}

/**
 * "Reverse this run" (Finance or the owner, an approved run not released): preview (the negative
 * totals, the bank file and remittances it voids), then the reversal waits for a second person.
 */
export async function reverseRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewReverseSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    reverseRunSpec as MutationSpec<z.ZodType, { runId: string; reversalRunId: string }>,
    (r) => {
      revalidatePath(PAYROLL_PATH);
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      redirect(`${PAYROLL_PATH}/${r.reversalRunId}?step=submit`);
    },
  );
}

/**
 * "Approve the reversal" (Finance or the owner, never whoever asked for it): preview, then in one
 * transaction the run is Reversed, its bank file and remittances voided and the period reopened.
 */
export async function approveReversalAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewApproveSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    approveReversalSpec as MutationSpec<
      z.ZodType,
      { runId: string; originalRunId: string; decisionId: string }
    >,
    (r) => {
      revalidatePath(PAYROLL_PATH);
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      revalidatePath(`${PAYROLL_PATH}/${r.originalRunId}`);
      revalidatePath(`${PAYROLL_PATH}/remittances`);
      return {
        ok: true,
        status: 200,
        message: "Reversal approved. The run is reversed and its period is open again.",
      };
    },
  );
}

/** "Correct a released payslip" (HR or the owner, a draft run): preview, then add and recalculate. */
export async function addCorrectionAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewCorrectionSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    addCorrectionSpec as MutationSpec<z.ZodType, { runId: string }>,
    (r) => {
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Correction added and the run recalculated" };
    },
  );
}
