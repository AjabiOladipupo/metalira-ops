import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ManagerRole } from "@/lib/roles";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

import { normaliseStaffId } from "./import/staff-id";

/**
 * Staff ID corrections (slice 1.11, owner decision 19). A typo in a staff ID is corrected with
 * a reason and a second approver, the same two-person pattern as bank-detail changes (slice
 * 1.7). The rules live in the database (public.staff_id_corrections, migration 20261117180000)
 * so they hold for every client: owner, admin and hr raise and decide, never their own request
 * and never their own record; only while the worker is active with no punches, timesheets or
 * pay records; and the new ID was never used in the company (not by any worker, past or
 * present, not retired by an earlier correction, not reserved by a pending one). On approval
 * the worker's staff ID changes in the same transaction and the row audits keep before and
 * after. The worker sees the new ID on Me and signs in with it.
 */

export const STAFF_ID_CORRECTORS = ["owner", "admin", "hr"] as const satisfies readonly ManagerRole[];

export function isStaffIdCorrector(role: ManagerRole): boolean {
  return (STAFF_ID_CORRECTORS as readonly ManagerRole[]).includes(role);
}

export type StaffIdCorrectionStatus = Database["public"]["Enums"]["staff_id_correction_status"];

type Client = SupabaseClient<Database>;

/**
 * A corrected staff ID: the strict token every staff ID must be to sign in and to appear in
 * emails and on printed invite sheets (people/import/staff-id.ts), after NFKC.
 */
export const newStaffIdSchema = z
  .string()
  .transform((value, ctx) => {
    const id = normaliseStaffId(value);
    if (id === null) {
      ctx.addIssue({
        code: "custom",
        message:
          "Use up to 40 letters, digits, dots, dashes, slashes or underscores, starting with a letter or digit.",
      });
      return z.NEVER;
    }
    return id;
  });

const reasonSchema = z
  .string()
  .trim()
  .min(3, "Say why the staff ID is wrong, for example “Typo at import: should be AFS-0142”.")
  .max(500, "Reason must be 500 characters or fewer")
  .regex(/^[^\p{Cc}<>]*$/u, "Reason must be plain text, without < or >");

const noteSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .max(500, "Note must be 500 characters or fewer")
    .regex(/^[^\p{Cc}<>]*$/u, "Note must be plain text, without < or >")
    .nullish()
    .transform((value) => value ?? null),
);

export const requestStaffIdCorrectionSchema = z.object({
  workerId: z.uuid("Choose an employee"),
  newStaffId: newStaffIdSchema,
  reason: reasonSchema,
});

export const STAFF_ID_DECISIONS = ["approve", "reject"] as const;

export const decideStaffIdCorrectionSchema = z.object({
  correctionId: z.uuid("Choose a correction"),
  decision: z.enum(STAFF_ID_DECISIONS, "Choose approve or reject"),
  note: noteSchema,
});

export const withdrawStaffIdCorrectionSchema = z.object({
  correctionId: z.uuid("Choose a correction"),
});

