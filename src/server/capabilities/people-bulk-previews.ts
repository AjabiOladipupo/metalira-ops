import "server-only";

import { BULK_MAP_MODE_TEXT, bulkMapSummary, bulkMapWhen } from "@/lib/bulk-mapping";
import { formatDate } from "@/lib/dates";
import {
  previewBulkEndSpec,
  previewBulkReassignSpec,
  type BulkEndPreview,
  type BulkReassignPreview,
  type bulkDepartmentSchema,
  type bulkEndEmploymentSchema,
  type bulkLineManagerSchema,
} from "@/server/people/bulk";
import {
  previewBulkMapSpec,
  type BulkMapPreview,
  type bulkMapSchema,
} from "@/server/people/bulk-mapping";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * Previews for the People list's bulk actions (slice U.1), the same reads the screen's confirm
 * step shows: per person, the shifts and leave left after the last working day, or the line
 * manager or department before and after. Names and staff IDs only; no personal data.
 */

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-NG")} ${n === 1 ? one : many}`;

export const FINAL_PAY_NOTE = "Final pay will be prorated in the next payroll.";

export function describeBulkEnd(preview: BulkEndPreview): CapabilityPreview {
  const refused = preview.people.filter((p) => p.refusal);
  const ending = preview.people.length - refused.length;
  const summary =
    refused.length > 0
      ? `Nobody can be ended yet: ${count(refused.length, "person", "people")} of ${preview.people.length} can't be.`
      : `Ends employment for ${count(ending, "person", "people")} on ${formatDate(preview.endDate)}. ${FINAL_PAY_NOTE}`;
  return {
    summary,
    changes: preview.people.map((p) => ({
      label: p.name ? `${p.name} · ${p.staffId ?? ""}` : "Not found",
      before: "Active",
      after:
        p.refusal ??
        [
          `Ended from ${formatDate(preview.endDate)}`,
          count(p.futureShifts, "future shift left uncovered", "future shifts left uncovered"),
          p.leaveApproved + p.leavePending > 0
            ? `leave after the date: ${p.leaveApproved} approved, ${p.leavePending} pending`
            : "no leave after the date",
        ].join("; "),
    })),
  };
}

export function describeBulkReassign(preview: BulkReassignPreview): CapabilityPreview {
  const refused = preview.people.filter((p) => p.refusal).length;
  return {
    summary:
      refused > 0 || preview.notFound > 0
        ? `Nothing can change yet: ${count(refused + preview.notFound, "person", "people")} can't be changed.`
        : `Sets the ${preview.field.toLowerCase()} of ${count(preview.people.length, "person", "people")} to ${preview.to}.`,
    changes: preview.people.map((p) => ({
      label: `${p.name} · ${p.staffId}`,
      before: p.before ?? "Not set",
      after: p.refusal ?? preview.to,
    })),
  };
}

export const previewBulkEnd: PreviewFn<typeof bulkEndEmploymentSchema> = async (ctx) =>
  describeBulkEnd(await previewBulkEndSpec.run(ctx));

export const previewBulkLineManager: PreviewFn<typeof bulkLineManagerSchema> = async (ctx) =>
  describeBulkReassign(
    await previewBulkReassignSpec.run({ ...ctx, data: { ...ctx.data, change: "line_manager" } }),
  );

export const previewBulkDepartment: PreviewFn<typeof bulkDepartmentSchema> = async (ctx) =>
  describeBulkReassign(
    await previewBulkReassignSpec.run({ ...ctx, data: { ...ctx.data, change: "department" } }),
  );

export function describeBulkMap(preview: BulkMapPreview): CapabilityPreview {
  return {
    summary: `${BULK_MAP_MODE_TEXT[preview.mode].label}: ${bulkMapSummary(preview.rows, preview.siteName)}`,
    changes: preview.rows.map((row) => ({
      label: row.name ? `${row.name} · ${row.staffId ?? ""}` : "Not found",
      before: row.before ? `${row.before.sites}; ${row.before.projects}` : "",
      after: row.after
        ? `${row.after.sites}; ${row.after.projects} (${bulkMapWhen(row)})`
        : bulkMapWhen(row),
    })),
  };
}

export const previewBulkMap: PreviewFn<typeof bulkMapSchema> = async (ctx) =>
  describeBulkMap(
    await previewBulkMapSpec.run({
      ...ctx,
      data: {
        selection: { kind: "ids", ids: ctx.data.workerIds },
        siteId: ctx.data.siteId,
        projectIds: ctx.data.projectIds,
        mode: ctx.data.mode,
      },
    }),
  );
