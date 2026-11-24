import { runContractDocumentSweep } from "@/server/business/contract-document-sweep";
import { runPayrollFileSweep } from "@/server/payroll/payout-sweep";
import { runReceiptSweep } from "@/server/payroll/receipt-sweep";
import { isCronRequest } from "@/server/people/imports/sweep";

// Daily Vercel Cron job (vercel.json): deletes contract-document files that are no longer kept
// (uploads never confirmed, refused uploads, and documents removed 30 days ago), and remittance
// receipt uploads that never became a receipt (slice 5.6), and payroll bank files no batch names
// or whose batch was voided 7 days ago (slice 5.4); no new cron on Hobby. Vercel sends
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
  const receipts = await runReceiptSweep();
  let bankFilesDeleted: number | null = null;
  try {
    bankFilesDeleted = (await runPayrollFileSweep()).removed;
  } catch (error) {
    // By name only: a message could carry a path.
    console.error(
      "payroll.bank_file_sweep_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
  }
  return Response.json({ ...result, receiptUploadsDeleted: receipts.deleted, bankFilesDeleted });
}
