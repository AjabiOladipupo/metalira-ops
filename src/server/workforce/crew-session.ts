import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServerSupabase } from "@/lib/supabase/server";
import { getSession, type Session } from "@/server/identity/session";
import { lookupWorkerSession, type WorkerSessionLookup } from "@/server/identity/worker-session";
import type { Database } from "@/types/db";

/**
 * Who may open crew clock-in (slice 3.6, owner decision 4): a worker login (a worker-supervisor
 * when their worker record is the line manager of a crew) or a line_manager login. The actor id
 * is the offline queue's owner id: the worker record for a worker, the membership for a line
 * manager (record_crew_punch compares it the same way). Whether the person really supervises
 * anyone, and whom, is decided by the database (private.my_crew_ids), never here.
 */

type Client = SupabaseClient<Database>;

export interface CrewSession {
  supabase: Client;
  userId: string;
  organisationId: string;
  actorId: string;
  kind: "worker" | "line_manager";
  /** For the screen's header. */
  firstName: string | null;
}

export type CrewSessionLookup =
  | { type: "crew"; session: CrewSession }
  | { type: "signed_out" }
  /** Signed in, but neither a worker nor a line manager in the active company. */
  | { type: "not_supervisor" };

export async function crewSessionFrom(
  worker: WorkerSessionLookup,
  manager: () => Promise<Session | null>,
): Promise<CrewSessionLookup> {
  const supabase = await createServerSupabase();
  if (worker.type === "worker") {
    return {
      type: "crew",
      session: {
        supabase,
        userId: worker.session.userId,
        organisationId: worker.session.organisationId,
        actorId: worker.session.workerId,
        kind: "worker",
        firstName: worker.session.firstName,
      },
    };
  }
  if (worker.type === "signed_out") return { type: "signed_out" };
  const session = await manager();
  if (!session) return { type: "signed_out" };
  if (session.active?.role !== "line_manager") return { type: "not_supervisor" };
  // The line manager's own membership, read under RLS with their session.
  const { data, error } = await supabase
    .from("memberships")
    .select("id")
    .eq("organisation_id", session.active.organisationId)
    .eq("user_id", session.user.id)
    .eq("role", "line_manager")
    .maybeSingle();
  if (error) throw new Error(`Could not load the line manager login (${error.code})`);
  if (!data) return { type: "not_supervisor" };
  return {
    type: "crew",
    session: {
      supabase,
      userId: session.user.id,
      organisationId: session.active.organisationId,
      actorId: data.id,
      kind: "line_manager",
      firstName: session.user.fullName?.split(/\s+/)[0] ?? null,
    },
  };
}

/** For Server Actions: the user is verified with the Auth server. */
export async function lookupCrewSession(): Promise<CrewSessionLookup> {
  return crewSessionFrom(await lookupWorkerSession(), getSession);
}
