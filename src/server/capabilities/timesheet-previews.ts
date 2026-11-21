import "server-only";

import { formatDate } from "@/lib/dates";
import { CLEAN_REFUSAL_TEXT, exceptionLabels } from "@/lib/timesheets/approval";
import { formatMinutes } from "@/lib/timesheets/minutes";
import {
  runApproveClean,
  runCorrectionPreview,
  type CleanResult,
  type CorrectionPreview,
  type approveCleanSchema,
} from "@/server/workforce/timesheet-approval";
import type { addCorrectionSchema } from "@/server/workforce/timesheets";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * Previews for timesheet writes (slice 4.3). Each runs the SQL function's own dry run (rolled
 * back inside the database), so the confirm step shows exactly what the change does. Names of
 * workers the caller may decide only; minutes, never money.
 */

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

function minutes(worked: number, ot: number): string {
  return ot > 0
    ? `${formatMinutes(worked)} worked, ${formatMinutes(ot)} overtime`
    : `${formatMinutes(worked)} worked`;
}

export function describeCleanResult(result: CleanResult): CapabilityPreview {
  const approved = result.approved.length;
  const refused = result.refused.length;
  const units = result.approved.filter((a) => a.workUnitId !== null).length;
  const billable = result.approved.filter((a) => a.billable === true).length;
  let summary = `Approves ${days(approved)}`;
  if (approved > 0) {
    summary += units > 0 ? ` and makes ${units} Work ${units === 1 ? "Unit" : "Units"}` : "";
    summary += billable > 0 ? ` (${billable} billable)` : "";
  }
  summary += refused > 0 ? `; ${days(refused)} left for you to decide one by one.` : ".";
  return {
    summary,
    changes: [
      ...result.approved.map((a) => ({
        label: `${a.workerName ?? "A worker"} · ${formatDate(a.workDate)}`,
        before: "Needs decision",
        after: `Approved · ${minutes(a.workedMinutes, a.otMinutes)}`,
      })),
      ...result.refused.map((r) => {
        const flags = r.code === "flagged" ? exceptionLabels(r.exceptions).join(", ") : "";
        return {
          label:
            r.workerName && r.workDate
              ? `${r.workerName} · ${formatDate(r.workDate)}`
              : "A day you can't see",
          after: `Not approved: ${CLEAN_REFUSAL_TEXT[r.code]}${flags ? ` (${flags})` : ""}`,
        };
      }),
    ],
  };
}

export const previewApproveClean: PreviewFn<typeof approveCleanSchema> = async ({
  supabase,
  organisationId,
  data,
}) => describeCleanResult(await runApproveClean(supabase, organisationId, data.lineIds, true));

export function describeCorrection(preview: CorrectionPreview): CapabilityPreview {
  return {
    summary: `Changes the day from ${minutes(preview.current.workedMinutes, preview.current.otMinutes)} to ${minutes(preview.next.workedMinutes, preview.next.otMinutes)}.`,
    changes: [
      {
        label: "Minutes",
        before: minutes(preview.current.workedMinutes, preview.current.otMinutes),
        after: minutes(preview.next.workedMinutes, preview.next.otMinutes),
      },
      {
        label: "Exceptions",
        before: exceptionLabels(preview.current.exceptions).join(", ") || "None",
        after: exceptionLabels(preview.next.exceptions).join(", ") || "None",
      },
    ],
  };
}

export const previewCorrection: PreviewFn<typeof addCorrectionSchema> = async ({
  supabase,
  organisationId,
  data,
}) => describeCorrection(await runCorrectionPreview(supabase, organisationId, data));
