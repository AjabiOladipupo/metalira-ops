"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";

import {
  downloadBankFileSpec,
  makeBankFileSchema,
  makeBankFileSpec,
  PAYOUT_MAKERS,
  previewMakeBankFile,
  type MadeBankFile,
} from "./payouts";
import { onPayrollReleased, previewRelease, releaseRunSchema, releaseRunSpec } from "./release";
import type { RunFormState } from "./run-actions";
import {
  confirmSupplementSchema,
  confirmSupplementSpec,
  downloadSupplementSpec,
  makeSupplementSchema,
  makeSupplementSpec,
  previewConfirmSupplement,
  previewMakeSupplement,
  type MadeSupplement,
} from "./supplements";

/**
 * Server Actions for the run's Pay step (slice 5.4). Making the file and releasing are money
 * writes in two presses: the first runs the preview, the second makes the change. Downloading
 * returns a 60-second link the browser opens at once. Registered in
 * src/server/capabilities/registry.ts; all `agent: false`.
 *
 * Nothing here logs a value: errors are logged by name only (an error's message could carry a
 * worker's name, and a link or path must never reach a log).
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
  console.error("payroll_bank_file.failed:", cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, status: 500, formError: FAILED, values };
}

function previewSpec<S extends z.ZodType>(
  schema: S,
  preview: (
    ctx: Parameters<MutationSpec<S, CapabilityPreview>["run"]>[0],
    data: z.output<S>,
  ) => Promise<CapabilityPreview>,
): MutationSpec<S, CapabilityPreview> {
  return {
    module: "payroll",
    schema,
    roles: PAYOUT_MAKERS,
    run: async (ctx) => preview(ctx, ctx.data),
  };
}

const previewMakeSpec = previewSpec(makeBankFileSchema, previewMakeBankFile);
const previewReleaseSpec = previewSpec(releaseRunSchema, previewRelease);
const previewMakeSupplementSpec = previewSpec(makeSupplementSchema, previewMakeSupplement);
const previewConfirmSupplementSpec = previewSpec(confirmSupplementSchema, previewConfirmSupplement);

async function twoStep<R>(
  formData: FormData,
  preview: MutationSpec<z.ZodType, CapabilityPreview>,
  write: MutationSpec<z.ZodType, R>,
  done: (result: R) => RunFormState,
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

/** "Make file": preview (workers, total, left out), then make, store and record it. */
export async function makeBankFileAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewMakeSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    makeBankFileSpec as MutationSpec<z.ZodType, MadeBankFile>,
    (made) => {
      revalidatePath(`${PAYROLL_PATH}/${made.runId}`);
      return {
        ok: true,
        status: 200,
        message: `Bank file made: ${made.itemCount} ${made.itemCount === 1 ? "worker" : "workers"}. Check the control totals, then download it.`,
      };
    },
  );
}

/** "I uploaded it to the bank": preview, then release; payslip publication follows (5.5). */
export async function releaseRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const session = await getSession();
  const organisationId = session?.active?.organisationId ?? null;
  const actorId = session?.user.id ?? null;
  return twoStep(
    formData,
    previewReleaseSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    releaseRunSpec as MutationSpec<z.ZodType, { runId: string; decisionId: string }>,
    (r) => {
      // After the response, once release_payroll_run has committed (it returned): publishes the
      // payslips (slice 5.5). A retried release returns its decision and runs this again;
      // publication is idempotent.
      if (organisationId) after(() => onPayrollReleased(organisationId, r.runId, { actorId }));
      revalidatePath(PAYROLL_PATH);
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Released. The run is closed." };
    },
  );
}

export type DownloadResult = { ok: true; url: string } | { ok: false; message: string };

/** "Download": a 60-second link to the active file (owner or finance); the download is audited. */
export async function downloadBankFileAction(input: unknown): Promise<DownloadResult> {
  try {
    return { ok: true, ...(await mutate(downloadBankFileSpec, input)) };
  } catch (error) {
    if (error instanceof MutationError && error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error instanceof MutationError && error.code !== "failed") {
      return { ok: false, message: error.message };
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error(
      "payroll_bank_file.download_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
    return { ok: false, message: "The file didn't open. Try again in a minute." };
  }
}

/**
 * "Make a supplementary file" (slice 5.7c): preview (who it pays, the total, who still waits), then
 * make, store and record a bank file for workers the released run's file left out.
 */
export async function makeSupplementAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewMakeSupplementSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    makeSupplementSpec as MutationSpec<z.ZodType, MadeSupplement>,
    (made) => {
      revalidatePath(`${PAYROLL_PATH}/${made.runId}`);
      return {
        ok: true,
        status: 200,
        message: `Supplementary file made: ${made.itemCount} ${made.itemCount === 1 ? "worker" : "workers"}. Check the control totals, then download it.`,
      };
    },
  );
}

/** "I uploaded it to the bank" for a supplementary file: preview, then confirm (slice 5.7c). */
export async function confirmSupplementAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewConfirmSupplementSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    confirmSupplementSpec as MutationSpec<z.ZodType, { runId: string; supplementId: string }>,
    (r) => {
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Confirmed. Those workers are paid." };
    },
  );
}

/** "Download" a supplementary file: a 60-second link (owner or finance); audited. */
export async function downloadSupplementAction(input: unknown): Promise<DownloadResult> {
  try {
    return { ok: true, ...(await mutate(downloadSupplementSpec, input)) };
  } catch (error) {
    if (error instanceof MutationError && error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error instanceof MutationError && error.code !== "failed") {
      return { ok: false, message: error.message };
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error(
      "payroll_supplementary_file.download_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
    return { ok: false, message: "The file didn't open. Try again in a minute." };
  }
}
