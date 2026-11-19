/**
 * Account name lookups for the RLS suite (slice 2.3b). The server writes them with the secret
 * key (begin_bank_account_lookup, finish_bank_account_lookup); these helpers do the same, with a
 * random digest standing in for the server's keyed HMAC of the number.
 */
import { randomBytes } from "node:crypto";

import type { Database } from "@/types/db";

import type { Client } from "./supabase";

type Purpose = Database["public"]["Enums"]["bank_lookup_purpose"];

export interface MadeLookup {
  id: string;
  digest: string;
  bankCode: string;
  last4: string;
}

export const randomDigest = () => randomBytes(32).toString("hex");

/** A resolved lookup for `userId`, or the database's refusal (role, limits) as an error. */
export async function makeLookup(
  admin: Client,
  args: {
    orgId: string;
    userId: string;
    purpose: Purpose;
    workerId?: string | null;
    last4: string;
    bankCode?: string;
    accountName?: string;
  },
): Promise<MadeLookup> {
  const bankCode = args.bankCode ?? "058";
  const digest = randomDigest();
  const { data: id, error } = await admin.rpc("begin_bank_account_lookup", {
    p_organisation_id: args.orgId,
    p_user_id: args.userId,
    p_purpose: args.purpose,
    p_worker_id: (args.workerId ?? null) as string,
    p_bank_code: bankCode,
    p_bank_account_digest: digest,
    p_bank_account_last4: args.last4,
  });
  if (error || !id)
    throw Object.assign(new Error(error?.message ?? "no lookup id"), { code: error?.code });
  const finished = await admin.rpc("finish_bank_account_lookup", {
    p_id: id,
    p_status: "resolved",
    p_account_name: args.accountName ?? "BANK TEST LIMITED",
    p_source: "test",
  });
  if (finished.error) throw new Error(finished.error.message);
  return { id, digest, bankCode, last4: args.last4 };
}
