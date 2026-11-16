import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { constantTimeEqual } from "@/lib/crypto/constant-time";
import { IMPORTS_BUCKET } from "@/lib/people-import";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * Removes import uploads the import flow never got to (slice 1.8). The flow removes a file on
 * every way out of a check, and again on a later check, commit and cancel; what is left is an
 * upload whose check never ran (the tab closed after the upload) or whose removal failed.
 * Uploads hold NIN, bank account numbers and RSA PINs in clear, so they never stay long:
 *   - a batch past `uploaded` (checked, committed or cancelled) needs its file no more;
 *   - a batch still `uploaded` an hour after it was created is not being checked any more.
 * Removal goes through the Storage API with the secret key (Storage refuses deletes in SQL,
 * and removing only the storage.objects row would leave the file behind), across every
 * organisation, then `file_removed_at` is recorded. Run daily by Vercel Cron
 * (/api/cron/import-uploads); in the database, pg_cron cancels batches still `uploaded` after
 * 24 hours and clears their encrypted personal data (private.expire_import_batches).
 */

type Client = SupabaseClient<Database>;

/** An upload still `uploaded` after this long is no longer being checked. */
export const STALE_UPLOAD_MS = 60 * 60 * 1000;

/** Batches handled per pass, and objects per Storage remove call. */
const PASS = 500;
const REMOVE_CHUNK = 100;
/** Passes per run, so a run always ends. */
const MAX_PASSES = 20;

export interface SweepResult {
  removed: number;
}

/** One pass: up to PASS uploads due for removal, oldest first. */
async function sweepPass(admin: Client, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_UPLOAD_MS).toISOString();
  const { data, error } = await admin
    .from("import_batches")
    .select("id, file_path")
    .is("file_removed_at", null)
    .or(`status.neq.uploaded,created_at.lt."${cutoff}"`)
    .order("created_at")
    .limit(PASS);
  if (error) throw new Error(`Could not list import uploads: ${error.message}`);
  const due = data ?? [];

  for (let i = 0; i < due.length; i += REMOVE_CHUNK) {
    const chunk = due.slice(i, i + REMOVE_CHUNK);
    const { error: removeError } = await admin.storage
      .from(IMPORTS_BUCKET)
      .remove(chunk.map((batch) => batch.file_path));
    if (removeError) throw new Error(`Could not remove import uploads: ${removeError.message}`);
    // The secret key sees every object: whatever wasn't removed wasn't there.
    const { error: updateError } = await admin
      .from("import_batches")
      .update({ file_removed_at: now.toISOString() })
      .in(
        "id",
        chunk.map((batch) => batch.id),
      )
      .is("file_removed_at", null);
    if (updateError) {
      throw new Error(`Could not record removed import uploads: ${updateError.message}`);
    }
  }
  return due.length;
}

/** Removes every upload due for removal; `admin` must be a secret-key client. */
export async function sweepImportUploads(
  admin: Client,
  now: Date = new Date(),
): Promise<SweepResult> {
  let removed = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const count = await sweepPass(admin, now);
    removed += count;
    if (count < PASS) break;
  }
  return { removed };
}

/** The scheduled run, with the secret-key client. */
export function runImportUploadSweep(): Promise<SweepResult> {
  return sweepImportUploads(createAdminSupabase());
}

/** Below this length a configured CRON_SECRET is treated as unset, so the route stays shut. */
const MIN_SECRET_LENGTH = 16;

/**
 * True only when a strong CRON_SECRET is configured and the request carries it the way Vercel
 * Cron sends it (`Authorization: Bearer <CRON_SECRET>`), compared in constant time.
 */
export function isCronRequest(
  authorization: string | null | undefined,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;
  if (!authorization) return false;
  return constantTimeEqual(authorization, `Bearer ${secret}`);
}