/** Plain-English refusals: the database's own messages, put on the right field. */
function fromDbError(error: PostgrestError, field = "newStaffId"): never {
  const text = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", error.message || "Your role can't make this change.");
    case "MLSI3":
      throw new MutationError("invalid", error.message, { [field]: error.message });
    case "P0002":
    case "MLSI1":
    case "MLSI2":
    case "MLSI4":
    case "MLSI5":
    case "MLSI6":
    case "MLSI7":
      throw new MutationError("invalid", error.message);
    case "23505": {
      if (text.includes("staff_id_corrections_one_open_key")) {
        throw new MutationError(
          "invalid",
          "A staff ID correction for this employee is already waiting. Approve, reject or withdraw it first.",
        );
      }
      const message = "That staff ID has been used before in this company. Choose another.";
      throw new MutationError("invalid", message, { [field]: message });
    }
    case "23503":
      throw new MutationError("invalid", "That employee wasn't found.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

// ---------------------------------------------------------------------------
// Raise, decide, withdraw
// ---------------------------------------------------------------------------

export interface StaffIdCorrectionResult {
  id: string;
  workerId: string;
  status: StaffIdCorrectionStatus;
  oldStaffId: string;
  newStaffId: string;
}

const RESULT_COLUMNS = "id, worker_id, status, old_staff_id, new_staff_id";

function toResult(row: {
  id: string;
  worker_id: string;
  status: StaffIdCorrectionStatus;
  old_staff_id: string;
  new_staff_id: string;
}): StaffIdCorrectionResult {
  return {
    id: row.id,
    workerId: row.worker_id,
    status: row.status,
    oldStaffId: row.old_staff_id,
    newStaffId: row.new_staff_id,
  };
}

export const requestStaffIdCorrectionSpec: MutationSpec<
  typeof requestStaffIdCorrectionSchema,
  StaffIdCorrectionResult
> = {
  schema: requestStaffIdCorrectionSchema,
  roles: STAFF_ID_CORRECTORS,
  run: async ({ supabase, organisationId, data }) => {
    // The trigger takes the old ID from the worker and checks every rule.
    const { data: row, error } = await supabase
      .from("staff_id_corrections")
      .insert({
        organisation_id: organisationId,
        worker_id: data.workerId,
        new_staff_id: data.newStaffId,
        reason: data.reason,
        // Filled from the worker by the trigger; the column is not insertable by signed-in
        // users, so it is left out here.
      } as Database["public"]["Tables"]["staff_id_corrections"]["Insert"])
      .select(RESULT_COLUMNS)
      .single();
    if (error) fromDbError(error);
    return toResult(row);
  },
};

/** Raises a correction. Nothing changes until someone else approves it. */
export function requestStaffIdCorrection(input: unknown): Promise<StaffIdCorrectionResult> {
  return mutate(requestStaffIdCorrectionSpec, input);
}

const NOT_FOUND_OR_DECIDED = "That correction wasn't found, or someone has already decided it.";

export const decideStaffIdCorrectionSpec: MutationSpec<
  typeof decideStaffIdCorrectionSchema,
  StaffIdCorrectionResult
> = {
  schema: decideStaffIdCorrectionSchema,
  roles: STAFF_ID_CORRECTORS,
  run: async ({ supabase, organisationId, data }) => {
    // The database fills in who decided, refuses the requester, re-checks every rule on
    // approval and changes the worker's staff ID in the same transaction.
    const { data: row, error } = await supabase
      .from("staff_id_corrections")
      .update({
        status: data.decision === "approve" ? "approved" : "rejected",
        decision_note: data.note,
      })
      .eq("id", data.correctionId)
      .eq("organisation_id", organisationId)
      .eq("status", "pending")
      .select(RESULT_COLUMNS)
      .maybeSingle();
    if (error) fromDbError(error, "decision");
    if (!row) throw new MutationError("invalid", NOT_FOUND_OR_DECIDED);
    return toResult(row);
  },
};

/** Approves or rejects a correction someone else raised. */
export function decideStaffIdCorrection(input: unknown): Promise<StaffIdCorrectionResult> {
  return mutate(decideStaffIdCorrectionSpec, input);
}

export const withdrawStaffIdCorrectionSpec: MutationSpec<
  typeof withdrawStaffIdCorrectionSchema,
  StaffIdCorrectionResult
> = {
  schema: withdrawStaffIdCorrectionSchema,
  roles: STAFF_ID_CORRECTORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("staff_id_corrections")
      .update({ status: "cancelled" })
      .eq("id", data.correctionId)
      .eq("organisation_id", organisationId)
      .eq("status", "pending")
      .select(RESULT_COLUMNS)
      .maybeSingle();
    if (error) fromDbError(error, "correctionId");
    if (!row) throw new MutationError("invalid", NOT_FOUND_OR_DECIDED);
    return toResult(row);
  },
};

/** The requester takes back a correction nobody has decided. */
export function withdrawStaffIdCorrection(input: unknown): Promise<StaffIdCorrectionResult> {
  return mutate(withdrawStaffIdCorrectionSpec, input);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface StaffIdCorrectionView {
  id: string;
  workerId: string;
  workerName: string;
  status: StaffIdCorrectionStatus;
  oldStaffId: string;
  newStaffId: string;
  reason: string;
  requestedBy: string;
  requestedByName: string;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const COLUMNS =
  "id, worker_id, status, old_staff_id, new_staff_id, reason, requested_by, approved_by, rejected_by, cancelled_by, decision_note, created_at, decided_at, workers!staff_id_corrections_worker_fkey ( first_name, last_name )";

const FORMER_USER = "A former user";

async function userNames(supabase: Client, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", unique);
  if (error) throw new Error(`Could not read names: ${error.message}`);
  return new Map(
    (data ?? []).flatMap((p) => (p.full_name?.trim() ? [[p.user_id, p.full_name.trim()]] : [])),
  );
}

/** Corrections in the organisation, newest first (owner, admin and hr; others see none). */
export async function loadStaffIdCorrections(
  supabase: Client,
  organisationId: string,
  filter: { workerId?: string; status?: StaffIdCorrectionStatus; limit?: number } = {},
): Promise<StaffIdCorrectionView[]> {
  let query = supabase
    .from("staff_id_corrections")
    .select(COLUMNS)
    .eq("organisation_id", organisationId)
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 100);
  if (filter.workerId) query = query.eq("worker_id", filter.workerId);
  if (filter.status) query = query.eq("status", filter.status);
  const { data, error } = await query;
  if (error) throw new Error(`Could not read staff ID corrections: ${error.message}`);
  const rows = data ?? [];
  const names = await userNames(
    supabase,
    rows.flatMap((r) =>
      [r.requested_by, r.approved_by, r.rejected_by, r.cancelled_by].filter(
        (id): id is string => id !== null,
      ),
    ),
  );
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? FORMER_USER) : null);
  return rows.map((r) => ({
    id: r.id,
    workerId: r.worker_id,
    workerName: r.workers ? `${r.workers.first_name} ${r.workers.last_name}` : "Employee",
    status: r.status,
    oldStaffId: r.old_staff_id,
    newStaffId: r.new_staff_id,
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedByName: nameOf(r.requested_by) ?? FORMER_USER,
    decidedByName: nameOf(r.approved_by ?? r.rejected_by ?? r.cancelled_by),
    decisionNote: r.decision_note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));
}

/**
 * Staff IDs no new worker may take besides the ones workers have: IDs retired by an approved
 * correction and IDs a pending correction reserves. Read by the generator for blank IDs and by
 * the import, so neither offers one the database would refuse.
 */
export async function loadRetiredStaffIds(
  supabase: Client,
  organisationId: string,
): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("staff_id_corrections")
      .select("status, old_staff_id, new_staff_id")
      .eq("organisation_id", organisationId)
      .in("status", ["approved", "pending"])
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read retired staff IDs: ${error.message}`);
    for (const row of data ?? []) {
      ids.push(row.status === "approved" ? row.old_staff_id : row.new_staff_id);
    }
    if (!data || data.length < PAGE) return ids;
  }
}
