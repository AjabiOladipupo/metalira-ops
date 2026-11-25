"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { errorTag } from "./error-tag";
import { addFinalPayItemSpec, finalPayItemSchema, previewAddFinalPayItem } from "./final-pay";
import {
  HOLIDAY_PAY_EDITORS,
  holidayPaySchema,
  previewSetHolidayPay,
  setHolidayPaySpec,
} from "./holiday-pay";
import type { RunFormState } from "./run-actions";
import { PAYROLL_PREPARERS } from "./runs";

/**
 * Server Actions for slice 5.9c: a final-pay item on a final-pay run, and the company's holiday pay
 * multiplier. Each is two presses: the first (`intent` not "save") runs the preview without
 * writing, the second makes the change through `mutate()` (role, module, Zod, then one SQL
 * function as the user). Registered in src/server/capabilities/registry.ts.
 */

const FAILED = "That was not saved. Try again in a minute.";

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
  console.error("payroll_leavers.save_failed:", errorTag(cause));
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

const previewFinalPaySpec = previewSpec(
  finalPayItemSchema,
  PAYROLL_PREPARERS,
  previewAddFinalPayItem,
);
const previewHolidayPaySpec = previewSpec(
  holidayPaySchema,
  HOLIDAY_PAY_EDITORS,
  previewSetHolidayPay,
);

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

/** "Add a final-pay item": preview (the worker's net before and after), then add and recalculate. */
export async function addFinalPayItemAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewFinalPaySpec as MutationSpec<z.ZodType, CapabilityPreview>,
    addFinalPayItemSpec as MutationSpec<z.ZodType, { runId: string }>,
    (r) => {
      revalidatePath(`/app/payroll/${r.runId}`);
      return { ok: true, status: 200, message: "Added and recalculated" };
    },
  );
}

/** Settings > Payroll rules: a new holiday pay multiplier from tomorrow or later. */
export async function setHolidayPayAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  return twoStep(
    formData,
    previewHolidayPaySpec as MutationSpec<z.ZodType, CapabilityPreview>,
    setHolidayPaySpec as MutationSpec<z.ZodType, { id: string; effectiveFrom: string }>,
    () => {
      revalidatePath("/app/settings/payroll");
      return {
        ok: true,
        status: 200,
        message: "Holiday pay rate saved. Days worked before it starts keep the rate of the day.",
      };
    },
  );
}
