import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { CONTRACT_DOCS_BUCKET } from "@/lib/contract-documents";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * Deletes contract-document files that are no longer kept (slice 2.6), across every company,
 * through the Storage API with the secret key (Storage refuses deletes in SQL, and removing only
 * the storage.objects row would leave the file behind). The rows stay forever; the sweep stamps
 * `file_deleted_at`.
 *   - An upload still `pending` an hour after it started was never confirmed (the tab closed):
 *     it is marked `rejected`.
 *   - A `rejected` upload's file is deleted (the server deletes it at once; this catches
 *     failures).
 *   - A `removed` document's file is deleted 30 days after it was removed.
 * Run daily by Vercel Cron (/api/cron/contract-documents, `Authorization: Bearer $CRON_SECRET`).
 * Logs counts only, never paths.
 */

type Client = SupabaseClient<Database>;

export const STALE_PENDING_MS = 60 * 60 * 1000;
export const REMOVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const PASS = 500;
const REMOVE_CHUNK = 100;
const MAX_PASSES = 20;

export interface DocumentSweepResult {
  expired: number;
  deleted: number;
}

async function expirePending(admin: Client, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PENDING_MS).toISOString();
  const { data, error } = await admin
    .from("contract_documents")
    .update({ status: "rejected" })
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .select("id");
  if (error) throw new Error(`Could not expire pending documents (${error.code})`);
  return (data ?? []).length;
}

async function deletePass(admin: Client, now: Date): Promise<number> {
  const removedCutoff = new Date(now.getTime() - REMOVED_KEEP_MS).toISOString();
  const { data, error } = await admin
    .from("contract_documents")
    .select("id, storage_path")
    .is("file_deleted_at", null)
    .or(`status.eq.rejected,and(status.eq.removed,removed_at.lt."${removedCutoff}")`)
    .order("created_at")
    .limit(PASS);
  if (error) throw new Error(`Could not list documents to delete (${error.code})`);
  const due = data ?? [];

  for (let i = 0; i < due.length; i += REMOVE_CHUNK) {
    const chunk = due.slice(i, i + REMOVE_CHUNK);
    const { error: removeError } = await admin.storage
      .from(CONTRACT_DOCS_BUCKET)
      .remove(chunk.map((d) => d.storage_path));
    if (removeError) throw new Error(`Could not delete document files (${removeError.name})`);
    // The secret key sees every object: whatever wasn't removed wasn't there.
    const { error: updateError } = await admin
      .from("contract_documents")
      .update({ file_deleted_at: now.toISOString() })
      .in(
        "id",
        chunk.map((d) => d.id),
      )
      .is("file_deleted_at", null);
    if (updateError) throw new Error(`Could not record deleted files (${updateError.code})`);
  }
  return due.length;
}

/** Runs the whole sweep; `admin` must be a secret-key client. */
export async function sweepContractDocuments(
  admin: Client,
  now: Date = new Date(),
): Promise<DocumentSweepResult> {
  const expired = await expirePending(admin, now);
  let deleted = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const count = await deletePass(admin, now);
    deleted += count;
    if (count < PASS) break;
  }
  return { expired, deleted };
}

/** The scheduled run, with the secret-key client. */
export function runContractDocumentSweep(): Promise<DocumentSweepResult> {
  return sweepContractDocuments(createAdminSupabase());
}
