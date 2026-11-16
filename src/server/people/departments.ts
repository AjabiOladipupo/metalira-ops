import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";

import { createDepartmentSchema, updateDepartmentSchema } from "./schemas";
import { PEOPLE_EDITORS } from "./workers";

/**
 * Departments (slice 1.5): add, rename and set the head. Owner, admin and hr, as for workers.
 * Each write goes through `mutate()` with the signed-in user's client, so RLS applies and the
 * row audit trigger on `departments` logs the before and after.
 */

function fromDbError(error: PostgrestError): never {
  const text = `${error.message} ${error.details ?? ""}`;
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
  if (error.code === "23505" && text.includes("departments_organisation_name_key")) {
    const message = "A department with this name already exists.";
    throw new MutationError("invalid", message, { name: message });
  }
  if (error.code === "23503" && text.includes("head_worker")) {
    const message = "That employee wasn't found.";
    throw new MutationError("invalid", message, { headWorkerId: message });
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

export const createDepartmentSpec: MutationSpec<typeof createDepartmentSchema, { id: string }> = {
  schema: createDepartmentSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("departments")
      .insert({
        organisation_id: organisationId,
        name: data.name,
        head_worker_id: data.headWorkerId,
      })
      .select("id")
      .single();
    if (error) fromDbError(error);
    return { id: row.id };
  },
};

export function createDepartment(input: unknown): Promise<{ id: string }> {
  return mutate(createDepartmentSpec, input);
}

export const updateDepartmentSpec: MutationSpec<typeof updateDepartmentSchema, { id: string }> = {
  schema: updateDepartmentSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("departments")
      .update({ name: data.name, head_worker_id: data.headWorkerId })
      .eq("id", data.departmentId)
      .eq("organisation_id", organisationId)
      .select("id")
      .maybeSingle();
    if (error) fromDbError(error);
    if (!row) throw new MutationError("invalid", "That department wasn't found.");
    return { id: row.id };
  },
};

export function updateDepartment(input: unknown): Promise<{ id: string }> {
  return mutate(updateDepartmentSpec, input);
}
