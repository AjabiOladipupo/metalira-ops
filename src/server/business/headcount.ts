import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";

import { CONTRACT_EDITORS } from "./contracts";
import {
  addHeadcountSchema,
  removeHeadcountSchema,
  updateHeadcountSchema,
  type HeadcountRow,
} from "./headcount-schemas";

/**
 * Headcount rows (slice 2.5), as `mutate()` specs. Each write changes one row with the signed-in
 * user's own client, so RLS (owner, admin, ops_manager) and the column grants apply. The
 * database guard refuses any change once the contract has left draft (`MLHC1`), for every role,
 * and the row trigger audits the change (with its channel) in the same transaction.
 */

/** Database refusals in plain English, under the field they belong to. */
export function fromHeadcountDbError(error: PostgrestError): never {
  const text = `${error.message} ${error.details ?? ""}`;
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
  if (error.code === "MLHC1" || error.code === "MLHC2") {
    throw new MutationError("invalid", error.message);
  }
  if (error.code === "23505" && text.includes("headcount_requirements_post_key")) {
    const message = "This site already has a post with this name and band.";
    throw new MutationError("invalid", message, { postName: message });
  }
  if (error.code === "23503" && text.includes("contract_site")) {
    const message = "Choose one of the contract's sites.";
    throw new MutationError("invalid", message, { siteId: message });
  }
  if (error.code === "23503" || error.code === "PGRST116") {
    throw new MutationError("invalid", "That contract wasn't found. Reload the page.");
  }
  if (error.code === "23514") {
    throw new MutationError("invalid", "Check the highlighted fields.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

function rowColumns(data: HeadcountRow) {
  return {
    site_id: data.siteId,
    post_name: data.postName,
    role: data.role,
    band: data.band,
    unit: data.unit,
    days_of_week: data.daysOfWeek,
    start_time: data.startTime,
    end_time: data.endTime,
    required_count: data.requiredCount,
    notes: data.notes,
  };
}

const NOT_FOUND = "That headcount row wasn't found. Reload the page.";

export const addHeadcountSpec: MutationSpec<typeof addHeadcountSchema, { id: string }> = {
  schema: addHeadcountSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("headcount_requirements")
      .insert({
        organisation_id: organisationId,
        contract_id: data.contractId,
        ...rowColumns(data),
      })
      .select("id")
      .single();
    if (error) fromHeadcountDbError(error);
    return { id: row.id };
  },
};

export function addHeadcount(input: unknown) {
  return mutate(addHeadcountSpec, input);
}

export const updateHeadcountSpec: MutationSpec<typeof updateHeadcountSchema, { id: string }> = {
  schema: updateHeadcountSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase
      .from("headcount_requirements")
      .update(rowColumns(data))
      .eq("organisation_id", organisationId)
      .eq("contract_id", data.contractId)
      .eq("id", data.headcountId)
      .select("id");
    if (error) fromHeadcountDbError(error);
    if (!rows?.length) throw new MutationError("invalid", NOT_FOUND);
    return { id: data.headcountId };
  },
};

export function updateHeadcount(input: unknown) {
  return mutate(updateHeadcountSpec, input);
}

export const removeHeadcountSpec: MutationSpec<typeof removeHeadcountSchema, { id: string }> = {
  schema: removeHeadcountSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase
      .from("headcount_requirements")
      .delete()
      .eq("organisation_id", organisationId)
      .eq("contract_id", data.contractId)
      .eq("id", data.headcountId)
      .select("id");
    if (error) fromHeadcountDbError(error);
    if (!rows?.length) throw new MutationError("invalid", NOT_FOUND);
    return { id: data.headcountId };
  },
};

export function removeHeadcount(input: unknown) {
  return mutate(removeHeadcountSpec, input);
}
