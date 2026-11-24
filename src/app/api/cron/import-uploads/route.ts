import { runPayrollFileSweep } from "@/server/payroll/payout-sweep";
import { isCronRequest, runImportUploadSweep } from "@/server/people/imports/sweep";

// Daily Vercel Cron job (vercel.json): removes employee-file uploads the import flow never got
// to. Vercel sends `Authorization: Bearer <CRON_SECRET>`; without a configured secret, or with
// the wrong one, every request gets an empty 404, so the route is not revealed.
// It also sweeps payroll bank files that should no longer exist (slice 5.4: orphans and files of
// batches voided 7 days ago), so Phase 5 adds no cron of its own.

function notFound() {
  return new Response(null, { status: 404 });
}

export async function GET(request: Request) {
  if (!isCronRequest(request.headers.get("authorization"))) {
    return notFound();
  }
  const result = await runImportUploadSweep();
  try {
    await runPayrollFileSweep();
  } catch (error) {
    // Logged by name only; the import sweep's result still answers.
    console.error(
      "payroll.bank_file_sweep_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
  }
  return Response.json(result);
}
