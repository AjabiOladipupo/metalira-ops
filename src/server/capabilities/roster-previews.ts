import "server-only";

import { formatDate } from "@/lib/dates";
import { formatShortDay } from "@/lib/roster";
import { formatChangeCounts, type PublishResult } from "@/lib/roster-publish";
import type { copyLastWeekSchema, publishRosterSchema } from "@/server/workforce/roster";
import { previewCopyLastWeek } from "@/server/workforce/roster-data";
import { previewPublishRoster } from "@/server/workforce/roster-publish-data";

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

const KIND_LABEL = { added: "Added", removed: "Taken off", changed: "Shifts changed" } as const;

/**
 * Preview for "Publish roster" (slice 3.3): publish_roster's dry run, so the confirm step shows
 * exactly who will be told. Names only; the shifts themselves are on the roster.
 */
export function describePublishPreview(result: PublishResult): CapabilityPreview {
  const week = formatDate(result.weekStart);
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const told = result.affected.length;
  let summary: string;
  if (result.nothingChanged) {
    summary = `Nothing has changed since version ${result.previousVersion ?? 0} was published for the week of ${week}.`;
  } else if (result.previousVersion === null) {
    summary = `Publishes version 1 for the week of ${week}: ${people(result.assigned)} on shifts, ${result.open} open. ${told} ${told === 1 ? "worker is" : "workers are"} told.`;
  } else {
    summary = `Publishes version ${result.version} for the week of ${week}: ${formatChangeCounts(result.counts)}. ${told === 1 ? "Only this worker is" : `Only these ${told} workers are`} told.`;
  }
  return {
    summary,
    changes: result.affected.map((a) => ({
      label: a.workerName,
      after: `${KIND_LABEL[a.kind]} · ${a.shifts.length} ${a.shifts.length === 1 ? "shift" : "shifts"} that week`,
    })),
  };
}

export const previewPublishWeek: PreviewFn<typeof publishRosterSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const result = await previewPublishRoster(supabase, organisationId, data.siteId, data.weekStart);
  return describePublishPreview(result);
};
