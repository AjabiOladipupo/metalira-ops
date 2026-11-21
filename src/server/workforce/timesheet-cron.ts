import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

/**
 * The daily timesheet refresh (slice 4.2), by Vercel Cron at 04:00 (/api/cron/timesheets).
 * For each company with Shifts on (or a clock punch in the last 3 days), rebuilds the last 7 days'
 * pending lines on the company's own clock (a missed run catches up), one company per database
 * call, in pages of 50 companies. Inside a company the database works in batches of 50 workers
 * and skips (and counts) a worker whose refresh fails, so one bad row never blocks the company. Stops before the route's time limit
 * and says how far it got; the next run, or any screen open, covers the rest. Logs counts only.
 */

type Client = SupabaseClient<Database>;

const PAGE = 50;
/** Leave room under the route's 60 seconds. */
const BUDGET_MS = 50_000;

export interface TimesheetCronResult {
  companies: number;
  failed: number;
  inserted: number;
  updated: number;
  deleted: number;
  /** Workers whose refresh failed and were skipped (inside companies that otherwise ran). */
  failedWorkers: number;
  /** The distinct SQLSTATE codes of the failures (codes only; slice 4.3, must-do 7). */
  failedCodes: string[];
  complete: boolean;
}

/** A SQLSTATE: five letters or digits, nothing else ever reaches a log. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Whether the run should show as failed on the cron dashboard (the route answers 500). */
export function cronFailed(result: TimesheetCronResult): boolean {
  return result.failed > 0 || result.failedWorkers > 0 || !result.complete;
}

export async function refreshAllTimesheets(
  admin: Client,
  now: () => number = Date.now,
): Promise<TimesheetCronResult> {
  const started = now();
  const result: TimesheetCronResult = {
    companies: 0,
    failed: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    failedWorkers: 0,
    failedCodes: [],
    complete: true,
  };
  const addCode = (code: unknown) => {
    const c = String(code ?? "");
    if (SQLSTATE.test(c) && !result.failedCodes.includes(c) && result.failedCodes.length < 20) {
      result.failedCodes.push(c);
    }
  };
  let after: string | undefined;
  for (;;) {
    const { data, error } = await admin.rpc("timesheet_cron_organisations", {
      p_limit: PAGE,
      ...(after ? { p_after: after } : {}),
    });
    if (error) throw new Error(`Could not list companies (${error.code})`);
    const ids = (data ?? []) as string[];
    for (const id of ids) {
      if (now() - started > BUDGET_MS) {
        result.complete = false;
        return result;
      }
      const { data: counts, error: refreshError } = await admin.rpc("refresh_timesheets_recent", {
        p_organisation_id: id,
      });
      if (refreshError) {
        // One company's failure never stops the others; the code only, never the company.
        result.failed += 1;
        addCode(refreshError.code);
        console.error("timesheets.cron_company_failed:", refreshError.code);
        continue;
      }
      const c = (counts ?? {}) as Record<string, unknown>;
      result.companies += 1;
      result.inserted += Number(c.inserted ?? 0);
      result.updated += Number(c.updated ?? 0);
      result.deleted += Number(c.deleted ?? 0);
      const failed = Number(c.failed ?? 0);
      if (failed > 0) {
        result.failedWorkers += failed;
        const codes = Array.isArray(c.failed_codes) ? c.failed_codes : [];
        for (const code of codes) addCode(code);
        // A count and SQLSTATE codes only, never the company or the workers.
        console.error(
          "timesheets.cron_workers_failed:",
          failed,
          codes.filter((x) => SQLSTATE.test(String(x))).join(","),
        );
      }
    }
    if (ids.length < PAGE) break;
    after = ids[ids.length - 1];
  }
  return result;
}

/** The scheduled run, with the secret-key client. */
export function runTimesheetCron(): Promise<TimesheetCronResult> {
  return refreshAllTimesheets(createAdminSupabase());
}
