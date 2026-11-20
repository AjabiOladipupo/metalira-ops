import { runContractDocumentSweep } from "@/server/business/contract-document-sweep";
import { isCronRequest } from "@/server/people/imports/sweep";

// Daily Vercel Cron job (vercel.json): deletes contract-document files that are no longer kept
// (uploads never confirmed, refused uploads, and documents removed 30 days ago). Vercel sends
// `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with the wrong one,
// every request gets an empty 404, so the route is not revealed.

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runContractDocumentSweep();
  return Response.json(result);
}
