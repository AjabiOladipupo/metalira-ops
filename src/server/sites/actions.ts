"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState as SiteFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  addCheckpoint,
  createSite,
  moveCheckpoint,
  renameCheckpoint,
  retireCheckpoint,
  rotateCheckpointQr,
  setGeofence,
  setSiteStatus,
  updateSite,
} from "./sites";

/**
 * Server Actions for the site screens (slice 2.2). Each goes through a helper that runs
 * `mutate()`: the caller's role in the active organisation is checked on the server (owner, admin
 * and ops_manager), the input is validated with Zod, and the write uses the caller's own client so
 * RLS applies and the audit triggers log it. Every action is registered in
 * src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't change sites.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): SiteFormState {
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
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "sites.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function refreshSites(): void {
  revalidatePath("/app/clients", "layout");
}

export async function createSiteAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  let created: { id: string; clientId: string };
  try {
    created = await createSite(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshSites();
  redirect(`/app/clients/${created.clientId}/sites/${created.id}`);
}

export async function updateSiteAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await updateSite(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshSites();
  return { ok: true, status: 200, message: "Saved" };
}

export async function setGeofenceAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await setGeofence(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshSites();
  return { ok: true, status: 200, message: "Geofence saved" };
}

export async function setSiteStatusAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await setSiteStatus(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshSites();
  return {
    ok: true,
    status: 200,
    message: fields.status === "archived" ? "Site archived" : "Site restored",
  };
}

export async function addCheckpointAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await addCheckpoint(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshSites();
  return { ok: true, status: 200, message: `${fields.name?.trim() ?? "Checkpoint"} added` };
}

export async function renameCheckpointAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await renameCheckpoint(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshSites();
  return { ok: true, status: 200, message: "Saved" };
}

export async function moveCheckpointAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await moveCheckpoint(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshSites();
  return { ok: true, status: 200, message: "Moved" };
}

export async function retireCheckpointAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await retireCheckpoint(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshSites();
  return { ok: true, status: 200, message: "Checkpoint retired" };
}

export async function rotateCheckpointQrAction(
  _prev: SiteFormState,
  formData: FormData,
): Promise<SiteFormState> {
  const fields = formFields(formData);
  try {
    await rotateCheckpointQr(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshSites();
  return {
    ok: true,
    status: 200,
    message: "New code made. Print the sheet again: the old code no longer works.",
  };
}
