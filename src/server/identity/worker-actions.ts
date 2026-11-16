"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { WORKER_HOME_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/server/supabase/admin";

import type { FormState } from "./form-state";
import { formFields } from "./schemas";
import { hashPin, newPinSchema } from "./pin";
import { ensureWorkerAuthUser, openWorkerSession } from "./worker-login";
import {
  checkWorkerPin,
  clientIp,
  databaseSignInStore,
  ipKey,
  workerSignInSchema,
} from "./worker-sign-in";

/**
 * Server Actions for the worker app: PIN sign-in, accepting an invite (setting the PIN) and
 * signing out. The PIN check, attempt counting and invite use run through the secret-key
 * client, because the worker has no session yet; the session is opened only after the PIN
 * check passes (worker-login.ts). Logs carry error codes only, never what was typed.
 */

const copy = workerMessages;

function configured(): boolean {
  try {
    getSupabasePublicEnv();
    return true;
  } catch {
    return false;
  }
}

function invalid(error: z.ZodError, values: Record<string, string>): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { ok: false, fieldErrors, values };
}

function logFailure(event: string, error: unknown): void {
  console.error(
    event,
    error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
  );
}

export async function signInWorker(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = formFields(formData);
  const values = { companyCode: fields.companyCode ?? "", staffId: fields.staffId ?? "" };
  const parsed = workerSignInSchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error, values);
  if (!configured()) return { ok: false, formError: copy.signIn.notConfigured, values };

  let admin: ReturnType<typeof createAdminSupabase>;
  try {
    admin = createAdminSupabase();
  } catch (error) {
    logFailure("worker_auth.sign_in_unavailable:", error);
    return { ok: false, formError: copy.signIn.notConfigured, values };
  }

  const ip = clientIp(await headers());
  let result: Awaited<ReturnType<typeof checkWorkerPin>>;
  try {
    result = await checkWorkerPin(databaseSignInStore(admin), parsed.data, ipKey(ip));
  } catch (error) {
    logFailure("worker_auth.sign_in_failed:", error);
    return { ok: false, formError: copy.signIn.unavailable, values };
  }

  if (result.status === "locked") return { ok: false, formError: copy.signIn.locked, values };
  if (result.status === "ip_blocked")
    return { ok: false, formError: copy.signIn.ipBlocked, values };
  if (result.status === "invalid") return { ok: false, formError: copy.signIn.invalid, values };

  const supabase = await createServerSupabase();
  const opened = await openWorkerSession(admin, supabase, result).catch((error: unknown) => {
    logFailure("worker_auth.session_failed:", error);
    return false;
  });
  if (!opened) return { ok: false, formError: copy.signIn.unavailable, values };
  redirect(WORKER_HOME_PATH);
}

const acceptInviteSchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{64}$/, copy.invite.invalid),
    pin: newPinSchema,
    pinConfirm: z.string(),
    notice: z.literal("yes", { error: copy.invite.noticeRequired }),
  })
  .refine((v) => v.pin === v.pinConfirm, {
    path: ["pinConfirm"],
    message: copy.invite.pinMismatch,
  });

const INVITE_STATE_MESSAGES: Record<string, string> = {
  used: copy.invite.used,
  revoked: copy.invite.revoked,
  expired: copy.invite.expired,
  ended: copy.invite.ended,
};

/** Database refusals from public.accept_worker_invite, by error code. */
const ACCEPT_ERRORS: Record<string, string> = {
  MLWI1: copy.invite.invalid,
  MLWI2: copy.invite.used,
  MLWI3: copy.invite.revoked,
  MLWI4: copy.invite.expired,
  MLWI5: copy.invite.ended,
};

/**
 * Uses an invite: checks it, creates (or, for a PIN reset, resets) the worker's login, stores
 * the PIN hash and the membership in one database call, then signs the worker in.
 */
export async function acceptWorkerInvite(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = formFields(formData);
  const parsed = acceptInviteSchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error, {});
  if (!configured()) return { ok: false, formError: copy.signIn.notConfigured };

  const { token, pin } = parsed.data;
  let workerId: string;
  let authUserId: string;
  let admin: ReturnType<typeof createAdminSupabase>;
  try {
    admin = createAdminSupabase();
    const lookup = await admin.rpc("worker_invite_lookup", { p_token: token }).maybeSingle();
    if (lookup.error) throw new Error(`Invite lookup failed: ${lookup.error.code}`);
    const invite = lookup.data;
    if (!invite) return { ok: false, formError: copy.invite.invalid };
    if (invite.state !== "valid") {
      return { ok: false, formError: INVITE_STATE_MESSAGES[invite.state] ?? copy.invite.invalid };
    }

    workerId = invite.worker_id;
    authUserId = await ensureWorkerAuthUser(admin, {
      workerId,
      fullName: `${invite.first_name} ${invite.last_name}`,
      existingAuthUserId: invite.auth_user_id ?? null,
    });
    const accepted = await admin.rpc("accept_worker_invite", {
      p_token: token,
      p_auth_user_id: authUserId,
      p_pin_hash: await hashPin(pin),
    });
    if (accepted.error) {
      const message = ACCEPT_ERRORS[accepted.error.code];
      if (message) return { ok: false, formError: message };
      throw new Error(`Invite was not used: ${accepted.error.code}`);
    }
  } catch (error) {
    logFailure("worker_auth.invite_failed:", error);
    return { ok: false, formError: copy.invite.failed };
  }

  const supabase = await createServerSupabase();
  const opened = await openWorkerSession(admin, supabase, { workerId, authUserId }).catch(
    (error: unknown) => {
      logFailure("worker_auth.session_failed:", error);
      return false;
    },
  );
  redirect(opened ? WORKER_HOME_PATH : `${WORKER_SIGN_IN_PATH}?pin=set`);
}

export async function signOutWorker(): Promise<void> {
  if (configured()) {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut({ scope: "local" });
  }
  redirect(WORKER_SIGN_IN_PATH);
}
