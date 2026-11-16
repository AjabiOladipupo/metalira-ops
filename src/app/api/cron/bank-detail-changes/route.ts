import { checkCronRequest } from "@/server/cron/auth";
import { runBankChangeJob } from "@/server/people/bank-change-notices";

/**
 * Daily job (vercel.json): applies bank-detail changes whose 72-hour hold has ended, in case the
 * database's own pg_cron job is not running, and emails each worker whose change has applied
 * (slice 1.7). Only Vercel Cron, with the CRON_SECRET bearer token, may call it.
 */
export async function GET(request: Request) {
  const access = checkCronRequest(request.headers.get("authorization"));
  if (access === "not_configured") return new Response(null, { status: 503 });
  if (access !== "ok") return new Response(null, { status: 401 });
  const result = await runBankChangeJob();
  return Response.json(result);
}
