"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDate } from "@/lib/dates";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import { describeRuleSetVersion } from "@/server/capabilities/payroll-previews";
import type { CapabilityPreview } from "@/server/capabilities/types";

import type { RuleSetVersionPreview } from "./rule-sets-data";
import { addRuleSetVersionSpec, confirmRuleSetSpec, previewRuleSetVersionSpec } from "./rule-sets";

/**
 * Server Actions for Settings > Payroll rules (slice 5.0). Each goes through `mutate()` (role,
 * module, then Zod, then one SQL function as the user, which checks the role again).
 * Registered in src/server/capabilities/registry.ts.
 */

const FAILED = "That was not saved. Try again in a minute.";
const RULES_PATH = "/app/settings/payroll";

export type RuleSetFormState =
  | (NonNullable<CompanyFormState> & {
      /** The dry run's result, shown before "Save version". */
      preview?: CapabilityPreview & { unchanged: boolean };
    })
  | null;

function refusal(error: unknown, values?: Record<string, string>): RuleSetFormState {
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
    "payroll_rules.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

/**
 * "Add a version": with `intent=preview` (the first press) it runs the dry run and returns the
 * figures that change; with `intent=save` (after the preview) it adds the version.
 */
export async function addRuleSetVersionAction(
  _prev: RuleSetFormState,
  formData: FormData,
): Promise<RuleSetFormState> {
  const fields = formFields(formData);
  if (fields.intent !== "save") {
    try {
      const result = await mutate(previewRuleSetVersionSpec, fields);
      return {
        ok: true,
        status: 200,
        preview: { ...describeRuleSetVersion(result), unchanged: result.unchanged },
        values: fields,
      };
    } catch (error) {
      return refusal(error, fields);
    }
  }
  let result: RuleSetVersionPreview;
  try {
    result = await mutate(addRuleSetVersionSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(RULES_PATH);
  if (result.unchanged) {
    return {
      ok: true,
      status: 200,
      message: "Nothing changed: the figures equal the version before.",
      values: fields,
    };
  }
  redirect(`${RULES_PATH}?added=${encodeURIComponent(formatDate(result.effectiveFrom))}`);
}

/** Records the tax adviser's confirmation of a version (owner only). */
export async function confirmRuleSetAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await mutate(confirmRuleSetSpec, fields);
  } catch (error) {
    return refusal(error, fields);
  }
  revalidatePath(RULES_PATH);
  return { ok: true, status: 200, message: "Adviser's confirmation recorded" };
}
