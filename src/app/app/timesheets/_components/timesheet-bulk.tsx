"use client";

import { useRouter } from "next/navigation";

import { BulkPreviewSheet } from "@/components/bulk-preview-sheet";
import { ListSelectionBar } from "@/components/list-export";
import { bulkSummary, TIMESHEET_SKIP_TEXT } from "@/lib/bulk-approve";
import { formatShortDay } from "@/lib/roster";
import { exceptionLabels } from "@/lib/timesheets/approval";
import { formatMinutes } from "@/lib/timesheets/minutes";
import type { BulkTimesheetResult } from "@/server/workforce/timesheet-bulk";
import {
  bulkApproveTimesheetAction,
  previewBulkTimesheetAction,
} from "@/server/workforce/timesheet-bulk-actions";

const DAYS = { one: "day", many: "days" };

function plan(value: BulkTimesheetResult) {
  return {
    passing: value.approved.map((a) => ({
      id: a.lineId,
      title: a.workerName ?? "Unnamed",
      detail: `${formatShortDay(a.workDate)} · ${formatMinutes(a.workedMinutes)}${a.otMinutes > 0 ? ` + ${formatMinutes(a.otMinutes)} overtime` : ""}`,
    })),
    skipped: value.refused.map((r) => ({
      id: r.lineId,
      title: r.workerName ?? "A day you can't see",
      detail: r.workDate ? formatShortDay(r.workDate) : undefined,
      reason:
        TIMESHEET_SKIP_TEXT[r.code] +
        (r.code === "flagged" && r.exceptions.length > 0
          ? ` (${exceptionLabels(r.exceptions).join(", ")})`
          : ""),
    })),
    summary: bulkSummary(
      value.approved.length,
      value.refused.map((r) => TIMESHEET_SKIP_TEXT[r.code]),
      { verb: "approved" },
    ),
    digest: value.selection.digest,
  };
}

/**
 * The timesheet list's action bar (slice U.2): "Approve selected" for the roles that decide days
 * (each day passes the single approval's checks; flagged ones and the rest are skipped with the
 * reason) and "Export CSV" for every reader.
 */
export function TimesheetBulkBar({ period, canDecide }: { period: string; canDecide: boolean }) {
  const router = useRouter();
  return (
    <ListSelectionBar params={{ list: "timesheets", period }} noun={DAYS}>
      {(ids, done) =>
        canDecide ? (
          <BulkPreviewSheet
            trigger="Approve selected"
            title="Approve selected days"
            description="Each day gets the same checks as approving it on its own. Flagged days, days that need their time checked and days you can't decide are skipped and listed. Up to 500 at a time."
            confirmLabel={(n) => `Approve ${n} ${n === 1 ? "day" : "days"}`}
            pendingLabel="Approving…"
            preview={() => previewBulkTimesheetAction({ period, lineIds: ids })}
            confirm={(expectedDigest) =>
              bulkApproveTimesheetAction({ period, lineIds: ids, expectedDigest })
            }
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
