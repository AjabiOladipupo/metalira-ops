import { runCompanyBankJob } from "@/server/billing/company-bank-notices";
import { runBankChangeJob } from "@/server/people/bank-change-notices";
import { expireOnboardingSubmissions } from "@/server/people/self-onboarding-sweep";
import { isCronRequest } from "@/server/people/imports/sweep";

// Daily Vercel Cron job (vercel.json): applies bank-detail changes (slice 1.7) and company bank
// accounts (slice 2.3) whose 72-hour hold has ended, in case the database's own pg_cron jobs are
// not running, and sends the emails for each that applied. Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with the wrong one,
// every request gets an empty 404. It also closes self-onboarding submissions nobody decided
// within 14 days and clears their personal data (slice U.4, security review L4).

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const [workers, companyBank, onboardingExpired] = await Promise.all([
    runBankChangeJob(),
    runCompanyBankJob(),
    expireOnboardingSubmissions(),
  ]);
  return Response.json({ ...workers, companyBank, onboardingExpired });
}
