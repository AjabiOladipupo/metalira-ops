import "server-only";

import { createHash } from "node:crypto";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { lagosToday } from "@/lib/dates";
import { decodeLineManager } from "@/lib/people";
import { parsePeopleFilters } from "@/lib/people-filters";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import type { ManagerRole } from "@/lib/roles";

import { peopleExportCsv, peopleExportFileName } from "./export-csv";
import { loadManagerUsers } from "./people-data";
import {
  PEOPLE_READERS,
  loadScopedPeople,
  selectPeople,
  toExportRow,
  type PeopleSelection,
  type ScopedPerson,
} from "./people-scope";
import { isoDateSchema } from "./schemas";
import { PEOPLE_EDITORS } from "./workers";

/**
 * People bulk actions (slice U.1): end employment, change line manager, change department and
 * export, for the rows ticked on the People list or everyone matching its filters.
 *
 * - Who: the writes follow their single versions (end_employment and save_worker_mapping): owner,
 *   admin and hr (`PEOPLE_EDITORS`). The export is open to every role that reads the People list,
 *   in that role's own scope (a line manager exports only their reportees).
 * - A selection is resolved here, on the server, from the caller's own reads: ids the caller
 *   can't read are dropped, and "all matching" re-runs the filters. The database then checks
 *   every id again (public.bulk_*; another company's ids are refused as not found).
 * - All or nothing: each write is one SQL function, one transaction. A refusal names each
 *   person who can't be changed and why (MLBU2), and nothing changes.
 * - Audit: the functions write one row per person and one for the batch; the export writes
 *   `people.exported` with the count only.
 */

/** At most this many people end in one go (owner decision). */
export const BULK_END_LIMIT = 200;
/** At most this many people are reassigned in one go. */
export const BULK_REASSIGN_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const peopleSelectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ids"),
    ids: z
      .array(z.uuid("Select employees from the list"))
      .min(1, "Select at least one employee")
      .max(BULK_REASSIGN_LIMIT, `Select ${BULK_REASSIGN_LIMIT} people or fewer`),
  }),
  z.object({
    kind: z.literal("filters"),
    filters: z.record(z.string(), z.string().max(200)).transform((raw) => parsePeopleFilters(raw)),
  }),
]);

const reasonSchema = z
  .string("Give a reason for ending their employment")
  .trim()
  .min(3, "Give a reason for ending their employment")
  .max(500, "Keep the reason to 500 characters");

export const previewBulkEndSchema = z.object({
  selection: peopleSelectionSchema,
  endDate: isoDateSchema,
});

/**
 * The digest of the people a preview showed (`PreviewedSet.digest`). A confirm sends it back,
 * and the server refuses (MLBU6) when the selection now resolves to anyone else, so "all
 * matching" can never end or move someone who wasn't in the preview.
 */
const expectedDigestSchema = z
  .string("Preview the change first")
  .regex(/^[0-9a-f]{64}$/, "Preview the change first");

export const bulkEndEmploymentSchema = previewBulkEndSchema.extend({
  reason: reasonSchema,
  expectedDigest: expectedDigestSchema,
});

const lineManagerChoice = {
  selection: peopleSelectionSchema,
  lineManager: z
    .string("Choose a line manager")
    .regex(/^[wm]:[0-9a-f-]{36}$/i, "Choose a line manager"),
};

const departmentChoice = {
  selection: peopleSelectionSchema,
  departmentId: z.uuid("Choose a department"),
};

export const bulkLineManagerSchema = z.object({
  ...lineManagerChoice,
  expectedDigest: expectedDigestSchema,
});

export const bulkDepartmentSchema = z.object({
  ...departmentChoice,
  expectedDigest: expectedDigestSchema,
});

export const previewBulkReassignSchema = z.discriminatedUnion("change", [
  z.object({ ...lineManagerChoice, change: z.literal("line_manager") }),
  z.object({ ...departmentChoice, change: z.literal("department") }),
]);

export const exportPeopleSchema = z.object({ selection: peopleSelectionSchema });

// ---------------------------------------------------------------------------
// Results and refusals
// ---------------------------------------------------------------------------

/** The people a preview covers: the ids it resolved, how many, and their digest. */
export interface PreviewedSet {
  ids: string[];
  count: number;
  digest: string;
}

