import "server-only";

import { queryReminderNotice } from "@/lib/queries";
import { createAdminSupabase } from "@/server/supabase/admin";
import { notifyWorker } from "@/server/workforce/notify";

/**
 * The daily query reminder (slice 4.6): one inbox item, and an email within notifyWorker's caps
 * (30 a company, 80 overall in 24 hours), the day before a query's reply-by date while it still
 * awaits the worker's reply. Run by Vercel Cron at 06:00 (/api/cron/query-reminders).
 *
 * public.claim_staff_query_reminders stamps each query as it hands it out, so a query is reminded
 * once even if two runs overlap; a notice that then fails is counted and not retried (the worker
 * still sees the query and its date in the app). Chunked: up to 100 a pass, at most 3 passes a
 * run (300 reminders, inside the route's 60 seconds), 4 notices at a time. Past 300 due on one
 * day the rest get no reminder (their query and reply-by date still show in the app); the email
 * caps would skip their emails anyway. Logs counts and error names only, never names or text.
 */

const PASS = 100;
const MAX_PASSES = 3;
const CONCURRENCY = 4;

export interface QueryReminderResult {
  claimed: number;
  told: number;
  emailed: number;
  capped: number;
  failed: number;
}

export async function runQueryReminders(): Promise<QueryReminderResult> {
  const admin = createAdminSupabase({ channel: "system" });
  const result: QueryReminderResult = { claimed: 0, told: 0, emailed: 0, capped: 0, failed: 0 };

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const { data, error } = await admin.rpc("claim_staff_query_reminders", { p_limit: PASS });
    if (error) throw new Error(`Could not claim query reminders (${error.code})`);
    const due = data ?? [];
    result.claimed += due.length;
    const queue = [...due];

    async function worker() {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const sent = await notifyWorker(
            next.organisation_id,
            next.worker_id,
            queryReminderNotice({ subject: next.subject, replyBy: next.reply_by }),
          );
          result.told += 1;
          if (sent.email === "sent") result.emailed += 1;
          else if (sent.email === "skipped_cap") result.capped += 1;
        } catch (error) {
          result.failed += 1;
          console.error(
            "people.query_reminder_failed:",
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    if (due.length < PASS) break;
  }
  return result;
}
