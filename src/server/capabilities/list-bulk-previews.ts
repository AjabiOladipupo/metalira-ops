import "server-only";

import { bulkSummary, LEAVE_SKIP_TEXT, TIMESHEET_SKIP_TEXT } from "@/lib/bulk-approve";
import { previewInviteBulkSpec, type inviteBulkSchema } from "@/server/identity/worker-invite-bulk";
import { previewBulkLeaveSpec, type bulkApproveLeaveSchema } from "@/server/people/leave-bulk";
import {
  previewBulkTimesheetSpec,
  type bulkApproveTimesheetSchema,
} from "@/server/workforce/timesheet-bulk";

import type { PreviewFn } from "./types";

/**
 * Previews for the lists' bulk actions (slice U.2): the same dry runs the screen's confirm step
 * shows, "N will be approved, M skipped" with each skipped item's reason. Names, staff IDs and
 * dates only; no personal data.
 */

export const previewBulkTimesheet: PreviewFn<typeof bulkApproveTimesheetSchema> = async (ctx) => {
  const p = await previewBulkTimesheetSpec.run(ctx);
  return {
    summary: bulkSummary(
      p.approved.length,
      p.refused.map((r) => TIMESHEET_SKIP_TEXT[r.code]),
      { verb: "approved" },
    ),
    changes: [
      ...p.approved.map((a) => ({
        label: `${a.workerName ?? "Unnamed"} · ${a.workDate}`,
        before: "Needs decision",
        after: "Approved",
      })),
      ...p.refused.map((r) => ({
        label: `${r.workerName ?? "A day you can't see"}${r.workDate ? ` · ${r.workDate}` : ""}`,
        after: `Skipped: ${TIMESHEET_SKIP_TEXT[r.code]}`,
      })),
    ],
  };
};

export const previewBulkLeave: PreviewFn<typeof bulkApproveLeaveSchema> = async (ctx) => {
  const p = await previewBulkLeaveSpec.run(ctx);
  return {
    summary: bulkSummary(
      p.approved.length,
      p.skipped.map((s) => LEAVE_SKIP_TEXT[s.code]),
      { verb: "approved" },
    ),
    changes: [
      ...p.approved.map((a) => ({
        label: `${a.workerName ?? "Unnamed"} · ${a.leaveType} ${a.startDate} to ${a.endDate}`,
        before: a.step === "hr" ? "With HR" : "With line manager",
        after: a.step === "hr" ? "Approved" : "With HR",
      })),
      ...p.skipped.map((s) => ({
        label: `${s.workerName ?? "A request you can't decide"} · ${s.leaveType} ${s.startDate} to ${s.endDate}`,
        after: `Skipped: ${s.reason}`,
      })),
    ],
  };
};

export const previewInviteBulk: PreviewFn<typeof inviteBulkSchema> = async (ctx) => {
  const p = await previewInviteBulkSpec.run(ctx);
  const resend = p.action === "resend";
  return {
    summary: bulkSummary(
      p.done.length,
      p.skipped.map((s) => s.reason),
      { verb: resend ? "emailed" : "cancelled" },
    ),
    changes: [
      ...p.done.map((w) => ({
        label: `${w.name ?? "Unnamed"} · ${w.staffId ?? ""}`,
        after: resend ? "A fresh invite emailed" : "Invite cancelled",
      })),
      ...p.skipped.map((w) => ({
        label: `${w.name ?? "Unnamed"} · ${w.staffId ?? ""}`,
        after: `Skipped: ${w.reason}`,
      })),
    ],
  };
};
