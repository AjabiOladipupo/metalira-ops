import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { toKobo, type Currency, type Kobo } from "@/lib/money";
import type { Database } from "@/types/db";

/**
 * Reading kobo columns (slice 1.3). The generated types in src/types/db.ts give bigint columns
 * as `number`, and PostgREST sends them as JSON numbers, so reading `basic_kobo` plainly hands
 * the caller a JavaScript number that invites `Number` arithmetic (a year of gross pay can pass
 * `Number.MAX_SAFE_INTEGER`). Kobo columns are therefore always selected cast to text
 * (`basic_kobo::text`) and turned into `bigint` with `koboFromText`. Never read a kobo column as
 * a raw `number`.
 */

type Client = SupabaseClient<Database>;
type PayType = Database["public"]["Enums"]["pay_type"];

/**
 * Whole kobo from a kobo column selected as `column::text`. Only strings are accepted, so a
 * column read without the cast fails the type check instead of slipping through as a number.
 */
export function koboFromText(value: string | null): Kobo | null {
  return value === null ? null : toKobo(value);
}

/** The pay_rates columns, with every amount cast to text for `koboFromText`. */
export const PAY_RATE_SELECT =
  "id, worker_id, pay_type, currency, effective_from, effective_to, basic_kobo::text, housing_kobo::text, transport_kobo::text, other_allowances_kobo::text, daily_rate_kobo::text, hourly_rate_kobo::text" as const;

export interface PayRateVersion {
  id: string;
  workerId: string;
  payType: PayType;
  currency: Currency;
  effectiveFrom: string;
  effectiveTo: string | null;
  basic: Kobo | null;
  housing: Kobo | null;
  transport: Kobo | null;
  otherAllowances: Kobo | null;
  dailyRate: Kobo | null;
  hourlyRate: Kobo | null;
}

interface PayRateTextRow {
  id: string;
  worker_id: string;
  pay_type: PayType;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  basic_kobo: string | null;
  housing_kobo: string | null;
  transport_kobo: string | null;
  other_allowances_kobo: string | null;
  daily_rate_kobo: string | null;
  hourly_rate_kobo: string | null;
}

export function toPayRateVersion(row: PayRateTextRow): PayRateVersion {
  if (row.currency !== "NGN") throw new Error(`Unexpected pay rate currency ${row.currency}`);
  return {
    id: row.id,
    workerId: row.worker_id,
    payType: row.pay_type,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    basic: koboFromText(row.basic_kobo),
    housing: koboFromText(row.housing_kobo),
    transport: koboFromText(row.transport_kobo),
    otherAllowances: koboFromText(row.other_allowances_kobo),
    dailyRate: koboFromText(row.daily_rate_kobo),
    hourlyRate: koboFromText(row.hourly_rate_kobo),
  };
}

/**
 * A worker's pay versions, oldest first, amounts as `bigint` kobo. Read with the caller's own
 * client, so RLS decides who sees pay (line managers see none).
 */
export async function listPayRates(
  supabase: Client,
  organisationId: string,
  workerId: string,
): Promise<PayRateVersion[]> {
  const { data, error } = await supabase
    .from("pay_rates")
    .select(PAY_RATE_SELECT)
    .eq("organisation_id", organisationId)
    .eq("worker_id", workerId)
    .order("effective_from");
  if (error) throw new Error(`Could not read pay rates: ${error.message}`);
  return (data ?? []).map(toPayRateVersion);
}
