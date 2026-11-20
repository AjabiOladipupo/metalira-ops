import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { isoWeekday } from "@/lib/headcount";
import type { ManagerRole } from "@/lib/roles";
import { toPublishResult, type PublishResult } from "@/lib/roster-publish";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";

/**
 * Roster writes (slice 3.2), as `mutate()` specs. Each is one SQL function run with the signed-in
 * user's own client: `assign_worker_to_shift`, `remove_assignment` and `copy_last_week` check the
 * caller's role in the database (owner, admin, ops_manager, trusted sessions only), and the
 * guard on `shift_assignments` refuses, for every path, an ended worker, a closed post, an
 * archived site, a day that has passed, a full shift and an overlapping shift. Shifts and
 * assignments have no write grants; the audit triggers record every row change.
 */

/** Who builds rosters (NAV "Roster"). */
export const ROSTER_EDITORS: readonly ManagerRole[] = ["owner", "admin", "ops_manager"];

export function canEditRoster(role: ManagerRole): boolean {
  return ROSTER_EDITORS.includes(role);
}

const NO_URL = /:\/\/|www\./i;

export const assignShiftSchema = z.object({
  postId: z.uuid("Choose a post"),
  date: z.iso.date("Choose a day"),
  workerId: z.uuid("Choose an employee"),
});

export const removeAssignmentSchema = z.object({
  assignmentId: z.uuid("Choose an assignment"),
  reason: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ?? "").replace(/\s+/g, " ").trim())
    .refine((v) => v.length <= 500, "500 characters or fewer")
    .refine((v) => /^[^\p{Cc}<>]*$/u.test(v), "Plain text only")
    .refine((v) => !NO_URL.test(v), "Leave out web addresses"),
});

export const copyLastWeekSchema = z.object({
  siteId: z.uuid("Choose a site"),
  weekStart: z.iso
    .date("Choose a week")
    .refine((v) => isoWeekday(v) === 1, "A roster week starts on a Monday"),
});

/** Database refusals in plain English. */
export function fromRosterDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't change rosters.");
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  }
  if (error.code === "40P01" || error.code === "40001") {
    throw new MutationError(
      "invalid",
      "Someone else changed this roster at the same time. Try again.",
    );
  }
  if (error.code === "23P01") {
    throw new MutationError("invalid", "This employee is already on an overlapping shift.");
  }
  if (error.code === "23505") {
    throw new MutationError("invalid", "This employee is already on this shift.");
  }
  if (/^MLR[SP]\d$/.test(error.code) || error.code === "22023") {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface AssignResult {
  assignmentId: string;
  shiftId: string;
  mapped: boolean;
}

export const assignShiftSpec: MutationSpec<typeof assignShiftSchema, AssignResult> = {
  schema: assignShiftSchema,
  roles: ROSTER_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("assign_worker_to_shift", {
      p_organisation_id: organisationId,
      p_post_id: data.postId,
      p_shift_date: data.date,
      p_worker_id: data.workerId,
    });
    if (error) fromRosterDbError(error);
    const r = record(result);
    return {
      assignmentId: String(r.assignment_id ?? ""),
      shiftId: String(r.shift_id ?? ""),
      mapped: r.mapped === true,
    };
  },
};

export const removeAssignmentSpec: MutationSpec<
  typeof removeAssignmentSchema,
  { assignmentId: string }
> = {
  schema: removeAssignmentSchema,
  roles: ROSTER_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("remove_assignment", {
      p_organisation_id: organisationId,
      p_assignment_id: data.assignmentId,
      ...(data.reason ? { p_reason: data.reason } : {}),
    });
    if (error) fromRosterDbError(error);
    return { assignmentId: data.assignmentId };
  },
};

export interface CopySkip {
  postId: string;
  postName: string;
  date: string;
  workerId: string;
  workerName: string;
  code: string;
  reason: string;
}

export interface CopyWeekResult {
  weekStart: string;
  /** Assignments in the week before. */
  source: number;
  copied: number;
  /** Already on the roster this week (not copied twice). */
  already: number;
  skipped: CopySkip[];
  dryRun: boolean;
}

export function toCopyWeekResult(value: unknown, weekStart: string): CopyWeekResult {
  const r = record(value);
  const skipped = Array.isArray(r.skipped) ? r.skipped : [];
  return {
    weekStart: typeof r.week_start === "string" ? r.week_start : weekStart,
    source: Number(r.source ?? 0),
    copied: Number(r.copied ?? 0),
    already: Number(r.already ?? 0),
    dryRun: r.dry_run === true,
    skipped: skipped.map((item) => {
      const s = record(item);
      return {
        postId: String(s.post_id ?? ""),
        postName: String(s.post_name ?? ""),
        date: String(s.shift_date ?? ""),
        workerId: String(s.worker_id ?? ""),
        workerName: String(s.worker_name ?? ""),
        code: String(s.code ?? ""),
        reason: String(s.reason ?? ""),
      };
    }),
  };
}

export const copyLastWeekSpec: MutationSpec<typeof copyLastWeekSchema, CopyWeekResult> = {
  schema: copyLastWeekSchema,
  roles: ROSTER_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("copy_last_week", {
      p_organisation_id: organisationId,
      p_site_id: data.siteId,
      p_week_start: data.weekStart,
      p_dry_run: false,
    });
    if (error) fromRosterDbError(error);
    return toCopyWeekResult(result, data.weekStart);
  },
};

export const publishRosterSchema = z.object({
  siteId: z.uuid("Choose a site"),
  weekStart: z.iso
    .date("Choose a week")
    .refine((v) => isoWeekday(v) === 1, "A roster week starts on a Monday"),
});

/**
 * Publishes one site's week (slice 3.3): `publish_roster` checks the role, refuses a week that has
 * passed or a republish with nothing changed, takes the site's roster lock and inserts the next
 * version. The result carries the organisation from the verified session, so the action can tell
 * each affected worker (src/server/workforce/roster-notify.ts) without trusting request input.
 */
export const publishRosterSpec: MutationSpec<
  typeof publishRosterSchema,
  PublishResult & { organisationId: string }
> = {
  schema: publishRosterSchema,
  roles: ROSTER_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("publish_roster", {
      p_organisation_id: organisationId,
      p_site_id: data.siteId,
      p_week_start: data.weekStart,
      p_dry_run: false,
    });
    if (error) fromRosterDbError(error);
    return { ...toPublishResult(result), organisationId };
  },
};
