"use server";

import { revalidatePath } from "next/cache";

import { bulkSummary, NOT_IN_PREVIEW, TIMESHEET_SKIP_TEXT } from "@/lib/bulk-approve";
import { listBulkRefusal, type ListBulkResult } from "@/server/identity/bulk-action-result";
import { mutate } from "@/server/identity/mutate";

import {
  bulkApproveTimesheetSpec,
  previewBulkTimesheetSpec,
  type BulkTimesheetResult,
} from "./timesheet-bulk";

/**
 * Server Actions for "Approve selected" on /app/timesheets (slice U.2). Each goes through
 * `mutate()` (role, Zod, the caller's own client); the database checks every day again.
 */

export async function previewBulkTimesheetAction(
  input: unknown,
): Promise<ListBulkResult<BulkTimesheetResult>> {
  try {
    return { ok: true, value: await mutate(previewBulkTimesheetSpec, input) };
  } catch (error) {
    return listBulkRefusal(error, "timesheets.bulk_preview_failed");
  }
}

export async function bulkApproveTimesheetAction(
  input: unknown,
): Promise<ListBulkResult<BulkTimesheetResult>> {
  try {
    const result = await mutate(bulkApproveTimesheetSpec, input);
    revalidatePath("/app/timesheets");
    return {
      ok: true,
      value: result,
      message: bulkSummary(
        result.approved.length,
        [
          ...result.refused.map((r) => TIMESHEET_SKIP_TEXT[r.code]),
          ...result.notInPreview.map(() => NOT_IN_PREVIEW),
        ],
        { verb: "approved", done: true },
      ),
    };
  } catch (error) {
    return listBulkRefusal(error, "timesheets.bulk_approve_failed");
  }
}
