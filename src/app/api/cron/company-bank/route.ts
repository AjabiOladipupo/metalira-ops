import { runCompanyBankJob } from "@/server/billing/company-bank-notices";
import { isCronRequest } from "@/server/people/imports/sweep";

// Vercel Cron, every 15 minutes (vercel.json): applies company bank accounts whose 72-hour hold
// has ended and sends every company bank account email that is due (slice 2.3). The emails are a
// sweep over the rows, so a request or approval made straight against the Data API is still
// announced within 15 minutes, while the hold can still be stopped. Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with the wrong one,
// every request gets an empty 404.

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  return Response.json(await runCompanyBankJob());
}
