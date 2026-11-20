import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { WorkerChangeRequestStatus, WorkerChangeTopic } from "@/lib/worker-requests";
import { hasPersonalNumber } from "@/lib/worker-requests";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

import { PEOPLE_EDITORS } from "./workers";

/**
 * Change requests a worker sends from the worker app (slice 1.10), as HR sees them on the
 * worker page. A request changes nothing: HR edits the record as usual, then marks the request
 * done, or declines it with a note the worker sees. Only owner, admin and hr read them (RLS).
 */

type Client = SupabaseClient<Database>;

/** Who reads and deals with change requests: the people who edit employees. */
export const CHANGE_REQUEST_HANDLERS = PEOPLE_EDITORS;

export interface ChangeRequestView {
  id: string;
  workerId: string;
  topic: WorkerChangeTopic;
  details: string;
  status: WorkerChangeRequestStatus;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** A worker's requests, open ones first, then the most recent. */
export async function loadChangeRequests(
  supabase: Client,
  organisationId: string,
  workerId: string,
  limit = 10,
): Promise<ChangeRequestView[]> {
  const { data, error } = await supabase
    .from("worker_change_requests")
    .select("id, worker_id, topic, details, status, resolution_note, created_at, resolved_at")
    .eq("organisation_id", organisationId)
    .eq("worker_id", workerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read change requests: ${error.message}`);
  const rows = (data ?? []).map((r) => ({
    id: r.id,
    workerId: r.worker_id,
    topic: r.topic,
    details: r.details,
    status: r.status,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
  // Stable: open requests keep their newest-first order ahead of the rest.
  return [...rows.filter((r) => r.status === "open"), ...rows.filter((r) => r.status !== "open")];
}

export const resolveChangeRequestSchema = z.object({
  requestId: z.uuid("Choose a request"),
  decision: z.enum(["done", "declined"], "Choose done or declined"),
  note: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z
      .string()
      .trim()
      .max(500, "Note must be 500 characters or fewer")
      .regex(/^[^\p{Cc}<>]*$/u, "Note must be plain text, without < or >")
      .refine((v) => !hasPersonalNumber(v), "Leave personal numbers out of the note")
      .nullish(),
  ),
});

export const resolveChangeRequestSpec: MutationSpec<
  typeof resolveChangeRequestSchema,
  { id: string; workerId: string; status: WorkerChangeRequestStatus }
> = {
  module: "people",
  schema: resolveChangeRequestSchema,
  roles: CHANGE_REQUEST_HANDLERS,
  run: async ({ supabase, organisationId, data }) => {
    // The database fills in who and when, and refuses a request already dealt with.
    const { data: row, error } = await supabase
      .from("worker_change_requests")
      .update({ status: data.decision, resolution_note: data.note ?? null })
      .eq("id", data.requestId)
      .eq("organisation_id", organisationId)
      .eq("status", "open")
      .select("id, worker_id, status")
      .maybeSingle();
    if (error) {
      if (error.code === "42501") {
        throw new MutationError("forbidden", "Your role can't deal with change requests.");
      }
      throw new Error(`Database refused the change (${error.code}): ${error.message}`);
    }
    if (!row) {
      throw new MutationError(
        "invalid",
        "That request wasn't found, or someone has already dealt with it.",
      );
    }
    return { id: row.id, workerId: row.worker_id, status: row.status };
  },
};

/** Marks a worker's change request done or declined. Owner, admin and hr only. */
export function resolveChangeRequest(input: unknown) {
  return mutate(resolveChangeRequestSpec, input);
}
