import "server-only";

import { createHash } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  CONTRACT_DOCS_BUCKET,
  DOCUMENT_KINDS,
  DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  SIGNED_URL_SECONDS,
  checkUploadedBytes,
  extensionOf,
  sanitiseFileName,
  titleFromFileName,
  type DocumentExt,
} from "@/lib/contract-documents";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { plainText } from "@/server/identity/names";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import { CONTRACT_EDITORS } from "./contracts";

/**
 * Contract documents (slice 2.6). An upload is three steps (migration 20261119145000):
 * 1. `startContractDocumentSpec` inserts a pending row as the user (owner, admin, ops_manager);
 *    the database fixes the object path from the row's ids.
 * 2. The browser uploads the file straight to the private `contract-docs` bucket at that path
 *    (Storage takes it only for the user's own pending row).
 * 3. `confirmContractDocumentSpec` reads the object back as the user, checks its type from its
 *    magic bytes and its size, works out its sha256 and only then calls
 *    `confirm_contract_document` with the secret key, naming the verified user as the actor; the
 *    database re-checks the actor's role, that they uploaded it and the object in Storage, and
 *    marks the row active. Signed-in users can't call confirm or reject themselves. A file that
 *    fails is marked rejected and deleted with the secret key. Nothing a user sends picks the
 *    object or the actor: the path is the row's own and the actor is the session's.
 * Removing marks the row removed with a reason; the file stops opening at once and is deleted
 * 30 days later by the sweep. Opening makes a 60-second signed URL after an RLS-checked read.
 * File contents, signed URLs and object paths are never logged.
 */

type Client = SupabaseClient<Database>;

const documentId = z.uuid("Choose a document");

const title = plainText(
  z.string().trim().max(200, "The title must be 200 characters or fewer"),
  "Title",
);

export const startContractDocumentSchema = z.object({
  contractId: z.uuid("Choose a contract"),
  kind: z.enum(DOCUMENT_KINDS, "Choose what kind of document this is"),
  title: z
    .string()
    .optional()
    .transform((value) => value ?? "")
    .pipe(title),
  fileName: z
    .string()
    .trim()
    .min(1, "Choose a file.")
    .max(255, "Rename the file to something shorter and upload it again.")
    .refine((name) => extensionOf(name) !== null, "Upload a PDF, PNG or JPEG file."),
  size: z.coerce
    .number()
    .int()
    .min(1, "The file is empty. Choose another.")
    .max(MAX_DOCUMENT_BYTES, "The file is larger than 10 MB. Upload a smaller copy."),
});

export const contractDocumentIdSchema = z.object({ documentId });

export const removeContractDocumentSchema = z.object({
  documentId,
  reason: plainText(
    z
      .string()
      .trim()
      .min(1, "Say why the document is being removed")
      .max(500, "The reason must be 500 characters or fewer"),
    "Reason",
  ),
});

/** Database refusals in plain English. */
export function fromDocumentDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't change contract documents.");
  }
  if (error.code === "23503" || error.code === "MLCD1") {
    throw new MutationError("invalid", "That contract or document wasn't found. Reload the page.");
  }
  if (/^MLCD\d$/.test(error.code)) {
    throw new MutationError("invalid", error.message);
  }
  if (error.code === "22023" || error.code === "23514") {
    throw new MutationError("invalid", "Check the highlighted fields.");
  }
  throw new Error(`Database refused the change (${error.code})`);
}

// ---------------------------------------------------------------------------
// 1. Start
// ---------------------------------------------------------------------------

export interface StartedDocument {
  documentId: string;
  path: string;
  contentType: string;
}

export const startContractDocumentSpec: MutationSpec<
  typeof startContractDocumentSchema,
  StartedDocument
> = {
  schema: startContractDocumentSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const ext = extensionOf(data.fileName) as DocumentExt;
    const fileName = sanitiseFileName(data.fileName, ext);
    const { data: row, error } = await supabase
      .from("contract_documents")
      .insert({
        organisation_id: organisationId,
        contract_id: data.contractId,
        kind: data.kind,
        title: data.title || titleFromFileName(fileName),
        file_name: fileName,
        file_ext: ext,
        mime_type: DOCUMENT_TYPES[ext].mime,
      })
      .select("id, storage_path")
      .single();
    if (error) fromDocumentDbError(error);
    return { documentId: row.id, path: row.storage_path, contentType: DOCUMENT_TYPES[ext].mime };
  },
};

export function startContractDocument(input: unknown) {
  return mutate(startContractDocumentSpec, input);
}

// ---------------------------------------------------------------------------
// 2. Confirm
// ---------------------------------------------------------------------------

