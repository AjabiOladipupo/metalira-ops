"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState as ClientFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  addContact,
  createClient,
  quickAddClient,
  removeContact,
  setClientStatus,
  setClientTax,
  updateClient,
  updateContact,
} from "./clients";

/**
 * Server Actions for the Clients screens and Setup step 4 (slice 2.1). Each goes through a helper
 * that runs `mutate()`: the caller's role in the active organisation is checked on the server
 * (owner, admin and ops_manager change clients; finance also changes contacts), the input is
 * validated with Zod, and the write uses the caller's own client so RLS applies and the audit
 * triggers log it. Every action is registered in src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't change clients.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): ClientFormState {
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
    "clients.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function refreshClients(): void {
  revalidatePath("/app/clients", "layout");
}

export async function createClientAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  let created: { id: string };
  try {
    created = await createClient(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClients();
  redirect(`/app/clients/${created.id}`);
}

export async function updateClientAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  let updated: { id: string };
  try {
    updated = await updateClient(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClients();
  redirect(`/app/clients/${updated.id}`);
}

export async function setClientStatusAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  try {
    await setClientStatus(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshClients();
  return {
    ok: true,
    status: 200,
    message: fields.status === "archived" ? "Client archived" : "Client restored",
  };
}

export async function addContactAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  try {
    await addContact(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClients();
  return { ok: true, status: 200, message: "Contact added" };
}

export async function updateContactAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  try {
    await updateContact(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClients();
  return { ok: true, status: 200, message: "Saved" };
}

export async function removeContactAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  try {
    await removeContact(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshClients();
  return { ok: true, status: 200, message: "Contact removed" };
}

/** Setup step 4 "Add client": stays on the step and lists the new client in its table. */
export async function quickAddClientAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  try {
    await quickAddClient(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClients();
  revalidatePath("/app/setup/clients");
  return { ok: true, status: 200, message: `${fields.name?.trim() ?? "Client"} added` };
}

/** A client's tax settings (owner, admin, finance): stays on the client page. */
export async function setClientTaxAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const fields = formFields(formData);
  try {
    await setClientTax(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClients();
  return { ok: true, status: 200, message: "Tax settings saved" };
}
