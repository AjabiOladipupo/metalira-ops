import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import type { ManagerRole } from "@/lib/roles";
import { toRateLinePayload } from "@/lib/rate-cards";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { Json } from "@/types/db";

import {
  createContractSchema,
  rateCardIdSchema,
  saveRateCardSchema,
  toSla,
  updateContractSchema,
} from "./contract-schemas";

/**
 * Contracts and dated rate cards, WHT per line (slice 2.4), as `mutate()` specs. Every write runs
 * with the signed-in user's own client:
 * - a contract with its sites is one SQL function as the caller (`create_contract`,
 *   `update_draft_contract`), so RLS and the column grants apply and it saves whole;
 * - rate cards have no table grants at all: `save_draft_rate_card`, `add_rate_card_version` and
 *   `cancel_rate_card_version` check the caller's role themselves and refuse any change to a
 *   version in force or in the past on a live contract. They write the audit events
 *   (`rate_card.draft_saved`, `rate_card.version_added`, `rate_card.version_cancelled`) in the
 *   same transaction. Each line carries its service type and WHT rate (per line, owner's
 *   accountant 19 Nov 2026).
 * Amounts go to the database as strings of whole kobo (`toRateLinePayload`), never numbers.
 */

/** Add and change contracts, their sites and rate cards. */
export const CONTRACT_EDITORS = [
  "owner",
  "admin",
  "ops_manager",
] as const satisfies readonly ManagerRole[];

/** Read contracts and rate cards. */
export const CONTRACT_READERS = [
  "owner",
  "admin",
  "finance",
  "ops_manager",
] as const satisfies readonly ManagerRole[];

export function canEditContracts(role: ManagerRole): boolean {
  return (CONTRACT_EDITORS as readonly ManagerRole[]).includes(role);
}

const DUPLICATE_REFERENCE = "Another contract already has this reference.";

/** Database refusals in plain English, under the field they belong to. */
export function fromContractDbError(error: PostgrestError): never {
  const text = `${error.message} ${error.details ?? ""}`;
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
  if (error.code === "23505" && text.includes("contracts_reference_key")) {
    throw new MutationError("invalid", DUPLICATE_REFERENCE, { reference: DUPLICATE_REFERENCE });
  }
  if (error.code === "23505" && text.includes("rate_card_lines_key")) {
    const message = "Each role and band takes one rate.";
    throw new MutationError("invalid", message, { lines: message });
  }
  // Slice 2.5: a site with headcount stays on the contract until its rows are removed.
  if (error.code === "MLHC2") {
    throw new MutationError("invalid", error.message, { siteIds: error.message });
  }
  // Slice 6.11: an office is never on a contract (the pickers leave offices out anyway).
  if (error.code === "MLHO2") {
    throw new MutationError("invalid", error.message, { siteIds: error.message });
  }
  if (error.code === "P0002" || error.code === "23503") {
    throw new MutationError("invalid", "That contract wasn't found. Reload the page.");
  }
  // Our own refusals carry a plain-English message (migration 20261119130000).
  if (/^ML(CO|RC)\d$/.test(error.code)) {
    const field =
      error.code === "MLCO2" || error.code === "MLCO3"
        ? "siteIds"
        : error.code === "MLCO4"
          ? "startDate"
          : error.code === "MLRC5" || error.code === "MLRC8"
            ? "lines"
            : error.code.startsWith("MLRC")
              ? "effectiveFrom"
              : "";
    throw new MutationError("invalid", error.message, field ? { [field]: error.message } : {});
  }
  if (error.code === "23P01") {
    const message = "Another version already covers these dates. Cancel it first.";
    throw new MutationError("invalid", message, { effectiveFrom: message });
  }
  if (error.code === "23514") {
    throw new MutationError("invalid", "Check the highlighted fields.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

function contractRow(data: {
  name: string;
  type: string;
  startDate: string;
  endDate: string | null;
  billingFrequency: string;
  billingTermsDays: number | null;
  vatApplies: boolean;
  coverageTargetBps: number | null;
  responseMinutes: number | null;
  slaNotes: string | null;
}) {
  return {
    name: data.name,
    type: data.type,
    start_date: data.startDate,
    end_date: data.endDate,
    billing_frequency: data.billingFrequency,
    billing_terms_days: data.billingTermsDays,
    vat_applies: data.vatApplies,
    sla: toSla(data) as Json,
  };
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const createContractSpec: MutationSpec<
  typeof createContractSchema,
  { id: string; clientId: string }
> = {
  schema: createContractSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("create_contract", {
      p_organisation_id: organisationId,
      p_contract: { ...contractRow(data), client_id: data.clientId, reference: data.reference },
      p_site_ids: data.siteIds,
    });
    if (error) fromContractDbError(error);
    return { id, clientId: data.clientId };
  },
};

export function createContract(input: unknown) {
  return mutate(createContractSpec, input);
}

/** A draft's terms and sites. A live contract's terms never change (the database refuses). */
export const updateContractSpec: MutationSpec<typeof updateContractSchema, { id: string }> = {
  schema: updateContractSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("update_draft_contract", {
      p_organisation_id: organisationId,
      p_contract_id: data.contractId,
      p_contract: contractRow(data),
      p_site_ids: data.siteIds,
    });
    if (error) fromContractDbError(error);
    return { id };
  },
};

export function updateContract(input: unknown) {
  return mutate(updateContractSpec, input);
}

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

/** The rate card of a draft contract, replaced whole (nothing has used it yet). */
export const saveDraftRateCardSpec: MutationSpec<typeof saveRateCardSchema, { id: string }> = {
  schema: saveRateCardSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("save_draft_rate_card", {
      p_organisation_id: organisationId,
      p_contract_id: data.contractId,
      p_effective_from: data.effectiveFrom,
      p_lines: data.lines.map(toRateLinePayload) as unknown as Json,
      ...(data.note ? { p_note: data.note } : {}),
    });
    if (error) fromContractDbError(error);
    return { id };
  },
};

export function saveDraftRateCard(input: unknown) {
  return mutate(saveDraftRateCardSpec, input);
}

/** "Change rates from": a new version; the one before it closes the day before. */
export const addRateCardVersionSpec: MutationSpec<typeof saveRateCardSchema, { id: string }> = {
  schema: saveRateCardSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("add_rate_card_version", {
      p_organisation_id: organisationId,
      p_contract_id: data.contractId,
      p_effective_from: data.effectiveFrom,
      p_lines: data.lines.map(toRateLinePayload) as unknown as Json,
      ...(data.note ? { p_note: data.note } : {}),
    });
    if (error) fromContractDbError(error);
    return { id };
  },
};

export function addRateCardVersion(input: unknown) {
  return mutate(addRateCardVersionSpec, input);
}

/** Takes back the latest version before it starts; the one before it reopens. */
export const cancelRateCardVersionSpec: MutationSpec<typeof rateCardIdSchema, { id: string }> = {
  schema: rateCardIdSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("cancel_rate_card_version", {
      p_organisation_id: organisationId,
      p_rate_card_id: data.rateCardId,
    });
    if (error) fromContractDbError(error);
    return { id: data.rateCardId };
  },
};

export function cancelRateCardVersion(input: unknown) {
  return mutate(cancelRateCardVersionSpec, input);
}
