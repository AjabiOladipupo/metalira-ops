import "server-only";

import { z } from "zod";

import type { BankState } from "@/lib/payroll/run";
import { sharedGroups } from "@/lib/payroll/run";
import { decryptPii, PiiDecryptError, PiiKeyError } from "@/server/crypto/pii";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * The payroll run's bank-detail checks (slice 5.2, docs/PHASE_5.md 5.2 anomalies, decision 11).
 * Server only, with the secret key: bank account numbers are encrypted at the column level and
 * no signed-in role reads the ciphertext.
 *
 * - Missing details, a change waiting for its second approver or inside the 72-hour hold, and
 *   details nobody checked against the bank ("Not checked", the first import) come from flags
 *   and dates; no number is read for them.
 * - Two workers sharing one account number: each stored number is decrypted in memory here,
 *   compared, and dropped. Nothing is stored, returned or logged but the groups of worker ids.
 *   A number that won't decrypt (wrong key, tampered row) is reported as unreadable for that
 *   worker; a missing key skips the comparison for everyone (`sharedCheck: false`).
 *
 * Never log a decrypted value, the ciphertext or the error's cause: only error names.
 */

const uuid = z.uuid();

export interface BankCheckResult {
  byWorker: Map<string, BankState>;
  /** Groups of worker ids holding the same account number. */
  shared: string[][];
  /** False when the encryption key isn't configured, so the shared-account check didn't run. */
  sharedCheck: boolean;
  /**
   * What the inputs hash includes for bank details: per worker, whether details are on file and
   * the latest change's id and status. Never a number or its last four digits.
   */
  fingerprint: Record<string, { on_file: boolean; change: string | null; checked: boolean }>;
}

const CHUNK = 200;

export async function checkBankDetails(
  organisationId: string,
  workerIds: readonly string[],
  now: Date = new Date(),
): Promise<BankCheckResult> {
  uuid.parse(organisationId);
  const ids = workerIds.filter((id) => uuid.safeParse(id).success);
  const admin = createAdminSupabase({ channel: "system" });
  const byWorker = new Map<string, BankState>();
  const fingerprint: BankCheckResult["fingerprint"] = {};
  const numbers = new Map<string, string>();
  let sharedCheck = true;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [workers, changes] = await Promise.all([
      admin
        .from("workers")
        .select("id, bank_account_enc, bank_checked_at")
        .eq("organisation_id", organisationId)
        .in("id", chunk),
      admin
        .from("bank_detail_changes")
        .select("id, worker_id, status, applies_after, created_at")
        .eq("organisation_id", organisationId)
        .in("worker_id", chunk)
        .order("created_at", { ascending: false }),
    ]);
    // The code only: messages can carry values.
    if (workers.error) throw new Error(`Could not read bank details (${workers.error.code})`);
    if (changes.error) throw new Error(`Could not read bank changes (${changes.error.code})`);

    const latestChange = new Map<string, { id: string; status: string }>();
    const holds = new Map<string, string | null>();
    for (const c of changes.data ?? []) {
      if (!latestChange.has(c.worker_id))
        latestChange.set(c.worker_id, { id: c.id, status: c.status });
      const waiting = c.status === "pending";
      const inHold =
        c.status === "approved" && c.applies_after !== null && new Date(c.applies_after) > now;
      if ((waiting || inHold) && !holds.has(c.worker_id)) {
        holds.set(c.worker_id, inHold ? c.applies_after : null);
      }
    }

    for (const w of workers.data ?? []) {
      const enc = w.bank_account_enc as string | null;
      const state: BankState = {
        missing: enc === null,
        inHold: holds.has(w.id),
        holdEndsAt: holds.get(w.id) ?? null,
        notChecked: enc !== null && w.bank_checked_at === null,
        unreadable: false,
      };
      if (enc !== null && sharedCheck) {
        try {
          const plain = decryptPii(enc, {
            organisationId,
            table: "workers",
            column: "bank_account_enc",
            rowId: w.id,
          });
          numbers.set(w.id, plain.replace(/\s+/g, ""));
        } catch (error) {
          if (error instanceof PiiKeyError) {
            sharedCheck = false;
            numbers.clear();
          } else if (error instanceof PiiDecryptError) {
            state.unreadable = true;
          } else {
            throw new Error("Bank details could not be checked");
          }
        }
      }
      byWorker.set(w.id, state);
      const change = latestChange.get(w.id);
      fingerprint[w.id] = {
        on_file: enc !== null,
        change: change ? `${change.id}:${change.status}` : null,
        checked: w.bank_checked_at !== null,
      };
    }
  }

  const shared = sharedCheck ? sharedGroups(numbers) : [];
  numbers.clear();
  return { byWorker, shared, sharedCheck, fingerprint };
}
