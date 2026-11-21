import { isCronRequest } from "@/server/people/imports/sweep";
import { runQueryReminders } from "@/server/people/query-reminders";

// Daily Vercel Cron job (vercel.json, 06:00): reminds each worker the day before a query's
// reply-by date while it still awaits their reply (slice 4.6), by inbox and by email within the
// caps. Vercel sends `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with
// the wrong one, every request gets an empty 404, so the route is not revealed.

/** Seconds the run may take: up to 3 passes of 100 notices, 4 at a time. */
export const maxDuration = 60;

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runQueryReminders();
  return Response.json(result);
}
