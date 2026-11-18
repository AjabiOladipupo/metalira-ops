"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { setupStepHref, type SetupSlug } from "@/lib/company";

import { LOGO_MAX_BYTES } from "./company";
import type { CompanyFormState } from "./company-form-state";
import {
  advanceSetupSpec,
  completeSetupSpec,
  saveBusinessSpec,
  saveInvoicesSpec,
  savePlanSpec,
  uploadLogoSpec,
} from "./company-mutations";
import { MutationError, mutate, type MutationSpec } from "./mutate";
import { formFields } from "./schemas";

/**
 * Server Actions for the setup wizard (/app/setup) and company settings
 * (/app/settings/company). Each one authorises (owner or admin of the active organisation),
 * validates and writes through mutate(); the database checks the role again and logs every
 * change to audit_log. A refused role gets a "forbidden" result, never a partial save.
 */

const FORBIDDEN = "Only an owner or an admin can change company settings.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): CompanyFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, status: 403, formError: FORBIDDEN, values };
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
  console.error(
    "company.save_failed:",
    error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

/** Shows the change everywhere: the wizard rail, settings, and the logo and name in the shell. */
function refreshApp(): void {
  revalidatePath("/app", "layout");
}

async function saveStep<S extends z.ZodType>(
  spec: MutationSpec<S, void>,
  formData: FormData,
  next: SetupSlug,
): Promise<CompanyFormState> {
  const values = formFields(formData);
  const advance = values.advance === "yes";
  try {
    await mutate(spec, values);
  } catch (error) {
    return refusal(error, values);
  }
  refreshApp();
  if (advance) redirect(setupStepHref(next));
  return { ok: true, status: 200, message: "Saved" };
}

export async function savePlan(_prev: CompanyFormState, formData: FormData) {
  return saveStep(savePlanSpec, formData, "business");
}

export async function saveBusiness(_prev: CompanyFormState, formData: FormData) {
  return saveStep(saveBusinessSpec, formData, "invoices");
}

export async function saveInvoices(_prev: CompanyFormState, formData: FormData) {
  return saveStep(saveInvoicesSpec, formData, "clients");
}

/** Step 4 Continue. */
export async function continueFromClients(): Promise<CompanyFormState> {
  try {
    await mutate(advanceSetupSpec, { step: "clients" });
  } catch (error) {
    return refusal(error);
  }
  refreshApp();
  redirect(setupStepHref("employees"));
}

/** Step 5 Continue: marks setup complete and shows Ready. */
export async function finishSetup(): Promise<CompanyFormState> {
  try {
    await mutate(completeSetupSpec, {});
  } catch (error) {
    return refusal(error);
  }
  refreshApp();
  redirect(setupStepHref("ready"));
}

export async function uploadLogo(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) {
    const message = "Choose a PNG or SVG file.";
    return { ok: false, status: 400, formError: message, fieldErrors: { logo: message } };
  }
  if (file.size > LOGO_MAX_BYTES) {
    const message = "The logo must be under 1 MB.";
    return { ok: false, status: 400, formError: message, fieldErrors: { logo: message } };
  }
  try {
    await mutate(uploadLogoSpec, { file: new Uint8Array(await file.arrayBuffer()) });
  } catch (error) {
    return refusal(error);
  }
  refreshApp();
  return { ok: true, status: 200, message: "Logo saved" };
}
