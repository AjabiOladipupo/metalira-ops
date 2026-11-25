import "server-only";

import { createAdminSupabase } from "@/server/supabase/admin";

/** The private bucket for relief proofs (migration 20261122230000). */
const RELIEF_PROOFS_BUCKET = "payroll-relief-proofs";

/**
 * Deletes relief-proof uploads that never became a proof (slice 5.9a, security review M1): objects
 * in the private payroll-relief-proofs bucket at least 2 hours old that no payroll_relief_proofs
 * row names (the tab closed before the proof was recorded, or a refused file whose immediate
 * delete failed). `public.orphan_relief_proof_objects` (the secret key only) lists them; they are
 * deleted through the Storage API, because Storage refuses deletes in SQL. Run daily by the
 * existing /api/cron/contract-documents job, as 5.6's receipt sweep. Logs counts only, never paths.
 */

export const ORPHAN_PROOF_MINUTES = 120;

const PASS = 500;
const MAX_PASSES = 20;

export async function runReliefProofSweep(): Promise<{ deleted: number }> {
  const admin = createAdminSupabase();
  let deleted = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const { data, error } = await admin.rpc("orphan_relief_proof_objects", {
      p_older_than_minutes: ORPHAN_PROOF_MINUTES,
      p_limit: PASS,
    });
    if (error) throw new Error(`Could not list orphan proof uploads (${error.code})`);
    const names = (data ?? []) as string[];
    if (names.length === 0) break;
    const { error: removeError } = await admin.storage.from(RELIEF_PROOFS_BUCKET).remove(names);
    if (removeError) throw new Error(`Could not delete proof uploads (${removeError.name})`);
    deleted += names.length;
    if (names.length < PASS) break;
  }
  return { deleted };
}