/** Deletes a rejected upload. A failure is left for the sweep, by error name only. */
async function deleteRejectedObject(path: string): Promise<void> {
  try {
    const { error } = await createAdminSupabase().storage.from(CONTRACT_DOCS_BUCKET).remove([path]);
    if (error) throw error;
  } catch (cause) {
    console.error(
      "contract_documents.reject_cleanup_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
  }
}

/**
 * Marks the actor's pending upload rejected and deletes its file. Secret key only (the database
 * refuses signed-in users), naming the actor `mutate()` verified; the database re-checks their
 * role and that they uploaded it.
 */
async function reject(
  organisationId: string,
  actor: string,
  documentId: string,
  path: string,
): Promise<void> {
  const { error } = await createAdminSupabase().rpc("reject_contract_document", {
    p_organisation_id: organisationId,
    p_document_id: documentId,
    p_actor: actor,
  });
  if (error) fromDocumentDbError(error);
  await deleteRejectedObject(path);
}

export interface ConfirmedDocument {
  documentId: string;
  contractId: string;
}

export const confirmContractDocumentSpec: MutationSpec<
  typeof contractDocumentIdSchema,
  ConfirmedDocument
> = {
  schema: contractDocumentIdSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const { data: row, error } = await supabase
      .from("contract_documents")
      .select("id, contract_id, status, storage_path, file_ext, uploaded_by")
      .eq("organisation_id", organisationId)
      .eq("id", data.documentId)
      .maybeSingle();
    if (error) fromDocumentDbError(error);
    if (!row || row.uploaded_by !== userId) {
      throw new MutationError("invalid", "That upload wasn't found. Choose the file again.");
    }
    if (row.status === "active") return { documentId: row.id, contractId: row.contract_id };
    if (row.status !== "pending") {
      throw new MutationError("invalid", "That upload was refused. Choose the file again.");
    }

    const download = await supabase.storage.from(CONTRACT_DOCS_BUCKET).download(row.storage_path);
    if (download.error || !download.data) {
      await reject(organisationId, userId, row.id, row.storage_path);
      throw new MutationError("invalid", "The upload didn't arrive. Choose the file again.");
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const check = checkUploadedBytes(bytes, row.file_ext as DocumentExt);
    if (!check.ok) {
      await reject(organisationId, userId, row.id, row.storage_path);
      throw new MutationError("invalid", check.message);
    }

    // Only now, with the bytes checked, does the row become active: confirm is secret-key only,
    // so a signed-in user can't skip this check. The actor is the user mutate() verified.
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { error: confirmError } = await createAdminSupabase().rpc("confirm_contract_document", {
      p_organisation_id: organisationId,
      p_document_id: row.id,
      p_actor: userId,
      p_size_bytes: bytes.length,
      p_sha256: sha256,
    });
    if (confirmError) {
      if (confirmError.code === "MLCD3") {
        await reject(organisationId, userId, row.id, row.storage_path);
      }
      fromDocumentDbError(confirmError);
    }
    return { documentId: row.id, contractId: row.contract_id };
  },
};

export function confirmContractDocument(input: unknown) {
  return mutate(confirmContractDocumentSpec, input);
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export const removeContractDocumentSpec: MutationSpec<
  typeof removeContractDocumentSchema,
  { documentId: string }
> = {
  schema: removeContractDocumentSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("remove_contract_document", {
      p_organisation_id: organisationId,
      p_document_id: data.documentId,
      p_reason: data.reason,
    });
    if (error) fromDocumentDbError(error);
    return { documentId: data.documentId };
  },
};

export function removeContractDocument(input: unknown) {
  return mutate(removeContractDocumentSpec, input);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export type DocumentLink =
  | { ok: true; url: string; fileName: string; mimeType: string; contractId: string }
  | { ok: false; reason: "not_found" | "removed" };

/**
 * A 60-second signed URL for an active document, made with the user's own client after reading
 * the row under RLS: Storage signs it only when its select policy lets the user read the object
 * (owner, admin, finance or ops_manager of the company, active rows only). `download` asks the
 * browser to save the file under its name instead of showing it. `contractId` and `clientId`
 * (from the page's URL) must be the document's contract and that contract's client. Never log
 * the URL.
 */
export async function contractDocumentLink(
  supabase: Client,
  organisationId: string,
  documentId: string,
  options: { download?: boolean; contractId?: string; clientId?: string } = {},
): Promise<DocumentLink> {
  const isId = (value: string | undefined) =>
    value === undefined || z.uuid().safeParse(value).success;
  if (
    !z.uuid().safeParse(documentId).success ||
    !isId(options.contractId) ||
    !isId(options.clientId)
  ) {
    return { ok: false, reason: "not_found" };
  }
  if (options.clientId !== undefined) {
    if (options.contractId === undefined) return { ok: false, reason: "not_found" };
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("id")
      .eq("organisation_id", organisationId)
      .eq("id", options.contractId)
      .eq("client_id", options.clientId)
      .maybeSingle();
    if (contractError) throw new Error(`Could not read the contract (${contractError.code})`);
    if (!contract) return { ok: false, reason: "not_found" };
  }
  let query = supabase
    .from("contract_documents")
    .select("contract_id, status, storage_path, file_name, mime_type")
    .eq("organisation_id", organisationId)
    .eq("id", documentId);
  if (options.contractId !== undefined) query = query.eq("contract_id", options.contractId);
  const { data: row, error } = await query.maybeSingle();
  if (error) throw new Error(`Could not read the document (${error.code})`);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "active") return { ok: false, reason: "removed" };
  const { data, error: signError } = await supabase.storage
    .from(CONTRACT_DOCS_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_SECONDS, {
      download: options.download ? row.file_name : false,
    });
  if (signError || !data?.signedUrl) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    url: data.signedUrl,
    fileName: row.file_name,
    mimeType: row.mime_type,
    contractId: row.contract_id,
  };
}
