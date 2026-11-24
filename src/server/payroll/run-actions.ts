"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CapabilityPreview } from "@/server/capabilities/types";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";

import { notifyRunDecided, notifyRunSubmitted } from "./run-notices";
import {
  acknowledgeSpec,
  addAdjustmentSpec,
  adjustmentSchema,
  approveRunSpec,
  carryInstalmentSchema,
  carryInstalmentSpec,
  createOffCycleRunSchema,
  createOffCycleRunSpec,
  createRunSchema,
  createRunSpec,
  discardOffCycleRunSchema,
  discardOffCycleRunSpec,
  PAYROLL_APPROVERS,
  PAYROLL_PREPARERS,
  previewAddAdjustment,
  previewApprove,
  previewCarryInstalment,
  previewCreateOffCycleRun,
  previewCreateRun,
  previewDiscardOffCycleRun,
  previewRecalculate,
  previewRemoveAdjustment,
  previewReturn,
  previewSubmit,
  recalculateRunSpec,
  removeAdjustmentSchema,
  removeAdjustmentSpec,
  returnRunSchema,
  returnRunSpec,
  runIdSchema,
  submitRunSpec,
} from "./runs";

/**
 * Server Actions for the payroll run (slices 5.2 and 5.3). Each money write is two presses: the first
 * (`intent` not "save") runs the preview, which works the change out without writing; the second
 * makes it. Every write goes through `mutate()` (role, module, Zod, then one SQL function as the
 * user, which checks the role again). Registered in src/server/capabilities/registry.ts.
 */

const FAILED = "That was not saved. Try again in a minute.";
const PAYROLL_PATH = "/app/payroll";

export type RunFormState =
  | (NonNullable<CompanyFormState> & {
      preview?: CapabilityPreview;
    })
  | null;

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
  console.error(
    "payroll_run.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

/** A spec that runs a preview as the signed-in user (same roles and schema as the write). */
function previewSpec<S extends z.ZodType>(
  schema: S,
  roles: MutationSpec<S, unknown>["roles"],
  preview: (
    ctx: Parameters<MutationSpec<S, CapabilityPreview>["run"]>[0],
    data: z.output<S>,
  ) => Promise<CapabilityPreview> | CapabilityPreview,
): MutationSpec<S, CapabilityPreview> {
  return { module: "payroll", schema, roles, run: async (ctx) => preview(ctx, ctx.data) };
}

const previewCreateSpec = previewSpec(createRunSchema, PAYROLL_PREPARERS, previewCreateRun);
const previewRecalculateSpec = previewSpec(runIdSchema, PAYROLL_PREPARERS, previewRecalculate);
const previewCreateOffCycleSpec = previewSpec(
  createOffCycleRunSchema,
  PAYROLL_PREPARERS,
  previewCreateOffCycleRun,
);
const previewDiscardOffCycleSpec = previewSpec(
  discardOffCycleRunSchema,
  PAYROLL_PREPARERS,
  previewDiscardOffCycleRun,
);
const previewAddSpec = previewSpec(adjustmentSchema, PAYROLL_PREPARERS, previewAddAdjustment);
const previewRemoveSpec = previewSpec(
  removeAdjustmentSchema,
  PAYROLL_PREPARERS,
  previewRemoveAdjustment,
);
const previewCarrySpec = previewSpec(
  carryInstalmentSchema,
  PAYROLL_PREPARERS,
  previewCarryInstalment,
);
const previewSubmitSpec = previewSpec(runIdSchema, PAYROLL_PREPARERS, previewSubmit);
const previewReturnSpec = previewSpec(returnRunSchema, PAYROLL_APPROVERS, previewReturn);
const previewApproveSpec = previewSpec(runIdSchema, PAYROLL_APPROVERS, previewApprove);

async function twoStep<R>(
  formData: FormData,
  input: Record<string, unknown>,
  preview: MutationSpec<z.ZodType, CapabilityPreview>,
  write: MutationSpec<z.ZodType, R>,
  done: (result: R) => RunFormState | never,
): Promise<RunFormState> {
  const values = formFields(formData);
  if (values.intent !== "save") {
    try {
      return { ok: true, status: 200, preview: await mutate(preview, input), values };
    } catch (error) {
      return refusal(error, values);
    }
  }
  let result: R;
  try {
    result = await mutate(write, input);
  } catch (error) {
    return refusal(error, values);
  }
  return done(result);
}

/** "Prepare the run": preview (totals against the last posted run), then create and calculate. */
export async function createRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  return twoStep(
    formData,
    input,
    previewCreateSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    createRunSpec as MutationSpec<z.ZodType, { runId: string; calculated: boolean }>,
    (created) => {
      revalidatePath(PAYROLL_PATH);
      redirect(`${PAYROLL_PATH}/${created.runId}?step=gross-to-net`);
    },
  );
}

/**
 * "New off-cycle run" (slice 5.7b): preview (the chosen workers' run worked out), then create and
 * calculate. The ticked workers come as repeated `workerIds` fields; the form gets them back
 * joined with commas so the confirm press sends what the preview showed.
 */
