import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import {
  BULK_MAP_LIMIT,
  BULK_MAP_MODES,
  BULK_MAP_PROJECT_LIMIT,
  bulkMapResultSchema,
  bulkMapRows,
  type BulkMapMode,
  type BulkMapResult,
  type BulkMapRow,
} from "@/lib/bulk-mapping";
import { lagosToday } from "@/lib/dates";
import type { ManagerRole } from "@/lib/roles";
import {
  actIdsSchema,
  confirmPlan,
  expectedDigestSchema,
  idSet,
  idsSchema,
  previewedSet,
  resolveSelection,
  type PreviewScope,
  type PreviewedSet,
} from "@/server/identity/bulk-selection";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";

import { BulkRefusal, peopleSelectionSchema } from "./bulk";
import type { SavedMapping } from "./mapping";
import { loadScopedPeople, selectPeople } from "./people-scope";
import { PEOPLE_EDITORS } from "./workers";

/**
 * "Map to site and project" on the People list (slice U.3): one site, optionally projects of that
 * site's client, and a mode, for up to 200 selected people.
 *
 * - Rules: public.bulk_map_workers runs the single mapping save (public.save_worker_mapping) for
 *   each person inside one transaction, so the effective date, closing old rows, leavers, the
 *   site and projects being this company's and the overlap checks are exactly the single save's.
 *   Department and line manager are passed back unchanged. All or nothing (MLBM2).
 * - Who: the single save's roles, owner, admin and hr (PEOPLE_EDITORS; the SQL checks again).
 *   Line managers never reach this: they can't map one person either.
 * - Selection guard (U.2's, src/server/identity/bulk-selection.ts): the preview is a dry run of
 *   the same function and signs, with an HMAC bound to the user, the company, the action and the
 *   choice (site, projects and mode), the ids it resolved. The confirm sends the ids, the act set
 *   and the digest back; a changed list or a changed choice is refused (MLLB3).
 * - Audit: the function writes one `people.mapping_saved` row per person changed (the single
 *   save's before and after shape) and one `people.bulk_mapping_saved` for the batch.
 */

const choice = {
  siteId: z.uuid("Choose a site"),
  projectIds: z
    .array(z.uuid("Choose projects from the list"))
    .max(BULK_MAP_PROJECT_LIMIT, `Choose ${BULK_MAP_PROJECT_LIMIT} projects or fewer`)
    .default([]),
  mode: z.enum(BULK_MAP_MODES, "Choose Replace or Add"),
};

export const previewBulkMapSchema = z.object({
  selection: peopleSelectionSchema,
  ...choice,
});

export const bulkMapSchema = z.object({
  /** The people the preview resolved (`selection.ids`). */
  workerIds: idsSchema(BULK_MAP_LIMIT, "employees"),
  /** The people the preview said it would map (`selection.act`), signed by the digest. */
  actIds: actIdsSchema(BULK_MAP_LIMIT),
  expectedDigest: expectedDigestSchema,
  ...choice,
});

export interface BulkMapPreview {
  mode: BulkMapMode;
  siteName: string;
  rows: BulkMapRow[];
  /** Send `selection.ids`, `selection.act` and `selection.digest` back with the confirm. */
  selection: PreviewedSet;
}

export interface BulkMapped {
  organisationId: string;
  actorUserId: string;
  selected: number;
  changed: number;
  /** Each person whose mapping changed, as the single save reports it (for the notices). */
  saved: SavedMapping[];
}

function safeJson(text: string | null | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const problemSchema = z.array(
  z.object({
    worker_id: z.string(),
    name: z.string().nullable(),
    staff_id: z.string().nullable(),
    reason: z.string(),
  }),
);

function fromDbError(error: PostgrestError): never {
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", "Your role can't make this change.");
    case "MLBM2": {
      const parsed = problemSchema.safeParse(safeJson(error.details));
      throw new BulkRefusal(
        error.message,
        parsed.success
          ? parsed.data.map((p) => ({
              workerId: p.worker_id,
              name: p.name,
              staffId: p.staff_id,
              reason: p.reason,
            }))
          : [],
      );
    }
    case "MLBU1":
      throw new MutationError("invalid", error.message, { selection: error.message });
    case "MLBM1":
    case "MLBM3":
      throw new MutationError("invalid", error.message, {
        siteId: error.message,
        projectIds: error.message,
      });
  }
  throw new Error(`Database refused the change (${error.code})`);
}

