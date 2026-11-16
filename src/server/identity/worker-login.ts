import "server-only";

import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { WORKER_LOGIN_MARK } from "@/lib/auth/routes";
import type { Database } from "@/types/db";

/**
 * A worker's login (owner decision 4): one Supabase Auth user per worker with a synthetic,
 * non-deliverable email address. Workers never see or type it. They sign in with company code,
 * staff ID and PIN; after the PIN check the server opens the session itself (openWorkerSession).
 *
 * - The address uses the reserved `.invalid` top-level domain (RFC 2606), so no email can ever
 *   be delivered to it, and it names the worker row only by its random id.
 * - `app_metadata.login = "worker"` marks the user as a worker login. Only the secret key can
 *   write app_metadata, so the proxy can trust it (src/lib/auth/routes.ts), and
 *   public.accept_worker_invite refuses any user without it.
 * - The user has no usable password. On a PIN reset the server sets a new random one and
 *   restores the synthetic address, undoing anything a signed-in session may have changed.
 */

type Admin = SupabaseClient<Database>;

export const WORKER_LOGIN_DOMAIN = "workers.metalira.invalid";

export function workerLoginEmail(workerId: string): string {
  return `w-${workerId.toLowerCase()}@${WORKER_LOGIN_DOMAIN}`;
}

const appMetadata = { [WORKER_LOGIN_MARK.key]: WORKER_LOGIN_MARK.value };

function unusablePassword(): string {
  return `${randomBytes(48).toString("base64url")}a1`;
}

/**
 * The worker's Auth user id: the existing login when there is one (a PIN reset, which also
 * resets the address and password), otherwise a new user. A user left behind by an earlier
 * attempt that failed after creating it is found by its address and reused.
 */
export async function ensureWorkerAuthUser(
  admin: Admin,
  worker: { workerId: string; fullName: string; existingAuthUserId: string | null },
): Promise<string> {
  const email = workerLoginEmail(worker.workerId);

  if (worker.existingAuthUserId) {
    const { error } = await admin.auth.admin.updateUserById(worker.existingAuthUserId, {
      email,
      email_confirm: true,
      password: unusablePassword(),
      app_metadata: appMetadata,
    });
    if (error) throw new Error(`Could not reset the worker login: ${error.code ?? error.status}`);
    return worker.existingAuthUserId;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: appMetadata,
    user_metadata: { full_name: worker.fullName },
  });
  if (!error && data.user) return data.user.id;

  if (error?.code === "email_exists" || error?.code === "user_already_exists") {
    // generateLink returns the user for an address without sending anything.
    const found = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const user = found.data.user;
    if (
      !found.error &&
      user &&
      user.app_metadata?.[WORKER_LOGIN_MARK.key] === WORKER_LOGIN_MARK.value
    ) {
      return user.id;
    }
  }
  throw new Error(`Could not create the worker login: ${error?.code ?? "no user"}`);
}

/**
 * Opens a session for the worker's login on `supabase`, the request's cookie-writing client:
 * the secret key makes a one-time sign-in token (nothing is sent anywhere), and the request
 * client exchanges it, which sets the session cookies. Call only after the PIN check passed.
 * The session must belong to `login.authUserId` (the user on the worker's credentials);
 * anything else is signed out again and reported as a failure.
 */
export async function openWorkerSession(
  admin: Admin,
  supabase: SupabaseClient<Database>,
  login: { workerId: string; authUserId: string },
): Promise<boolean> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: workerLoginEmail(login.workerId),
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash || data.user?.id !== login.authUserId) return false;
  const verified = await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash });
  if (verified.error || !verified.data.session) return false;
  if (verified.data.user?.id !== login.authUserId) {
    await supabase.auth.signOut({ scope: "local" });
    return false;
  }
  return true;
}
