import "server-only";

import { formatDate } from "@/lib/dates";
import { formatShortDay } from "@/lib/roster";
import type { copyLastWeekSchema } from "@/server/workforce/roster";
import { previewCopyLastWeek } from "@/server/workforce/roster-data";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * Preview for "Copy last week" (slice 3.2). It runs the database's own copy with `p_dry_run`,
 * which does every insert and check and then rolls them back, so the preview and the copy can't
 * disagree. Worker names only; no personal data.
 */

export function describeCopyPreview(result: {
  weekStart: string;
  source: number;
  copied: number;
  already: number;
  skipped: { postName: string; date: string; workerName: string; reason: string }[];
}): CapabilityPreview {
  const week = formatDate(result.weekStart);
  const noun = (n: number) => (n === 1 ? "assignment" : "assignments");
  const parts = [`Copies ${result.copied} ${noun(result.copied)} into the week of ${week}`];
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} can't be copied`);
  if (result.already > 0) parts.push(`${result.already} already on the roster`);
  const summary =
    result.source === 0
      ? `Last week has no assignments at this site, so nothing is copied into the week of ${week}.`
      : `${parts.join("; ")}.`;
  return {
    summary,
    changes: result.skipped.map((s) => ({
      label: `${s.postName}, ${formatShortDay(s.date)}`,
      before: s.workerName,
      after: `Not copied: ${s.reason}`,
    })),
  };
}

export const previewCopyWeek: PreviewFn<typeof copyLastWeekSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const result = await previewCopyLastWeek(supabase, organisationId, data.siteId, data.weekStart);
  return describeCopyPreview(result);
};
