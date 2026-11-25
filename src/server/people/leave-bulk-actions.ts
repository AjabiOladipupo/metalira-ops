"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { bulkSummary, NOT_IN_PREVIEW } from "@/lib/bulk-approve";
import { listBulkRefusal, type ListBulkResult } from "@/server/identity/bulk-action-result";
import { mutate } from "@/server/identity/mutate";
import { getSession } from "@/server/identity/session";

import {
  bulkApproveLeaveSpec,
  leaveSkipGroup,
  previewBulkLeaveSpec,
  type BulkLeaveResult,
} from "./leave-bulk";
import { notifyOpsOfOpenedShifts } from "./leave-cover-notice";
import { notifyLeaveDeciders, notifyWorkerOfLeave } from "./leave-notices";

/**
 * Server Actions for "Approve selected" on /app/leave (slice U.2). Each goes through `mutate()`;
 * the database runs the single decision for every request. Notices go after the response, one
 * request at a time, exactly as each single decision sends them; a failed notice never undoes an
 * approval.
 */

export async function previewBulkLeaveAction(
  input: unknown,
): Promise<ListBulkResult<BulkLeaveResult>> {
  try {
    return { ok: true, value: await mutate(previewBulkLeaveSpec, input) };
  } catch (error) {
    return listBulkRefusal(error, "leave.bulk_preview_failed");
  }
}

export async function bulkApproveLeaveAction(
  input: unknown,
): Promise<ListBulkResult<BulkLeaveResult>> {
  let result: BulkLeaveResult;
  try {
    result = await mutate(bulkApproveLeaveSpec, input);
  } catch (error) {
    return listBulkRefusal(error, "leave.bulk_approve_failed");
  }
  const organisationId = (await getSession())?.active?.organisationId ?? null;
  if (organisationId && result.approved.length > 0) {
    const approved = result.approved;
    after(async () => {
      for (const a of approved) {
        if (a.step === "line_manager") {
          await notifyWorkerOfLeave(organisationId, a.id, "line_manager_approved");
          await notifyLeaveDeciders(organisationId, a.id, "hr");
        } else {
          await notifyWorkerOfLeave(organisationId, a.id, "hr_approved", {
            balanceAfter: a.balanceAfter ?? undefined,
          });
          if (a.openedShifts > 0) await notifyOpsOfOpenedShifts(organisationId, a.id);
        }
      }
    });
  }
  revalidatePath("/app/leave");
  revalidatePath("/app/team");
  revalidatePath("/m/team");
  if (result.approved.some((a) => a.openedShifts > 0)) revalidatePath("/app/roster");
  return {
    ok: true,
    value: result,
    message: bulkSummary(
      result.approved.length,
      [...result.skipped.map(leaveSkipGroup), ...result.notInPreview.map(() => NOT_IN_PREVIEW)],
      {
        verb: "approved",
        done: true,
      },
    ),
  };
}
