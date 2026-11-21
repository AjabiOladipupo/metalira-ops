import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { lagosToday } from "@/lib/dates";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * The daily leave-year run (slice 4.4), by Vercel Cron at 05:00 Lagos (/api/cron/leave-year).
 * For each company with an active leave type, public.ensure_leave_year grants the year (from the
 * entitlement in force on 1 January, prorated for joiners), carries over up to each type's cap and
 * adds the adjustment of a version that came into force during the year. Idempotent, so it does
 * real work on 1 January, for new joiners and on the day a mid-year version starts, and nothing
 * otherwise. One company per database call; one company's failure never stops the others. Stops
 * before the route's time limit and says how far it got; the first read of a balance covers the
 * rest. Logs counts and error codes only.
 */

type Client = SupabaseClient<Database>;

/** Leave room under the route's 60 seconds. */
const BUDGET_MS = 50_000;

export interface LeaveYearResult {
  year: number;
  companies: number;
  failed: number;
  added: number;
  complete: boolean;
}

export async function ensureAllLeaveYears(
  admin: Client,
  year: number = Number(lagosToday().slice(0, 4)),
  now: () => number = Date.now,
): Promise<LeaveYearResult> {
  const started = now();
  const result: LeaveYearResult = { year, companies: 0, failed: 0, added: 0, complete: true };
  const { data, error } = await admin.rpc("leave_year_organisations");
  if (error) throw new Error(`Could not list companies (${error.code})`);
  for (const id of (data ?? []) as string[]) {
    if (now() - started > BUDGET_MS) {
      result.complete = false;
      return result;
    }
    const { data: added, error: yearError } = await admin.rpc("ensure_leave_year", {
      p_organisation_id: id,
      p_year: year,
    });
    if (yearError) {
      result.failed += 1;
      console.error("leave.year_company_failed:", yearError.code);
      continue;
    }
    result.companies += 1;
    result.added += Number(added ?? 0);
  }
  return result;
}

/** The scheduled run, with the secret-key client. */
export function runLeaveYearCron(): Promise<LeaveYearResult> {
  return ensureAllLeaveYears(createAdminSupabase({ channel: "system" }));
}
