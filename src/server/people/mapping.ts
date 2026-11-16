import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import type { MappingSnapshot } from "@/lib/mapping";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";

import { saveMappingSchema } from "./schemas";
import { PEOPLE_EDITORS } from "./workers";

/**
 * Saving a worker's mapping (slice 1.6): department, line manager, site and projects in one
 * call to public.save_worker_mapping, so the whole change is one transaction. Department and
 * line manager change at once; site and project rows that stop applying close the day before
 * the new ones start, and the new ones start from the next shift. Old rows are kept with their
 * end date (the row audit triggers log every insert and close).
 *
 * The app-level audit event `people.mapping_saved` records the mapping before and after, by id
 * and name, so the change reads as one entry. No personal data is involved.
 */

const namedRef = z.object({ id: z.string(), name: z.string() });

const snapshotSchema = z
  .object({
    department: namedRef.nullable(),
    line_manager: z
      .object({
        kind: z.enum(["worker", "membership"]),
        id: z.string(),
        name: z.string().nullable(),
      })
      .nullable(),
    sites: z.array(namedRef),
    projects: z.array(namedRef),
  })
  .transform((s): MappingSnapshot => ({
    department: s.department,
    lineManager: s.line_manager,
    sites: s.sites,
    projects: s.projects,
  }));

/** What public.save_worker_mapping returns. */
const resultSchema = z.object({
  changed: z.boolean(),
  department_changed: z.boolean(),
  line_manager_changed: z.boolean(),
  assignments_changed: z.boolean(),
  effective_from: z.iso.date(),
  before: snapshotSchema,
  after: snapshotSchema,
});

export interface SavedMapping {
  workerId: string;
  organisationId: string;
  /** The signed-in user who saved it. */
  actorUserId: string;
  changed: boolean;
  lineManagerChanged: boolean;
  assignmentsChanged: boolean;
  /** The day new site and project rows start: tomorrow, or the start date if later. */
  effectiveFrom: string;
  before: MappingSnapshot;
  after: MappingSnapshot;
}

function fromDbError(error: PostgrestError): never {
  const invalid = (field: string, message: string): never => {
    throw new MutationError("invalid", message, { [field]: message });
  };
  const text = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", "Your role can't make this change.");
    case "P0002":
    case "MLAS2":
      throw new MutationError("invalid", error.message);
    case "MLLM1":
      return invalid("lineManagerWorkerId", error.message);
    case "MLLM2":
      return invalid("lineManagerMembershipId", error.message);
    case "22023":
      return invalid("lineManagerWorkerId", error.message);
    case "MLAS1":
    case "MLAS4":
      return invalid("siteId", error.message);
    case "MLAS5":
      return invalid("projectIds", error.message);
    case "23P01":
      return invalid("siteId", "This employee is already on that site or project for these dates.");
    case "23503":
      if (text.includes("department")) {
        return invalid("departmentId", "That department wasn't found.");
      }
      if (text.includes("line_manager_worker")) {
        return invalid("lineManagerWorkerId", "That line manager wasn't found.");
      }
      if (text.includes("line_manager_membership")) {
        return invalid("lineManagerMembershipId", "That line manager wasn't found.");
      }
      break;
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

export const saveMappingSpec: MutationSpec<typeof saveMappingSchema, SavedMapping> = {
  schema: saveMappingSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, userId, data }) => {
    const { data: raw, error } = await supabase.rpc("save_worker_mapping", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_department_id: data.departmentId ?? undefined,
      p_line_manager_worker_id: data.lineManagerWorkerId ?? undefined,
      p_line_manager_membership_id: data.lineManagerMembershipId ?? undefined,
      p_site_id: data.siteId ?? undefined,
      p_project_ids: data.projectIds,
    });
    if (error) fromDbError(error);
    const result = resultSchema.parse(raw);
    return {
      workerId: data.workerId,
      organisationId,
      actorUserId: userId,
      changed: result.changed,
      lineManagerChanged: result.line_manager_changed,
      assignmentsChanged: result.assignments_changed,
      effectiveFrom: result.effective_from,
      before: result.before,
      after: result.after,
    };
  },
  // One entry for the whole change, before and after by id and name. The row triggers log each
  // row as well. Nothing is written when the save changed nothing.
  event: ({ result }) =>
    result.changed
      ? {
          action: "people.mapping_saved",
          entity: "workers",
          entityId: result.workerId,
          before: result.before,
          after: {
            ...result.after,
            assignmentsFrom: result.assignmentsChanged ? result.effectiveFrom : null,
          },
        }
      : null,
};

/** Saves a worker's department, line manager, site and projects. Owner, admin and hr only. */
export function saveMapping(input: unknown): Promise<SavedMapping> {
  return mutate(saveMappingSpec, input);
}
