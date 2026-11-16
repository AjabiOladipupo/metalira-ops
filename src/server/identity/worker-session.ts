import "server-only";

import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { APP_HOME_PATH, WORKER_HOME_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";

export interface WorkerSession {
  userId: string;
  workerId: string;
  organisationId: string;
  organisationName: string;
  firstName: string;
  lastName: string;
  staffId: string;
}

export type WorkerSessionLookup =
  | { type: "worker"; session: WorkerSession }
  | { type: "signed_out" }
  /** Signed in, but not as a worker (a manager's login). */
  | { type: "not_worker" }
  /** A `worker` membership with no worker record linked (added by hand, not by an invite). */
  | { type: "unlinked" };

function supabaseConfigured(): boolean {
  try {
    getSupabasePublicEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * The signed-in worker: their `worker` membership and their own worker row, read with their own
 * session under RLS (never the secret key). Read once per request. Reads cookies: call it
 * inside a <Suspense> boundary, a Server Function or a Route Handler.
 */
export const lookupWorkerSession = cache(async (): Promise<WorkerSessionLookup> => {
  await connection();
  if (!supabaseConfigured()) return { type: "signed_out" };

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { type: "signed_out" };
  const userId = data.user.id;

  const memberships = await supabase
    .from("memberships")
    .select("organisation_id, worker_id, organisations ( name )")
    .eq("user_id", userId)
    .eq("role", "worker");
  if (memberships.error) {
    throw new Error(`Could not load the worker login: ${memberships.error.code}`);
  }
  const rows = memberships.data ?? [];
  if (rows.length === 0) return { type: "not_worker" };
  const row = rows.find((m) => m.worker_id !== null && m.organisations !== null);
  if (!row?.worker_id || !row.organisations) return { type: "unlinked" };

  const worker = await supabase
    .from("workers")
    .select("first_name, last_name, staff_id")
    .eq("id", row.worker_id)
    .maybeSingle();
  if (worker.error) throw new Error(`Could not load the worker: ${worker.error.code}`);
  if (!worker.data) return { type: "unlinked" };

  return {
    type: "worker",
    session: {
      userId,
      workerId: row.worker_id,
      organisationId: row.organisation_id,
      organisationName: row.organisations.name,
      firstName: worker.data.first_name,
      lastName: worker.data.last_name,
      staffId: worker.data.staff_id,
    },
  };
});

/**
 * Gate for a worker-app page: signed out goes to /m/sign-in, a manager's login to the manager
 * app, and a worker login with no worker record to the worker home, which explains. The proxy
 * makes the same check optimistically; this one reads the membership. Not for /m itself.
 */
export async function requireWorkerSession(): Promise<WorkerSession> {
  const lookup = await lookupWorkerSession();
  if (lookup.type === "signed_out") redirect(WORKER_SIGN_IN_PATH);
  if (lookup.type === "not_worker") redirect(APP_HOME_PATH);
  if (lookup.type === "unlinked") redirect(WORKER_HOME_PATH);
  return lookup.session;
}
