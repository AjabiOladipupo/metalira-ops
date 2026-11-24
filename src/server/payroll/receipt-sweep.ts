import "server-only";

import { PAYROLL_EVIDENCE_BUCKET } from "@/lib/payroll/receipts";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * Deletes remittance receipt uploads that never became a receipt (slice 5.6, security review L2):
 * objects in the private payroll-evidence bucket at least 2 hours old that no statutory_receipts
 * row names (the tab closed before the payment was recorded, or a refused file whose immediate
 * delete failed). `public.orphan_statutory_receipt_objects` (the secret key only) lists them;
 * they are deleted through the Storage API, because Storage refuses deletes in SQL. Run daily by
 * the existing /api/cron/contract-documents job (no new cron; docs/PHASE_5.md "Crons stay daily").
 * Logs counts only, never paths.
 */

export const ORPHAN_RECEIPT_MINUTES = 120;

const PASS = 500;
const MAX_PASSES = 20;

export async function runReceiptSweep(): Promise<{ deleted: number }> {
  const admin = createAdminSupabase();
  let deleted = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const { data, error } = await admin.rpc("orphan_statutory_receipt_objects", {
      p_older_than_minutes: ORPHAN_RECEIPT_MINUTES,
      p_limit: PASS,
    });
    if (error) throw new Error(`Could not list orphan receipt uploads (${error.code})`);
    const names = (data ?? []) as string[];
    if (names.length === 0) break;
    const { error: removeError } = await admin.storage.from(PAYROLL_EVIDENCE_BUCKET).remove(names);
    if (removeError) throw new Error(`Could not delete receipt uploads (${removeError.name})`);
    deleted += names.length;
    if (names.length < PASS) break;
  }
  return { deleted };
}
