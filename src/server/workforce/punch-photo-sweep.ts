import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import { PUNCH_PHOTOS_BUCKET } from "./punches";

/**
 * Selfie retention (slice 3.5, owner decision 20 Nov 2026): selfies are deleted 90 days after
 * the punch unless the punch is under review (private.punch_under_review). The punch row stays;
 * `clear_punch_selfie` nulls its path and stamps `selfie_deleted_at`. Uploads that no punch kept
 * (an attach that failed) are deleted after a day. Files go through the Storage API with the
 * secret key (Storage refuses deletes in SQL). Daily, by Vercel Cron (/api/cron/punch-photos).
 * Logs counts only, never paths.
 */

type Client = SupabaseClient<Database>;

const PASS = 500;
const REMOVE_CHUNK = 100;
const MAX_PASSES = 20;

export interface PunchPhotoSweepResult {
  deleted: number;
  orphans: number;
}

async function expirePass(admin: Client): Promise<number> {
  const { data, error } = await admin.rpc("punch_selfies_due", { p_limit: PASS });
  if (error) throw new Error(`Could not list selfies to delete (${error.code})`);
  const due = data ?? [];
  for (let i = 0; i < due.length; i += REMOVE_CHUNK) {
    const chunk = due.slice(i, i + REMOVE_CHUNK);
    const { error: removeError } = await admin.storage
      .from(PUNCH_PHOTOS_BUCKET)
      .remove(chunk.map((row) => row.selfie_path));
    if (removeError) throw new Error(`Could not delete selfies (${removeError.name})`);
    for (const row of chunk) {
      const { error: clearError } = await admin.rpc("clear_punch_selfie", {
        p_punch_id: row.punch_id,
      });
      if (clearError) throw new Error(`Could not record a deleted selfie (${clearError.code})`);
    }
  }
  return due.length;
}

async function orphanPass(admin: Client): Promise<number> {
  const { data, error } = await admin.rpc("punch_photo_orphans", { p_limit: PASS });
  if (error) throw new Error(`Could not list unused uploads (${error.code})`);
  const names = (data ?? []) as string[];
  for (let i = 0; i < names.length; i += REMOVE_CHUNK) {
    const { error: removeError } = await admin.storage
      .from(PUNCH_PHOTOS_BUCKET)
      .remove(names.slice(i, i + REMOVE_CHUNK));
    if (removeError) throw new Error(`Could not delete unused uploads (${removeError.name})`);
  }
  return names.length;
}

/** Runs the whole sweep; `admin` must be a secret-key client. */
export async function sweepPunchPhotos(admin: Client): Promise<PunchPhotoSweepResult> {
  let deleted = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const count = await expirePass(admin);
    deleted += count;
    if (count < PASS) break;
  }
  let orphans = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const count = await orphanPass(admin);
    orphans += count;
    if (count < PASS) break;
  }
  return { deleted, orphans };
}

/** The scheduled run, with the secret-key client. */
export function runPunchPhotoSweep(): Promise<PunchPhotoSweepResult> {
  return sweepPunchPhotos(createAdminSupabase());
}
