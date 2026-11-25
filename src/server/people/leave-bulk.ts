import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import {
  LEAVE_SKIP_TEXT,
  leaveSkipCode,
  leaveSkipReason,
  type LeaveSkipCode,
} from "@/lib/bulk-approve";
import { lagosToday } from "@/lib/dates";
import type { ManagerRole } from "@/lib/roles";
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
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";

import { loadLeaveBoard } from "./leave-data";

/**
 * "Approve selected" on the Leave list (slice U.2): each ticked request is approved at the step
 * the caller may decide (the line manager's step 1, HR's step 2) by public.bulk_approve_leave,
 * which runs the single decision itself for each one, so every request passes exactly the checks
 * a single approval does (never your own, line manager and supervisor scope, balance,
 * certificate, the working-day count, the posted-period rules as 5.7c left them).
 *
 * Not all or nothing: a request that would fail a check, or that needs a look first (a
 * certificate nobody has seen, a changed day count, paid leave the service doesn't pay), is
 * SKIPPED and listed with its reason; the rest are approved. The preview is the same function's
 * dry run. The confirm sends the preview's digest and is refused (MLLB3) when the ticked requests
 * now resolve differently; a request the caller can't read refuses the request (MLLB2). At most
 * 500. Each approval writes the single decision's rows and audit row; the run adds
 * `leave.bulk_approved`. The worker (and HR, after step 1; ops, for shifts the leave opened) are
 * told afterwards, as for a single decision.
 */

/** Who may open "Approve selected": step 1's and step 2's roles; the database narrows it. */
export const LEAVE_BULK_DECIDERS = [
  "owner",
  "admin",
  "hr",
  "ops_manager",
  "line_manager",
] as const satisfies readonly ManagerRole[];

export const previewBulkLeaveSchema = z.object({
  requestIds: idsSchema(LIST_BULK_LIMIT, "requests"),
});

export const bulkApproveLeaveSchema = previewBulkLeaveSchema.extend({
  expectedDigest: expectedDigestSchema,
});

export interface BulkLeaveApproved {
  id: string;
  workerId: string;
  workerName: string | null;
  staffId: string | null;
  leaveType: string;
  startDate: string;
  endDate: string;
  step: "line_manager" | "hr";
  /** pending_hr after step 1, approved after step 2. */
  status: string;
  days: number;
  balanceAfter: number | null;
  openedShifts: number;
}

export interface BulkLeaveSkipped {
  id: string;
  code: LeaveSkipCode;
  /** In words, with the single decision's own reason when it refused. */
  reason: string;
  /** Null for a request outside the caller's scope. */
  workerName: string | null;
  staffId: string | null;
  leaveType: string;
  startDate: string;
  endDate: string;
}

export interface BulkLeaveResult {
  dryRun: boolean;
  approved: BulkLeaveApproved[];
  skipped: BulkLeaveSkipped[];
  /** Send `selection.digest` back with the confirm. */
  selection: PreviewedSet;
}

const approvedRow = z.object({
  id: z.string(),
  worker_id: z.string(),
  worker_name: z.string().nullable(),
  staff_id: z.string().nullable(),
  leave_type: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  step: z.enum(["line_manager", "hr"]),
  status: z.string().nullable(),
  days: z.number(),
  balance_after: z.number().nullable(),
  opened_shifts: z.number(),
});

const skippedRow = z.object({
  id: z.string(),
  code: z.string(),
  reason: z.string().nullable(),
  worker_name: z.string().nullable(),
  staff_id: z.string().nullable(),
  leave_type: z.string(),
  start_date: z.string(),
  end_date: z.string(),
});

const resultSchema = z.object({
  dry_run: z.boolean(),
  approved: z.array(approvedRow),
  skipped: z.array(skippedRow),
});

export function parseBulkLeave(value: unknown): Omit<BulkLeaveResult, "selection"> {
  const r = resultSchema.parse(value);
  return {
    dryRun: r.dry_run,
    approved: r.approved.map((a) => ({
      id: a.id,
      workerId: a.worker_id,
      workerName: a.worker_name,
      staffId: a.staff_id,
      leaveType: a.leave_type,
      startDate: a.start_date,
      endDate: a.end_date,
      step: a.step,
      status: a.status ?? (a.step === "hr" ? "approved" : "pending_hr"),
      days: a.days,
      balanceAfter: a.balance_after,
      openedShifts: a.opened_shifts,
    })),
    skipped: r.skipped.map((s) => {
      const code = leaveSkipCode(s.code);
      return {
        id: s.id,
        code,
        reason: leaveSkipReason(code, s.reason),
        workerName: s.worker_name,
        staffId: s.staff_id,
        leaveType: s.leave_type,
        startDate: s.start_date,
        endDate: s.end_date,
      };
    }),
  };
}

/** The summary's reason for a skipped request: the code's words, so counts group. */
export function leaveSkipGroup(s: Pick<BulkLeaveSkipped, "code">): string {
  return LEAVE_SKIP_TEXT[s.code];
}

function fromDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't decide leave.");
  }
  if (error.code === "MLLB1" || error.code === "MLLB2") {
    throw new MutationError("invalid", error.message, { selection: error.message });
  }
  throw new Error(`Database refused the change (${error.code})`);
}

/** The requests the Leave list shows the caller (public.leave_request_list decides who sees which). */
async function visibleRequests(ctx: Pick<MutationContext, "supabase" | "organisationId">) {
  const board = await loadLeaveBoard(ctx.supabase, ctx.organisationId, lagosToday());
  return idSet(board.requests.map((r) => r.id));
}

async function run(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  ids: string[],
  dryRun: boolean,
): Promise<BulkLeaveResult> {
  const { data, error } = await ctx.supabase.rpc("bulk_approve_leave", {
    p_organisation_id: ctx.organisationId,
    p_request_ids: ids,
    p_dry_run: dryRun,
  });
  if (error) fromDbError(error);
  return { ...parseBulkLeave(data), selection: previewedSet(ids) };
}

export const previewBulkLeaveSpec: MutationSpec<typeof previewBulkLeaveSchema, BulkLeaveResult> = {
  module: "people",
  schema: previewBulkLeaveSchema,
  roles: LEAVE_BULK_DECIDERS,
  run: async (ctx) => {
    const ids = resolveSelection(ctx.data.requestIds, await visibleRequests(ctx));
    return run(ctx, ids, true);
  },
};

export const bulkApproveLeaveSpec: MutationSpec<typeof bulkApproveLeaveSchema, BulkLeaveResult> = {
  module: "people",
  schema: bulkApproveLeaveSchema,
  roles: LEAVE_BULK_DECIDERS,
  run: async (ctx) => {
    const ids = confirmSelection(
      ctx.data.requestIds,
      await visibleRequests(ctx),
      ctx.data.expectedDigest,
    );
    return run(ctx, ids, false);
  },
  // Each single decision writes its audit row; the function adds the batch's row.
};