/** The digest binds the choice too, so a confirm can't map to another site than the preview's. */
function scopeOf(
  ctx: Pick<MutationContext, "userId" | "organisationId">,
  c: { siteId: string; projectIds: readonly string[]; mode: BulkMapMode },
): PreviewScope {
  const projects = [...new Set(c.projectIds.map((id) => id.toLowerCase()))].sort().join(",");
  return {
    action: `people.bulk_map/${c.mode}/${c.siteId.toLowerCase()}/${projects}`,
    userId: ctx.userId,
    organisationId: ctx.organisationId,
  };
}

async function scopedPeople(ctx: MutationContext) {
  return loadScopedPeople(ctx.supabase, ctx.organisationId, ctx.role as ManagerRole, lagosToday());
}

async function run(
  ctx: MutationContext,
  ids: readonly string[],
  c: { siteId: string; projectIds: readonly string[]; mode: BulkMapMode },
  dryRun: boolean,
): Promise<BulkMapResult> {
  const { data, error } = await ctx.supabase.rpc("bulk_map_workers", {
    p_organisation_id: ctx.organisationId,
    p_worker_ids: [...ids],
    p_site_id: c.siteId,
    p_project_ids: [...c.projectIds],
    p_mode: c.mode,
    p_dry_run: dryRun,
  });
  if (error) fromDbError(error);
  return bulkMapResultSchema.parse(data);
}

export const previewBulkMapSpec: MutationSpec<typeof previewBulkMapSchema, BulkMapPreview> = {
  module: "people",
  schema: previewBulkMapSchema,
  roles: PEOPLE_EDITORS,
  run: async (ctx) => {
    const everyone = await scopedPeople(ctx);
    const { selection } = ctx.data;
    const ids =
      selection.kind === "ids"
        ? resolveSelection(selection.ids, idSet(everyone.map((p) => p.id)))
        : selectPeople(everyone, selection).map((p) => p.id.toLowerCase());
    if (ids.length === 0) {
      throw new MutationError("invalid", "Nobody matches these filters.", {
        selection: "Nobody matches these filters.",
      });
    }
    if (ids.length > BULK_MAP_LIMIT) {
      const message = `Select ${BULK_MAP_LIMIT} people or fewer at a time. ${ids.length.toLocaleString("en-NG")} are selected.`;
      throw new MutationError("invalid", message, { selection: message });
    }
    const result = await run(ctx, ids, ctx.data, true);
    const { data: site, error } = await ctx.supabase
      .from("sites")
      .select("name")
      .eq("organisation_id", ctx.organisationId)
      .eq("id", ctx.data.siteId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the site (${error.code})`);
    return {
      mode: ctx.data.mode,
      siteName: site?.name ?? "the site",
      rows: bulkMapRows(result),
      // All or nothing: the confirm acts on everyone the preview resolved.
      selection: previewedSet(scopeOf(ctx, ctx.data), ids, ids),
    };
  },
};

export const bulkMapSpec: MutationSpec<typeof bulkMapSchema, BulkMapped> = {
  module: "people",
  schema: bulkMapSchema,
  roles: PEOPLE_EDITORS,
  run: async (ctx) => {
    const everyone = await scopedPeople(ctx);
    const plan = confirmPlan(
      scopeOf(ctx, ctx.data),
      ctx.data.workerIds,
      idSet(everyone.map((p) => p.id)),
      ctx.data.actIds,
      ctx.data.expectedDigest,
    );
    const result = await run(ctx, plan.act, ctx.data, false);
    if (result.refusals.length > 0) {
      // The function raises MLBM2 before this; never report a partial batch as done.
      throw new BulkRefusal("Nobody was mapped.", []);
    }
    return {
      organisationId: ctx.organisationId,
      actorUserId: ctx.userId,
      selected: result.selected,
      changed: result.changed,
      saved: result.people
        .filter((p) => p.changed)
        .map((p) => ({
          workerId: p.worker_id,
          organisationId: ctx.organisationId,
          actorUserId: ctx.userId,
          changed: p.changed,
          lineManagerChanged: false,
          assignmentsChanged: p.assignments_changed,
          effectiveFrom: p.effective_from,
          before: p.before,
          after: p.after,
        })),
    };
  },
  // The function writes the audit rows (each person and the batch) in its transaction.
};
