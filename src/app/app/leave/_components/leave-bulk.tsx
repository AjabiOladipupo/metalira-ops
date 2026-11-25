"use client";

import { useRouter } from "next/navigation";

import { BulkPreviewSheet } from "@/components/bulk-preview-sheet";
import { ListSelectionBar } from "@/components/list-export";
import { bulkSummary, LEAVE_SKIP_TEXT } from "@/lib/bulk-approve";
import { formatLeaveRange } from "@/lib/leave/requests";
import type { BulkLeaveResult } from "@/server/people/leave-bulk";
import { bulkApproveLeaveAction, previewBulkLeaveAction } from "@/server/people/leave-bulk-actions";

const REQUESTS = { one: "request", many: "requests" };

function plan(value: BulkLeaveResult) {
  return {
    passing: value.approved.map((a) => ({
      id: a.id,
      title: a.workerName ?? "Unnamed",
      detail: `${a.leaveType} · ${formatLeaveRange(a.startDate, a.endDate)} · ${a.days} ${a.days === 1 ? "day" : "days"} · ${a.step === "hr" ? "HR approval" : "on to HR"}${a.openedShifts > 0 ? ` · ${a.openedShifts} ${a.openedShifts === 1 ? "shift" : "shifts"} back to uncovered` : ""}`,
    })),
    skipped: value.skipped.map((s) => ({
      id: s.id,
      title: s.workerName ?? "A request you can't decide",
      detail:
        s.leaveType && s.startDate && s.endDate
          ? `${s.leaveType} · ${formatLeaveRange(s.startDate, s.endDate)}`
          : undefined,
      reason: s.reason,
    })),
    summary: bulkSummary(
      value.approved.length,
      value.skipped.map((s) => LEAVE_SKIP_TEXT[s.code]),
      { verb: "approved" },
    ),
    digest: value.selection.digest,
    act: value.selection.act,
  };
}

/**
 * The Leave list's action bar (slice U.2): "Approve selected" approves each ticked request at the
 * step the caller decides (line manager first, then HR), with every single-approval check; the
 * rest are skipped with the reason. "Export CSV" for every reader.
 */
export function LeaveBulkBar({ canDecide }: { canDecide: boolean }) {
  const router = useRouter();
  return (
    <ListSelectionBar params={{ list: "leave" }} noun={REQUESTS}>
      {(ids, done) =>
        canDecide ? (
          <BulkPreviewSheet
            trigger="Approve selected"
            title="Approve selected requests"
            description="Each request gets the same checks as approving it on its own, at the step you decide. Requests that need a look first, or that you can't decide, are skipped and listed. Up to 500 at a time."
            confirmLabel={(n) => `Approve ${n} ${n === 1 ? "request" : "requests"}`}
            pendingLabel="Approving…"
            preview={() => previewBulkLeaveAction({ requestIds: ids })}
            confirm={(signed) => bulkApproveLeaveAction({ requestIds: ids, ...signed })}
            plan={plan}
            onDone={(message) => {
              done(message);
              router.refresh();
            }}
          />
        ) : null
      }
    </ListSelectionBar>
  );
}
