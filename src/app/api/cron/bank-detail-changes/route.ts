import { runBankChangeJob } from "@/server/people/bank-change-notices";
import { isCronRequest } from "@/server/people/imports/sweep";

// Daily Vercel Cron job (vercel.json): applies bank-detail changes whose 72-hour hold has ended,
// in case the database's own pg_cron job is not running, and emails each worker whose change
// has applied (slice 1.7). Vercel sends `Authorization: Bearer <CRON_SECRET>`; without a
// configured secret, or with the wrong one, every request gets an empty 404.

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runBankChangeJob();
  return Response.json(result);
}
