import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { parseHeadcountInput } from "@/lib/headcount";
import { parseRequirementInput } from "@/lib/live-changes";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";

import { CONTRACT_EDITORS } from "./contracts";

/**
 * Changes to a live contract (slice 2.8), as `mutate()` specs. Each is one SQL function run with
 * the signed-in user's own client: `change_post_requirement`, `add_post`, `close_post` and
 * `add_contract_site` check the caller's role in the database (owner, admin, ops_manager, trusted
 * sessions only), lock the contract row, write the dated versions in one transaction, and record
 * a `contract_changes` row and an audit event (`post.requirement_changed`, `post.added`,
 * `post.closed`, `contract.site_added`). Posts and requirements have no write grants.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reasons and notes never carry web addresses (the database refuses them too). */
const NO_URL = /:\/\/|www\./i;

const date = (message: string) => z.string().trim().regex(ISO_DATE, message);

const note = z
  .string()
  .max(2000)
  .optional()
  .transform((v) => (v ?? "").replace(/\r\n?/g, " ").trim())
  .refine((v) => v.length <= 500, "500 characters or fewer")
  .refine((v) => /^[^\p{Cc}<>]*$/u.test(v), "Plain text only")
  .refine((v) => !NO_URL.test(v), "Leave out web addresses");

const days = z.array(z.string().max(2)).max(14).optional().default([]);
const text = (max: number) => z.string().max(max).optional().default("");

/** A ticked checkbox ("on"), or a boolean from the registry. */
const checkbox = z
  .union([z.boolean(), z.string().max(5)])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

export const changeRequirementSchema = z
  .object({
    postId: z.uuid("Choose a post"),
    from: date("Choose the date the change starts"),
    days,
    startTime: text(10),
    endTime: text(10),
    requiredCount: text(10),
    note,
  })
  .transform((value, ctx) => {
    const parsed = parseRequirementInput(value);
    if (!parsed.ok) {
      for (const [field, message] of Object.entries(parsed.errors)) {
        ctx.addIssue({ code: "custom", path: [field], message });
      }
      return z.NEVER;
    }
    return { postId: value.postId, from: value.from, note: value.note, ...parsed.values };
  });

export const addPostSchema = z
  .object({
    contractId: z.uuid("Choose a contract"),
    siteId: text(64),
    postName: text(200),
    role: text(200),
    band: text(200),
    unit: text(20),
    from: date("Choose the date the post starts"),
    days,
    startTime: text(10),
    endTime: text(10),
    requiredCount: text(10),
    addSite: checkbox,
    note,
  })
  .transform((value, ctx) => {
    const parsed = parseHeadcountInput({ ...value, notes: "" });
    if (!parsed.ok) {
      for (const [field, message] of Object.entries(parsed.errors)) {
        ctx.addIssue({ code: "custom", path: [field], message });
      }
      return z.NEVER;
    }
    return {
      contractId: value.contractId,
      from: value.from,
      addSite: value.addSite,
      note: value.note,
      ...parsed.line,
    };
  });

export const closePostSchema = z.object({
  postId: z.uuid("Choose a post"),
  lastDay: date("Choose the last day the post is staffed"),
  reason: z
    .string()
    .trim()
    .min(1, "Say why the post is closing")
    .max(500, "500 characters or fewer")
    .regex(/^[^\p{Cc}<>]*$/u, "Plain text only")
    .refine((v) => !NO_URL.test(v), "Leave out web addresses"),
});

export const addContractSiteSchema = z.object({
  contractId: z.uuid("Choose a contract"),
  siteId: z.uuid("Choose a site"),
  note,
});

export const postIdSchema = z.object({ postId: z.uuid("Choose a post") });

export const cancelRequirementChangeSchema = z.object({
  postId: z.uuid("Choose a post"),
  requirementId: z.uuid("Choose a change"),
  note,
});

/** Which form field each refusal belongs under. */
const FIELD: Record<string, string> = {
  MLPC2: "from",
  MLPC3: "from",
  MLPC4: "role",
  MLPC5: "siteId",
  MLPC6: "from",
  MLPC7: "reason",
  MLPC8: "requiredCount",
  MLPC9: "requiredCount",
};

