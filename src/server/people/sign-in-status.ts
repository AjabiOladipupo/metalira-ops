import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { SignInCredential } from "@/lib/pin-lockout";
import type { ManagerRole } from "@/lib/roles";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

/**
 * A worker's phone sign-in as their managers see it (slice 1.11, owner decision 18): the lock,
 * the hold after 3 lockouts in 24 hours, and "Unlock sign-in". The database decides who may
 * unlock (public.unlock_worker_sign_in: owner, admin, hr, or the worker's own line manager,
 * never their own login) and writes the audit row; `mutate()` lets those roles through to it.
 */

/** Roles that may try an unlock. The database narrows line managers to their own reportees. */
export const SIGN_IN_UNLOCKERS = [
  "owner",
  "admin",
  "hr",
  "line_manager",
] as const satisfies readonly ManagerRole[];

/** Roles that may send a new invite (and so lift a hold): the invite page's roles. */
export const NEW_PIN_ROLES = ["owner", "admin", "hr"] as const satisfies readonly ManagerRole[];

type Client = SupabaseClient<Database>;

/** The worker's login as the caller's RLS shows it, or null when there is none (or none visible). */
export async function loadSignInCredential(
  supabase: Client,
  organisationId: string,
  workerId: string,
): Promise<SignInCredential | null> {
  const { data, error } = await supabase
    .from("worker_credentials")
    .select("pin_set_at, last_sign_in_at, failed_attempts, locked_until, held_at")
    .eq("organisation_id", organisationId)
    .eq("worker_id", workerId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the sign-in status: ${error.code}`);
  if (!data) return null;
  return {
    pinSetAt: data.pin_set_at,
    lastSignInAt: data.last_sign_in_at,
    failedAttempts: data.failed_attempts,
    lockedUntil: data.locked_until,
    heldAt: data.held_at,
  };
}

export const unlockSignInSchema = z.object({ workerId: z.uuid("Choose an employee") });

function fromDbError(error: PostgrestError): never {
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", error.message || "Your role can't unlock sign-in.");
    case "MLPN1":
    case "MLPN2":
    case "MLPN3":
      throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the unlock (${error.code}): ${error.message}`);
}

export const unlockSignInSpec: MutationSpec<typeof unlockSignInSchema, { workerId: string }> = {
  schema: unlockSignInSchema,
  roles: SIGN_IN_UNLOCKERS,
  run: async ({ supabase, organisationId, data }) => {
    // The function writes the worker_auth.unlocked audit row in the same transaction.
    const { error } = await supabase.rpc("unlock_worker_sign_in", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
    });
    if (error) fromDbError(error);
    return { workerId: data.workerId };
  },
};

/** Lifts a 15-minute sign-in lock early. A hold needs a new PIN instead. */
export function unlockSignIn(input: unknown): Promise<{ workerId: string }> {
  return mutate(unlockSignInSpec, input);
}
