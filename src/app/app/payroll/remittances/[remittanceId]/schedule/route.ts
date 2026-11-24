import { MutationError, mutate } from "@/server/identity/mutate";
import { scheduleFileSpec } from "@/server/payroll/remittances";

/**
 * Downloads one remittance's statutory schedule (slice 5.6; security review M1). `mutate()`
 * checks the signed-in user (owner, hr or finance of the active company, Payroll on), the
 * remittance is read under RLS, RSA PINs are decrypted on the server and the CSV is streamed in
 * this response only: never stored, `no-store`, saved as an attachment. The download is audited
 * as `payroll.schedule_downloaded` with the remittance id. Nothing here is logged.
 */

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ remittanceId: string }> },
) {
  const { remittanceId } = await params;
  let file;
  try {
    file = await mutate(scheduleFileSpec, { remittanceId });
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") return plain("Sign in to download schedules.", 401);
      if (error.code === "forbidden") return plain(error.message, 403);
      // A voided remittance (its run was reversed, slice 5.7a) is a refusal, not a missing page.
      if (error.code === "invalid" && error.fieldErrors.remittance === "voided") {
        return plain(error.message, 400);
      }
      if (error.code === "invalid") return plain(error.message, 404);
    }
    console.error(
      "statutory_schedule.failed:",
      error instanceof MutationError && error.cause instanceof Error
        ? error.cause.name
        : "unknown error",
    );
    return plain("The schedule couldn't be made. Try again in a minute.", 500);
  }
  return new Response(file.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
