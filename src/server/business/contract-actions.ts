"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState as ContractFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  addRateCardVersion,
  cancelRateCardVersion,
  createContract,
  saveDraftRateCard,
  updateContract,
} from "./contracts";

/**
 * Server Actions for contracts and rate cards (slice 2.4). Each goes through a helper
 * that runs `mutate()`: the caller's role is checked on the server, the input is validated with
 * Zod, and the write uses the caller's own client (the rate functions check the role again in
 * the database). Every action is registered in src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't change contracts or rates.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): ContractFormState {
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
    "contracts.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

/** The form's fields, with the ticked sites as a list. */
function contractInput(formData: FormData) {
  const fields = formFields(formData);
  const siteIds = formData.getAll("siteIds").filter((v): v is string => typeof v === "string");
  return { fields, input: { ...fields, siteIds } };
}

function refreshClient(clientId: string | undefined): void {
  revalidatePath("/app/clients", "layout");
  if (clientId) revalidatePath(`/app/clients/${clientId}`, "layout");
}

function contractPath(clientId: string, contractId: string, tab?: string): string {
  return `/app/clients/${clientId}/contracts/${contractId}${tab ? `?tab=${tab}` : ""}`;
}

/** A client id from a hidden field, only when it looks like one (it builds the redirect). */
function clientIdOf(fields: Record<string, string>): string {
  const id = fields.clientId ?? "";
  return /^[0-9a-f-]{36}$/i.test(id) ? id : "";
}

export async function createContractAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const { fields, input } = contractInput(formData);
  let created: { id: string; clientId: string };
  try {
    created = await createContract(input);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClient(created.clientId);
  redirect(contractPath(created.clientId, created.id, "rates"));
}

export async function updateContractAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const { fields, input } = contractInput(formData);
  const clientId = clientIdOf(fields);
  let updated: { id: string };
  try {
    updated = await updateContract(input);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClient(clientId);
  redirect(clientId ? contractPath(clientId, updated.id) : "/app/clients");
}

/** Saves the rate card of a draft contract, replacing what was there. */
export async function saveDraftRateCardAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const fields = formFields(formData);
  const clientId = clientIdOf(fields);
  try {
    await saveDraftRateCard(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClient(clientId);
  redirect(clientId ? contractPath(clientId, fields.contractId ?? "", "rates") : "/app/clients");
}

/** "Change rates from": adds a dated version and closes the current one the day before. */
export async function addRateCardVersionAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const fields = formFields(formData);
  const clientId = clientIdOf(fields);
  try {
    await addRateCardVersion(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshClient(clientId);
  redirect(clientId ? contractPath(clientId, fields.contractId ?? "", "rates") : "/app/clients");
}

export async function cancelRateCardVersionAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const fields = formFields(formData);
  try {
    await cancelRateCardVersion(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshClient(clientIdOf(fields));
  return { ok: true, status: 200, message: "Rate change cancelled" };
}
