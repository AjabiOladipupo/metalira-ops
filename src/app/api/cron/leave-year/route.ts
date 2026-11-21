import { isCronRequest } from "@/server/people/imports/sweep";
import { runLeaveYearCron } from "@/server/people/leave-year";

// Daily Vercel Cron job (vercel.json, 05:00 Lagos): grants each company's leave year, carries
// over and adds mid-year entitlement changes. Vercel sends `Authorization: Bearer <CRON_SECRET>`;
// without a configured secret, or with the wrong one, every request gets an empty 404, so the
// route is not revealed.

/** Seconds the run may take: it stops at 50 and reports how far it got. */
export const maxDuration = 60;

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runLeaveYearCron();
  return Response.json(result);
}