/** SHA-256 of the sorted, distinct ids: the same set always gives the same digest. */
export function selectionDigest(ids: readonly string[]): string {
  const sorted = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

function previewed(ids: readonly string[]): PreviewedSet {
  const distinct = [...new Set(ids)];
  return { ids: distinct, count: distinct.length, digest: selectionDigest(distinct) };
}

export const SELECTION_CHANGED = "The list changed since the preview. Review it again.";

/** The selection resolves to different people than the preview showed (MLBU6). */
export class SelectionChanged extends MutationError {
  override name = "SelectionChanged";
  readonly refusal = "MLBU6";
  constructor() {
    super("invalid", SELECTION_CHANGED, { selection: SELECTION_CHANGED });
  }
}

/** Someone selected who can't be changed, and why. */
export interface BulkProblem {
  workerId: string;
  name: string | null;
  staffId: string | null;
  reason: string;
}

/** A whole batch refused because some people can't be changed; nothing changed. */
export class BulkRefusal extends MutationError {
  override name = "BulkRefusal";
  constructor(
    message: string,
    readonly problems: BulkProblem[],
  ) {
    super("invalid", message);
  }
}

const problemSchema = z.object({
  worker_id: z.string(),
  name: z.string().nullable(),
  staff_id: z.string().nullable(),
  reason: z.string(),
});

function fromDbError(error: PostgrestError): never {
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", "Your role can't make this change.");
    case "MLBU2": {
      const parsed = z.array(problemSchema).safeParse(safeJson(error.details));
      const problems = parsed.success
        ? parsed.data.map((p) => ({
            workerId: p.worker_id,
            name: p.name,
            staffId: p.staff_id,
            reason: p.reason,
          }))
        : [];
      throw new BulkRefusal(error.message, problems);
    }
    case "MLBU1":
      throw new MutationError("invalid", error.message, { selection: error.message });
    case "MLBU3":
      throw new MutationError("invalid", error.message, { reason: error.message });
    case "MLBU4":
      throw new MutationError("invalid", error.message, { endDate: error.message });
    case "MLBU5":
      throw new MutationError("invalid", error.message, {
        lineManager: error.message,
        departmentId: error.message,
      });
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

function safeJson(text: string | null | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The people a selection names, within the caller's scope, by name. */
async function resolve(
  ctx: Pick<MutationContext, "supabase" | "organisationId"> & { role: ManagerRole },
  selection: PeopleSelection,
): Promise<ScopedPerson[]> {
  const people = await loadScopedPeople(ctx.supabase, ctx.organisationId, ctx.role, lagosToday());
  return selectPeople(people, selection).sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      a.staffId.localeCompare(b.staffId),
  );
}

/** Ids for a write: the ticked ids as sent (the database checks each), or everyone matching. */
async function idsFor(
  ctx: MutationContext,
  selection: PeopleSelection,
  limit: number,
): Promise<string[]> {
  const ids =
    selection.kind === "ids"
      ? [...new Set(selection.ids)]
      : (await resolve({ ...ctx, role: ctx.role as ManagerRole }, selection)).map((p) => p.id);
  if (ids.length === 0) {
    throw new MutationError("invalid", "Nobody matches these filters.", {
      selection: "Nobody matches these filters.",
    });
  }
  if (ids.length > limit) {
    const message = `Select ${limit} people or fewer at a time. ${ids.length.toLocaleString("en-NG")} are selected.`;
    throw new MutationError("invalid", message, { selection: message });
  }
  return ids;
}

/**
 * Ids for a confirmed write: resolved again exactly as the preview did, and refused (MLBU6)
 * unless they are the same people the preview showed.
 */
async function confirmedIds(
  ctx: MutationContext,
  selection: PeopleSelection,
  limit: number,
  expectedDigest: string,
): Promise<string[]> {
  let ids: string[];
  try {
    ids = await idsFor(ctx, selection, limit);
  } catch (error) {
    // Nobody matches any more, or too many do: the list changed since the preview.
    if (error instanceof MutationError && error.code === "invalid") throw new SelectionChanged();
    throw error;
  }
  if (selectionDigest(ids) !== expectedDigest) throw new SelectionChanged();
  return ids;
}

// ---------------------------------------------------------------------------
// End employment
// ---------------------------------------------------------------------------

export interface BulkEndPreviewPerson {
  workerId: string;
  name: string | null;
  staffId: string | null;
  startDate: string | null;
  futureShifts: number;
  leavePending: number;
  leaveApproved: number;
  refusal: string | null;
}

export interface BulkEndPreview {
  endDate: string;
  people: BulkEndPreviewPerson[];
  /** Send `selection.digest` back with the confirm. */
  selection: PreviewedSet;
}

const previewResult = z.object({
  end_date: z.string(),
  people: z.array(
    z.object({
      worker_id: z.string(),
      name: z.string().nullable(),
      staff_id: z.string().nullable(),
      start_date: z.string().nullable(),
      future_shifts: z.number(),
      leave_pending: z.number(),
      leave_approved: z.number(),
      refusal: z.string().nullable(),
    }),
  ),
});

export const previewBulkEndSpec: MutationSpec<typeof previewBulkEndSchema, BulkEndPreview> = {
  module: "people",
  schema: previewBulkEndSchema,
  roles: PEOPLE_EDITORS,
  run: async (ctx) => {
    const ids = await idsFor(ctx, ctx.data.selection, BULK_END_LIMIT);
    const { data, error } = await ctx.supabase.rpc("bulk_end_employment_preview", {
      p_organisation_id: ctx.organisationId,
      p_worker_ids: ids,
      p_end_date: ctx.data.endDate,
    });
    if (error) fromDbError(error);
    const result = previewResult.parse(data);
    const people = result.people
      .map((p) => ({
        workerId: p.worker_id,
        name: p.name,
        staffId: p.staff_id,
        startDate: p.start_date,
        futureShifts: p.future_shifts,
        leavePending: p.leave_pending,
        leaveApproved: p.leave_approved,
        refusal: p.refusal,
      }))
      .sort((a, b) => (a.name ?? "~").localeCompare(b.name ?? "~", "en", { sensitivity: "base" }));
    return { endDate: result.end_date, people, selection: previewed(ids) };
  },
};

export interface BulkEnded {
  ended: number;
  endDate: string;
}

export const bulkEndEmploymentSpec: MutationSpec<typeof bulkEndEmploymentSchema, BulkEnded> = {
  module: "people",
  schema: bulkEndEmploymentSchema,
  roles: PEOPLE_EDITORS,
  run: async (ctx) => {
    const ids = await confirmedIds(
      ctx,
      ctx.data.selection,
      BULK_END_LIMIT,
      ctx.data.expectedDigest,
    );
    const { data, error } = await ctx.supabase.rpc("bulk_end_employment", {
      p_organisation_id: ctx.organisationId,
      p_worker_ids: ids,
      p_end_date: ctx.data.endDate,
      p_reason: ctx.data.reason,
    });
    if (error) fromDbError(error);
    const result = z.object({ ended: z.number(), end_date: z.string() }).parse(data);
    return { ended: result.ended, endDate: result.end_date };
  },
  // The function writes one audit row per person and one for the batch, in its transaction.
};

// ---------------------------------------------------------------------------
// Line manager and department
// ---------------------------------------------------------------------------

export interface BulkReassigned {
  selected: number;
  changed: number;
  /** The people selected (the database checked each). */
  workerIds: string[];
}

const reassignResult = z.object({ selected: z.number(), changed: z.number() });

/** A bulk line manager change, with what the notice to the new line manager needs. */
export interface BulkLineManagerChanged extends BulkReassigned {
  organisationId: string;
  /** The signed-in user who made the change (never told about their own change). */
  actorUserId: string;
}

export const bulkLineManagerSpec: MutationSpec<
  typeof bulkLineManagerSchema,
  BulkLineManagerChanged
> = {
  module: "people",
  schema: bulkLineManagerSchema,
  roles: PEOPLE_EDITORS,
  run: async (ctx) => {
    const ids = await confirmedIds(
      ctx,
      ctx.data.selection,
      BULK_REASSIGN_LIMIT,
      ctx.data.expectedDigest,
    );
    const lm = decodeLineManager(ctx.data.lineManager);
    const { data, error } = await ctx.supabase.rpc("bulk_set_line_manager", {
      p_organisation_id: ctx.organisationId,
      p_worker_ids: ids,
      p_line_manager_worker_id: lm.lineManagerWorkerId ?? undefined,
      p_line_manager_membership_id: lm.lineManagerMembershipId ?? undefined,
    });
    if (error) fromDbError(error);
    return {
      ...reassignResult.parse(data),
      workerIds: ids,
      organisationId: ctx.organisationId,
      actorUserId: ctx.userId,
    };
  },
};

export const bulkDepartmentSpec: MutationSpec<typeof bulkDepartmentSchema, BulkReassigned> = {
  module: "people",
  schema: bulkDepartmentSchema,
  roles: PEOPLE_EDITORS,
  run: async (ctx) => {
    const ids = await confirmedIds(
      ctx,
      ctx.data.selection,
      BULK_REASSIGN_LIMIT,
      ctx.data.expectedDigest,
    );
    const { data, error } = await ctx.supabase.rpc("bulk_set_department", {
      p_organisation_id: ctx.organisationId,
      p_worker_ids: ids,
      p_department_id: ctx.data.departmentId,
    });
    if (error) fromDbError(error);
    return { ...reassignResult.parse(data), workerIds: ids };
  },
};

export interface BulkReassignPreview {
  /** "Line manager" or "Department". */
  field: string;
  /** The new value, by name. */
  to: string;
  people: {
    workerId: string;
    name: string;
    staffId: string;
    before: string | null;
    /** Why this person can't be changed, or null. */
    refusal: string | null;
  }[];
  /** Ids sent that the caller can't read (another company's, or gone). */
  notFound: number;
  /** Send `selection.digest` back with the confirm. */
  selection: PreviewedSet;
}

export const previewBulkReassignSpec: MutationSpec<
  typeof previewBulkReassignSchema,
  BulkReassignPreview
> = {
  module: "people",
  schema: previewBulkReassignSchema,
  roles: PEOPLE_EDITORS,
  run: async (ctx) => {
    const { data } = ctx;
    const ids = await idsFor(ctx, data.selection, BULK_REASSIGN_LIMIT);
    const people = await resolve(
      { ...ctx, role: ctx.role as ManagerRole },
      {
        kind: "ids",
        ids,
      },
    );
    let field: string;
    let to: string;
    let before: (p: ScopedPerson) => string | null;
    if (data.change === "line_manager") {
      field = "Line manager";
      const lm = decodeLineManager(data.lineManager);
      if (lm.lineManagerWorkerId) {
        const all = await loadScopedPeople(
          ctx.supabase,
          ctx.organisationId,
          ctx.role as ManagerRole,
          lagosToday(),
        );
        const found = all.find((p) => p.id === lm.lineManagerWorkerId && p.status === "active");
        if (!found) {
          throw new MutationError("invalid", "That line manager wasn't found or has left.", {
            lineManager: "That line manager wasn't found or has left.",
          });
        }
        to = found.name;
      } else {
        const managers = await loadManagerUsers(ctx.supabase, ctx.organisationId);
        const found = managers.find((m) => m.membershipId === lm.lineManagerMembershipId);
        if (!found) {
          throw new MutationError("invalid", "That line manager wasn't found.", {
            lineManager: "That line manager wasn't found.",
          });
        }
        to = found.name;
      }
      before = (p) => p.lineManagerName;
    } else {
      field = "Department";
      const { data: department, error } = await ctx.supabase
        .from("departments")
        .select("name")
        .eq("organisation_id", ctx.organisationId)
        .eq("id", data.departmentId)
        .maybeSingle();
      if (error) throw new Error(`Could not read the department: ${error.message}`);
      if (!department) {
        throw new MutationError("invalid", "That department wasn't found.", {
          departmentId: "That department wasn't found.",
        });
      }
      to = department.name;
      before = (p) => p.departmentName;
    }
    return {
      field,
      to,
      people: people.map((p) => ({
        workerId: p.id,
        name: p.name,
        staffId: p.staffId,
        before: before(p),
        refusal:
          p.status === "ended" ? "This employee has left, so their mapping can't change." : null,
      })),
      notFound: ids.length - people.length,
      selection: previewed(ids),
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface PeopleExport {
  fileName: string;
  csv: string;
  count: number;
}

export const exportPeopleSpec: MutationSpec<typeof exportPeopleSchema, PeopleExport> = {
  module: "people",
  schema: exportPeopleSchema,
  roles: PEOPLE_READERS,
  run: async (ctx) => {
    const people = await resolve({ ...ctx, role: ctx.role as ManagerRole }, ctx.data.selection);
    if (people.length === 0) {
      throw new MutationError("invalid", "Nobody to export.", { selection: "Nobody to export." });
    }
    const today = lagosToday();
    return {
      fileName: peopleExportFileName(today),
      csv: peopleExportCsv(people.map(toExportRow)),
      count: people.length,
    };
  },
  // The count only: never names, ids or the file.
  event: ({ result }) => ({
    action: "people.exported",
    entity: "workers",
    after: { count: result.count },
  }),
};
