import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { APP_HOME_PATH, WORKER_HOME_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Database } from "@/types/db";

import { claimsUser } from "./claims";

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
 * The worker login of `userId`: their `worker` membership, its organisation and their own worker
 * row, in one embedded read under RLS with the caller's own client (never the secret key).
 * The worker row comes through the composite FK (organisation_id, worker_id), so it is always in
 * the membership's own organisation. A worker row RLS hides (an ended worker) reads as unlinked.
 */
export async function resolveWorkerSession(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<WorkerSessionLookup> {
  const memberships = await supabase
    .from("memberships")
    .select(
      "organisation_id, worker_id, organisations ( name ), workers!memberships_worker_fkey ( first_name, last_name, staff_id )",
    )
    .eq("user_id", userId)
    .eq("role", "worker");
  if (memberships.error) {
    throw new Error(`Could not load the worker login: ${memberships.error.code}`);
  }
  const rows = memberships.data ?? [];
  if (rows.length === 0) return { type: "not_worker" };
  const row = rows.find((m) => m.worker_id !== null && m.organisations !== null);
  if (!row?.worker_id || !row.organisations || !row.workers) return { type: "unlinked" };

  return {
    type: "worker",
    session: {
      userId,
      workerId: row.worker_id,
      organisationId: row.organisation_id,
      organisationName: row.organisations.name,
      firstName: row.workers.first_name,
      lastName: row.workers.last_name,
      staffId: row.workers.staff_id,
    },
  };
}

/**
 * The signed-in worker, verified with the Auth server (`auth.getUser()`), so a revoked session
 * is not trusted even if its JWT has not expired. For Server Actions, Route Handlers and
 * anything that writes. Read once per request. Reads cookies: call it inside a <Suspense>
 * boundary, a Server Function or a Route Handler.
 */
export const lookupWorkerSession = cache(async (): Promise<WorkerSessionLookup> => {
  await connection();
  if (!supabaseConfigured()) return { type: "signed_out" };

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { type: "signed_out" };
  return resolveWorkerSession(supabase, data.user.id);
});

/**
 * The signed-in worker for rendering a page: the user id comes from `auth.getClaims()`, which
 * checks the access token's signature locally (asymmetric keys), saving a call to the Auth
 * server on every page. The membership and worker rows are still read live under RLS, so a
 * removed membership or an ended worker takes effect at once. Never use it for a write: a
 * separate cache entry from lookupWorkerSession, so an action never sees this weaker result.
 */
export const lookupWorkerPageSession = cache(async (): Promise<WorkerSessionLookup> => {
  await connection();
  if (!supabaseConfigured()) return { type: "signed_out" };

  const supabase = await createServerSupabase();
  const user = await claimsUser(supabase);
  if (!user) return { type: "signed_out" };
  return resolveWorkerSession(supabase, user.id);
});

function gate(lookup: WorkerSessionLookup): WorkerSession {
  if (lookup.type === "signed_out") redirect(WORKER_SIGN_IN_PATH);
  if (lookup.type === "not_worker") redirect(APP_HOME_PATH);
  if (lookup.type === "unlinked") redirect(WORKER_HOME_PATH);
  return lookup.session;
}

/**
 * Gate for a worker-app Server Function: signed out goes to /m/sign-in, a manager's login to the
 * manager app, and a worker login with no worker record to the worker home, which explains.
 */
export async function requireWorkerSession(): Promise<WorkerSession> {
  return gate(await lookupWorkerSession());
}

/**
 * Gate for a worker-app page (render only), with the same redirects as requireWorkerSession.
 * The proxy makes the same check optimistically; this one reads the membership. Not for /m.
 */
export async function requireWorkerPageSession(): Promise<WorkerSession> {
  return gate(await lookupWorkerPageSession());
}
