import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * Removes bank files that should no longer exist (slice 5.4, security review M2). Bank files hold
 * account numbers, so they never linger:
 *   - a file at the bank-file path shape ({organisation_id}/{run_id}/{batch_id}.csv) that no batch
 *     names, 15 minutes after it was stored (the server stores then records within seconds; a
 *     refusal deletes it at once, so only a crash or a failed delete leaves one);
 *   - the file of a batch voided 7 days ago or more (downloads of a voided file are refused).
 * `private.payroll_files_due` picks them (the secret key only; other paths in the bucket are never
 * matched); Storage refuses deletes in SQL, so removal goes through the Storage API with the secret
 * key, and each company's sweep is written to its audit log (`payroll.bank_files_swept`, the paths
 * only). Runs after each bank file is made (that company) and daily from /api/cron/contract-documents (beside 5.6's receipt sweep)
 * (every company): Phase 5 adds no cron of its own. Paths are never logged; errors by name only.
 */

type Client = SupabaseClient<Database>;

export const PAYROLL_FILES_BUCKET = "payroll-files";

const PASS = 500;
const MAX_PASSES = 10;
const REMOVE_CHUNK = 100;

export interface PayrollFileSweepResult {
  removed: number;
}

/** One pass of up to PASS files; returns how many were removed. */
async function sweepPass(admin: Client, organisationId: string | null): Promise<number> {
  const { data, error } = await admin.rpc("payroll_files_due", {
    ...(organisationId ? { p_organisation_id: organisationId } : {}),
    p_limit: PASS,
  });
  if (error) throw new Error(`Could not list bank files to sweep (${error.code})`);
  const due = data ?? [];
  const byOrg = new Map<string, string[]>();
  for (const row of due) {
    const paths = byOrg.get(row.organisation_id) ?? [];
    paths.push(row.path);
    byOrg.set(row.organisation_id, paths);
  }
  for (const [org, paths] of byOrg) {
    for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
      const chunk = paths.slice(i, i + REMOVE_CHUNK);
      const { error: removeError } = await admin.storage.from(PAYROLL_FILES_BUCKET).remove(chunk);
      if (removeError) throw new Error(`Could not remove bank files (${removeError.name})`);
      const { error: auditError } = await admin.rpc("record_payroll_file_sweep", {
        p_organisation_id: org,
        p_paths: chunk,
      });
      if (auditError) throw new Error(`Could not record the bank file sweep (${auditError.code})`);
    }
  }
  return due.length;
}

/** Removes every bank file due, for one company or (null) every company. */
export async function sweepPayrollFiles(
  admin: Client,
  organisationId: string | null = null,
): Promise<PayrollFileSweepResult> {
  let removed = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const n = await sweepPass(admin, organisationId);
    removed += n;
    if (n < PASS) break;
  }
  return { removed };
}

/** The daily run (Vercel Cron, through /api/cron/contract-documents). */
export async function runPayrollFileSweep(): Promise<PayrollFileSweepResult> {
  return sweepPayrollFiles(createAdminSupabase());
}
