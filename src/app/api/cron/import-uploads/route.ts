import { isCronRequest, runImportUploadSweep } from "@/server/people/imports/sweep";

// Daily Vercel Cron job (vercel.json): removes employee-file uploads the import flow never got
// to. Vercel sends `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with
// the wrong one, every request gets an empty 404, so the route is not revealed.

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runImportUploadSweep();
  return Response.json(result);
}
