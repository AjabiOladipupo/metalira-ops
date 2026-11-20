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

/**
 * A resolved lookup for `userId`. By default it is written straight into the table with the
 * secret key, as a finished lookup, so suites that raise many requests don't run into the
 * lookup limits. `viaServer: true` goes through begin/finish instead (role check, limits, the
 * worker check), and throws the database's refusal with its code.
 */
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
    source?: "bank" | "sandbox" | "test";
    viaServer?: boolean;
    clientIp?: string;
  },
): Promise<MadeLookup & { usable: boolean }> {
  const bankCode = args.bankCode ?? "058";
  const digest = randomDigest();
  const source = args.source ?? "test";
  const accountName = args.accountName ?? "BANK TEST LIMITED";
  if (!args.viaServer) {
    const { data, error } = await admin
      .from("bank_account_lookups")
      .insert({
        organisation_id: args.orgId,
        requested_by: args.userId,
        purpose: args.purpose,
        worker_id: args.workerId ?? null,
        bank_code: bankCode,
        bank_account_digest: digest,
        bank_account_last4: args.last4,
        status: "resolved",
        account_name: accountName,
        source,
        finished_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return { id: data.id, digest, bankCode, last4: args.last4, usable: true };
  }
  const { data: id, error } = await admin.rpc("begin_bank_account_lookup", {
    p_organisation_id: args.orgId,
    p_user_id: args.userId,
    p_purpose: args.purpose,
    p_worker_id: (args.workerId ?? null) as string,
    p_bank_code: bankCode,
    p_bank_account_digest: digest,
    p_bank_account_last4: args.last4,
    p_client_ip: args.clientIp,
  });
  if (error || !id) {
    throw Object.assign(new Error(error?.message ?? "no lookup id"), { code: error?.code });
  }
  const finished = await admin.rpc("finish_bank_account_lookup", {
    p_id: id,
    p_status: "resolved",
    p_account_name: accountName,
    p_source: source,
  });
  if (finished.error) throw new Error(finished.error.message);
  return { id, digest, bankCode, last4: args.last4, usable: finished.data === true };
}
