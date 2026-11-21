import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import type { ManagerRole } from "@/lib/roles";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";
import {
  ROSTER_EDITORS,
  assignShiftSpec,
  fromRosterDbError,
  removeAssignmentSpec,
  type AssignResult,
} from "@/server/workforce/roster";

/**
 * Assign and remove from My team (slice 4.7). The same SQL functions as the roster
 * (`assign_worker_to_shift`, `remove_assignment`), which since migration 20261121200000 accept a
 * line_manager for their own reportees at their team's sites; the database is the gate, the role
 * list here only says who may try. Publishing stays with ROSTER_EDITORS (owner, admin,
 * ops_manager) in roster.ts.
 */

export const TEAM_ASSIGNERS: readonly ManagerRole[] = [...ROSTER_EDITORS, "line_manager"];

/** The line manager's own refusal text; anything else as the roster says it. */
function fromTeamDbError(error: PostgrestError): never {
  if (
    error.code === "42501" &&
    error.message === "You can assign only people who report to you, at your team's sites."
  ) {
    throw new MutationError("forbidden", error.message);
  }
  fromRosterDbError(error);
}

export const teamAssignShiftSpec: MutationSpec<typeof assignShiftSpec.schema, AssignResult> = {
  ...assignShiftSpec,
  roles: TEAM_ASSIGNERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("assign_worker_to_shift", {
      p_organisation_id: organisationId,
      p_post_id: data.postId,
      p_shift_date: data.date,
      p_worker_id: data.workerId,
    });
    if (error) fromTeamDbError(error);
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      assignmentId: String(r.assignment_id ?? ""),
      shiftId: String(r.shift_id ?? ""),
      mapped: r.mapped === true,
    };
  },
};

export const teamRemoveAssignmentSpec: MutationSpec<
  typeof removeAssignmentSpec.schema,
  { assignmentId: string }
> = {
  ...removeAssignmentSpec,
  roles: TEAM_ASSIGNERS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("remove_assignment", {
      p_organisation_id: organisationId,
      p_assignment_id: data.assignmentId,
      ...(data.reason ? { p_reason: data.reason } : {}),
    });
    if (error) fromTeamDbError(error);
    return { assignmentId: data.assignmentId };
  },
};
