import { isCronRequest } from "@/server/people/imports/sweep";
import { runPunchPhotoSweep } from "@/server/workforce/punch-photo-sweep";

// Daily Vercel Cron job (vercel.json): deletes clock-in selfies 90 days after the punch unless
// the punch is under review, and uploads no punch kept. Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with the wrong one,
// every request gets an empty 404, so the route is not revealed.

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runPunchPhotoSweep();
  return Response.json(result);
}
