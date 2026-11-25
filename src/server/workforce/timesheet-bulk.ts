import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { periodFor } from "@/lib/timesheets/minutes";
import {
  LIST_BULK_LIMIT,
  confirmSelection,
  expectedDigestSchema,
  idSet,
  idsSchema,
  previewedSet,
  resolveSelection,
  type PreviewedSet,
} from "@/server/identity/bulk-selection";
import type { MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

import {
  TIMESHEET_DECIDERS,
  fromApprovalDbError,
  runApproveClean,
  type CleanResult,
} from "./timesheet-approval";
import { toReviewDay, type ReviewDay } from "./timesheet-review-data";
import { loadTimesheetSettings } from "./timesheets-data";

/**
 * "Approve selected" on the timesheet list (slice U.2): the days ticked in one pay period, through
 * 4.3's public.approve_clean_timesheet_lines. That function checks each day exactly as a single
 * approval does (the caller's scope: the worker's line manager, ops_manager, admin or owner;
 * never their own day; posted periods per 5.3's lock, pending days there are paid as arrears) and
 * approves only the clean ones: a flagged day, one that needs its time checked, a disputed or
 * running one, or one already decided is SKIPPED with its reason, not failed. At most 500 days.
 *
 * The preview is the same function's dry run; the confirm sends the preview's digest and is
 * refused (MLLB3) when the ticked days now resolve differently. A day the caller can't read
 * (another company's, outside their scope, or gone) refuses the request (MLLB2). Each approval
 * writes its insert-only decision and Work Unit (audited by the row triggers); the run adds one
 * `timesheet.clean_approved` row with the counts.
 */

type Client = SupabaseClient<Database>;

const selection = {
  /** Any day in the pay period the list shows. */
  period: z.iso.date("Choose a period"),
  lineIds: idsSchema(LIST_BULK_LIMIT, "days"),
};

export const previewBulkTimesheetSchema = z.object(selection);
export const bulkApproveTimesheetSchema = z.object({
  ...selection,
  expectedDigest: expectedDigestSchema,
});

/** The period's days the caller can read (public.timesheet_review_days decides who sees which). */
export async function loadPeriodDays(
  supabase: Client,
  organisationId: string,
  date: string,
): Promise<{ timeZone: string; days: ReviewDay[] }> {
  const settings = await loadTimesheetSettings(supabase, organisationId);
  const period = periodFor(date, settings.payCycleStartDay);
  const { data, error } = await supabase.rpc("timesheet_review_days", {
    p_organisation_id: organisationId,
    p_from: period.start,
    p_to: period.end,
  });
  if (error) fromApprovalDbError(error);
  return { timeZone: settings.timeZone, days: (data ?? []).map(toReviewDay) };
}

export interface BulkTimesheetResult extends CleanResult {
  /** Send `selection.digest` back with the confirm. */
  selection: PreviewedSet;
}

export const previewBulkTimesheetSpec: MutationSpec<
  typeof previewBulkTimesheetSchema,
  BulkTimesheetResult
> = {
  module: "shifts",
  schema: previewBulkTimesheetSchema,
  roles: TIMESHEET_DECIDERS,
  run: async ({ supabase, organisationId, data }) => {
    const { days } = await loadPeriodDays(supabase, organisationId, data.period);
    const ids = resolveSelection(data.lineIds, idSet(days.map((d) => d.id)));
    const result = await runApproveClean(supabase, organisationId, ids, true);
    return { ...result, selection: previewedSet(ids) };
  },
};

export const bulkApproveTimesheetSpec: MutationSpec<
  typeof bulkApproveTimesheetSchema,
  BulkTimesheetResult
> = {
  module: "shifts",
  schema: bulkApproveTimesheetSchema,
  roles: TIMESHEET_DECIDERS,
  run: async ({ supabase, organisationId, data }) => {
    const { days } = await loadPeriodDays(supabase, organisationId, data.period);
    const ids = confirmSelection(data.lineIds, idSet(days.map((d) => d.id)), data.expectedDigest);
    const result = await runApproveClean(supabase, organisationId, ids, false);
    return { ...result, selection: previewedSet(ids) };
  },
  // The function writes the decisions, Work Units and the batch's audit row in its transaction.
};