export async function createOffCycleRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const workerIds = formData
    .getAll("workerIds")
    .filter((v): v is string => typeof v === "string" && v !== "");
  const input = { ...formFields(formData), workerIds };
  const state = await twoStep(
    formData,
    input,
    previewCreateOffCycleSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    createOffCycleRunSpec as MutationSpec<z.ZodType, { runId: string; calculated: boolean }>,
    (created) => {
      revalidatePath(PAYROLL_PATH);
      redirect(`${PAYROLL_PATH}/${created.runId}?step=earnings`);
    },
  );
  return state ? { ...state, values: { ...state.values, workerIds: workerIds.join(",") } } : state;
}

/** "Discard this off-cycle run" (slice 5.7b): preview, then discard with a reason. */
export async function discardOffCycleRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  return twoStep(
    formData,
    input,
    previewDiscardOffCycleSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    discardOffCycleRunSpec as MutationSpec<z.ZodType, { runId: string }>,
    (r) => {
      revalidatePath(PAYROLL_PATH);
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Discarded. Nothing on this run is paid." };
    },
  );
}

/** "Recalculate": preview (totals against the current draft), then save. */
export async function recalculateRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  return twoStep(
    formData,
    input,
    previewRecalculateSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    recalculateRunSpec as MutationSpec<z.ZodType, { runId: string }>,
    (r) => {
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Recalculated" };
    },
  );
}

/** "Add": preview (the worker's net before and after), then add and recalculate. */
export async function addAdjustmentAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  return twoStep(
    formData,
    input,
    previewAddSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    addAdjustmentSpec as MutationSpec<z.ZodType, { runId: string }>,
    (r) => {
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Added and recalculated" };
    },
  );
}

/** "Carry next instalment": preview, then carry the same series and recalculate. */
export async function carryInstalmentAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  return twoStep(
    formData,
    input,
    previewCarrySpec as MutationSpec<z.ZodType, CapabilityPreview>,
    carryInstalmentSpec as MutationSpec<z.ZodType, { runId: string }>,
    (r) => {
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Carried and recalculated" };
    },
  );
}

/** "Remove": preview, then remove and recalculate. */
export async function removeAdjustmentAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  return twoStep(
    formData,
    input,
    previewRemoveSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    removeAdjustmentSpec as MutationSpec<z.ZodType, { runId: string }>,
    (r) => {
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Removed and recalculated" };
    },
  );
}

/** Acknowledges the ticked warnings (no money changes, one press). */
export async function acknowledgeAnomaliesAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const values = formFields(formData);
  const input = {
    runId: values.runId,
    anomalyIds: formData.getAll("anomalyId").filter((v): v is string => typeof v === "string"),
  };
  let count: number;
  try {
    count = await mutate(acknowledgeSpec, input);
  } catch (error) {
    return refusal(error, values);
  }
  revalidatePath(`${PAYROLL_PATH}/${values.runId ?? ""}`);
  return {
    ok: true,
    status: 200,
    message: `${count} ${count === 1 ? "anomaly" : "anomalies"} acknowledged`,
  };
}

/** "Submit to Finance": preview (control totals and anomalies), then submit and email Finance. */
export async function submitRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  const organisationId = (await getSession())?.active?.organisationId ?? null;
  return twoStep(
    formData,
    input,
    previewSubmitSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    submitRunSpec as MutationSpec<z.ZodType, { runId: string; decisionId: string }>,
    (r) => {
      if (organisationId) after(() => notifyRunSubmitted(organisationId, r.decisionId));
      revalidatePath(PAYROLL_PATH);
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Submitted. Finance has been told." };
    },
  );
}

/** "Return to HR" (Finance or the owner), with a reason; the preparer is emailed. */
export async function returnRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  const organisationId = (await getSession())?.active?.organisationId ?? null;
  return twoStep(
    formData,
    input,
    previewReturnSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    returnRunSpec as MutationSpec<z.ZodType, { runId: string; decisionId: string }>,
    (r) => {
      if (organisationId) after(() => notifyRunDecided(organisationId, r.decisionId));
      revalidatePath(PAYROLL_PATH);
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return { ok: true, status: 200, message: "Returned to HR as a draft" };
    },
  );
}

/**
 * "Approve" (Finance or the owner, never whoever prepared or changed the run): preview (control
 * totals and acknowledged anomalies, after re-gathering the inputs), then approve, which posts
 * the payslips and locks the period. The preparer is emailed.
 */
export async function approveRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const input = formFields(formData);
  const organisationId = (await getSession())?.active?.organisationId ?? null;
  return twoStep(
    formData,
    input,
    previewApproveSpec as MutationSpec<z.ZodType, CapabilityPreview>,
    approveRunSpec as MutationSpec<z.ZodType, { runId: string; decisionId: string }>,
    (r) => {
      if (organisationId) after(() => notifyRunDecided(organisationId, r.decisionId));
      revalidatePath(PAYROLL_PATH);
      revalidatePath(`${PAYROLL_PATH}/${r.runId}`);
      return {
        ok: true,
        status: 200,
        message: "Approved. The payslips are posted and the period is locked.",
      };
    },
  );
}
