import { isCronRequest } from "@/server/people/imports/sweep";
import { cronFailed, runTimesheetCron } from "@/server/workforce/timesheet-cron";

// Daily Vercel Cron job (vercel.json, 04:00 Lagos): rebuilds the last 7 days' timesheet days from
// punches for every company with Shifts on. Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with the wrong one,
// every request gets an empty 404, so the route is not revealed.

/** Seconds the refresh may run: it stops at 50 and reports how far it got. */
export const maxDuration = 60;

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runTimesheetCron();
  // Slice 4.3 (must-do 7): a run with failures, or one that stopped early, answers 500 so the
  // Vercel cron dashboard shows it. Counts and SQLSTATE codes only; never a company or worker.
  if (cronFailed(result)) {
    console.error(
      "timesheets.cron_incomplete:",
      `failed=${result.failed}`,
      `workers=${result.failedWorkers}`,
      `complete=${result.complete}`,
      `codes=${result.failedCodes.join(",")}`,
    );
    return Response.json(result, { status: 500 });
  }
  return Response.json(result);
}
