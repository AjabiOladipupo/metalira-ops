"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  confirmContractDocument,
  removeContractDocument,
  startContractDocument,
} from "./contract-documents";

/**
 * Server Actions for contract documents (slice 2.6). Each goes through `mutate()` (owner, admin
 * and ops_manager, Zod, the user's own client). Messages are plain English and never carry file
 * contents, object paths or links. Registered in src/server/capabilities/registry.ts.
 */

const FORBIDDEN = "Your role can't change contract documents.";
const FAILED = "That didn't work. Try again in a minute.";

function failure(error: unknown): {
  ok: false;
  message: string;
  fieldErrors?: Partial<Record<string, string>>;
} {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, message: FORBIDDEN };
    if (error.code === "invalid") {
      const field = Object.values(error.fieldErrors).find(Boolean);
      return { ok: false, message: field ?? error.message, fieldErrors: error.fieldErrors };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "contract_documents.failed:",
    cause instanceof Error ? cause.name : "unknown error",
  );
  return { ok: false, message: FAILED };
}

function refreshContract(clientId: string | undefined, contractId: string | undefined): void {
  if (
    clientId &&
    /^[0-9a-f-]{36}$/i.test(clientId) &&
    contractId &&
    /^[0-9a-f-]{36}$/i.test(contractId)
  ) {
    revalidatePath(`/app/clients/${clientId}/contracts/${contractId}`);
  }
}

export type StartDocumentResult =
  | { ok: true; documentId: string; path: string; contentType: string }
  | { ok: false; message: string; fieldErrors?: Partial<Record<string, string>> };

/** Step 1 of an upload: a pending document, and where the browser puts the file. */
export async function startContractDocumentUpload(input: {
  contractId: string;
  kind: string;
  title: string;
  fileName: string;
  size: number;
}): Promise<StartDocumentResult> {
  try {
    const started = await startContractDocument(input);
    return { ok: true, ...started };
  } catch (error) {
    return failure(error);
  }
}

/** Step 2: the file is in Storage; check its bytes and put it on file. */
export async function confirmContractDocumentUpload(input: {
  documentId: string;
  clientId: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const confirmed = await confirmContractDocument({ documentId: input.documentId });
    refreshContract(input.clientId, confirmed.contractId);
    return { ok: true };
  } catch (error) {
    const { ok, message } = failure(error);
    return { ok, message };
  }
}

/** Marks a document removed, with the reason. Its file stops opening at once. */
export async function removeContractDocumentAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  try {
    await removeContractDocument(fields);
  } catch (error) {
    const failed = failure(error);
    return {
      ok: false,
      status: error instanceof MutationError && error.code === "forbidden" ? 403 : 400,
      formError: failed.message,
      fieldErrors: failed.fieldErrors,
      values: fields,
    };
  }
  refreshContract(fields.clientId, fields.contractId);
  return { ok: true, status: 200, message: "Document removed" };
}