/** Database refusals in plain English, under the field they belong to. */
export function fromLiveChangeDbError(
  error: PostgrestError,
  fields: Record<string, string> = {},
): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  }
  if (/^MLPC\d$/.test(error.code)) {
    const field = fields[error.code] ?? FIELD[error.code];
    throw new MutationError("invalid", error.message, field ? { [field]: error.message } : {});
  }
  // Slice 6.11: MLHO2 and MLHO4, an office on a contract or a post (never offered).
  if (/^ML(PO|CO|HO)\d$/.test(error.code)) {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface RequirementChangeResult {
  postId: string;
  requirementId: string;
  effectiveFrom: string;
  replaced: boolean;
}

export const changeRequirementSpec: MutationSpec<
  typeof changeRequirementSchema,
  RequirementChangeResult
> = {
  schema: changeRequirementSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("change_post_requirement", {
      p_organisation_id: organisationId,
      p_post_id: data.postId,
      p_from: data.from,
      p_days: [...data.daysOfWeek],
      p_start: data.startTime,
      p_end: data.endTime,
      p_count: data.requiredCount,
      ...(data.note ? { p_note: data.note } : {}),
    });
    if (error) fromLiveChangeDbError(error);
    const r = record(result);
    return {
      postId: data.postId,
      requirementId: String(r.requirement_id ?? ""),
      effectiveFrom: data.from,
      replaced: typeof r.replaced_id === "string",
    };
  },
};

export function changeRequirement(input: unknown) {
  return mutate(changeRequirementSpec, input);
}

export interface AddPostResult {
  postId: string;
  name: string;
  siteAdded: boolean;
}

export const addPostSpec: MutationSpec<typeof addPostSchema, AddPostResult> = {
  schema: addPostSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("add_post", {
      p_organisation_id: organisationId,
      p_contract_id: data.contractId,
      p_site_id: data.siteId,
      p_post_name: data.postName ?? "",
      p_role: data.role,
      p_band: data.band,
      p_unit: data.unit,
      p_from: data.from,
      p_days: [...data.daysOfWeek],
      p_start: data.startTime,
      p_end: data.endTime,
      p_count: data.requiredCount,
      p_add_site: data.addSite,
      ...(data.note ? { p_note: data.note } : {}),
    });
    if (error) fromLiveChangeDbError(error);
    const r = record(result);
    return {
      postId: String(r.post_id ?? ""),
      name: String(r.name ?? ""),
      siteAdded: r.site_added === true,
    };
  },
};

export function addPost(input: unknown) {
  return mutate(addPostSpec, input);
}

export interface ClosePostResult {
  postId: string;
  closedOn: string;
  requirementsCancelled: number;
}

export const closePostSpec: MutationSpec<typeof closePostSchema, ClosePostResult> = {
  schema: closePostSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("close_post", {
      p_organisation_id: organisationId,
      p_post_id: data.postId,
      p_last_day: data.lastDay,
      p_reason: data.reason,
    });
    if (error) fromLiveChangeDbError(error, { MLPC2: "lastDay", MLPC6: "lastDay" });
    const r = record(result);
    return {
      postId: data.postId,
      closedOn: data.lastDay,
      requirementsCancelled: Number(r.requirements_cancelled ?? 0),
    };
  },
};

export function closePost(input: unknown) {
  return mutate(closePostSpec, input);
}

export const addContractSiteSpec: MutationSpec<typeof addContractSiteSchema, { siteId: string }> = {
  schema: addContractSiteSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("add_contract_site", {
      p_organisation_id: organisationId,
      p_contract_id: data.contractId,
      p_site_id: data.siteId,
      ...(data.note ? { p_note: data.note } : {}),
    });
    if (error) fromLiveChangeDbError(error);
    return { siteId: data.siteId };
  },
};

export function addContractSite(input: unknown) {
  return mutate(addContractSiteSpec, input);
}

export interface CancelChangeResult {
  postId: string;
  cancelledId: string;
}

export const cancelRequirementChangeSpec: MutationSpec<
  typeof cancelRequirementChangeSchema,
  CancelChangeResult
> = {
  schema: cancelRequirementChangeSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("cancel_post_requirement_change", {
      p_organisation_id: organisationId,
      p_requirement_id: data.requirementId,
      ...(data.note ? { p_note: data.note } : {}),
    });
    if (error) fromLiveChangeDbError(error, { MLPC2: "requirementId", MLPC3: "requirementId" });
    const r = record(result);
    return { postId: String(r.post_id ?? data.postId), cancelledId: data.requirementId };
  },
};

export function cancelRequirementChange(input: unknown) {
  return mutate(cancelRequirementChangeSpec, input);
}
