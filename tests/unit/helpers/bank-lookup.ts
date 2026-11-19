/**
 * A resolved account name lookup row (slice 2.3b), as a fake Supabase client returns it to
 * `takeCheckedName`. The digest is computed with the test's PII key, so stub
 * PII_ENCRYPTION_KEY before calling it.
 */
import { bankAccountDigest } from "@/server/billing/bank-lookup";

export const LOOKUP_ID = "c0000000-0000-4000-8000-0000000000aa";

export function lookupRow({
  organisationId,
  accountNumber,
  accountName,
  bankCode = "058",
  purpose = "worker_bank",
  workerId = null,
  createdAt = new Date().toISOString(),
  usedAt = null,
  source = "test",
}: {
  organisationId: string;
  accountNumber: string;
  accountName: string;
  bankCode?: string;
  purpose?: "company_bank" | "worker_bank" | "worker_check";
  workerId?: string | null;
  createdAt?: string;
  usedAt?: string | null;
  source?: "bank" | "test";
}) {
  return {
    id: LOOKUP_ID,
    status: "resolved" as const,
    purpose,
    worker_id: workerId,
    bank_code: bankCode,
    bank_account_digest: bankAccountDigest(organisationId, bankCode, accountNumber),
    account_name: accountName,
    source,
    created_at: createdAt,
    used_at: usedAt,
  };
}
