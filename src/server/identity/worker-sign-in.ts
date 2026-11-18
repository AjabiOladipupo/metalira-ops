import "server-only";

import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { derivePiiSubkey } from "@/server/crypto/pii";
import type { Database } from "@/types/db";

import { pinSchema, verifyPin } from "./pin";

/**
 * Worker PIN sign-in (owner decisions 6 and 18), apart from the session itself so it can be
 * unit tested. The database counts attempts and holds the locks (public.worker_sign_in_begin
 * and worker_sign_in_finish): 5 wrong PINs in a row lock for 15 minutes, the 3rd lockout in 24
 * hours holds sign-in until a new PIN, and a company code past its cap of wrong PINs is refused
 * for the rest of the window (limits in src/lib/pin-lockout.ts). This module checks the PIN in
 * between and turns the result into one of a few answers. The answers never say whether the
 * company code or staff ID exists: an unknown pair is checked against a dummy hash, counted,
 * locked and held exactly like a real one.
 */

export const workerSignInSchema = z.object({
  companyCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Enter your company code.")
    .max(64, "Check your company code."),
  staffId: z.string().trim().min(1, "Enter your staff ID.").max(64, "Check your staff ID."),
  pin: pinSchema,
});

export type WorkerSignInInput = z.output<typeof workerSignInSchema>;

/** Refusals decided before any PIN is checked. */
export type RefusedOutcome = "ip_blocked" | "locked" | "held" | "company_throttled";

/**
 * Set once after a real company reached its cap on wrong PINs, whatever the outcome: the server
 * emails its owners and HR (one alert per capped window). Never shown to the person signing in.
 */
export interface SignInAlert {
  alertOrganisationId?: string | null;
}

export type BeginResult = SignInAlert &
  (
    | { outcome: RefusedOutcome }
    | {
        outcome: "proceed";
        /** The worker with a login, or null for a company code and staff ID with none. */
        login: { workerId: string; organisationId: string; authUserId: string } | null;
        pinHash: string | null;
        /** True when a wrong PIN now locks sign-in (the 5th try in a row). */
        locksOnFailure: boolean;
        /**
         * True when that lock is the 3rd in 24 hours and holds sign-in until a new PIN. Only a
         * guide for an unknown pair: for a real login, finish decides (the window may have
         * been capped meanwhile).
         */
        holdsOnFailure: boolean;
        /** When begin reserved the try; finish releases the reservation only in that window. */
        begunAt?: string | null;
      }
  );

export type FinishOutcome = "signed_in" | "failed" | "locked" | "held";

/** finish's answer, with the alert when this wrong PIN reached the company cap. */
export type FinishResult = SignInAlert & { outcome: FinishOutcome };

export interface WorkerSignInStore {
  begin(companyCode: string, staffId: string, ipKey: string): Promise<BeginResult>;
  finish(
    workerId: string | null,
    ok: boolean,
    ipKey: string,
    begunAt?: string | null,
  ): Promise<FinishOutcome | FinishResult>;
}

const finishResult = (r: FinishOutcome | FinishResult): FinishResult =>
  typeof r === "string" ? { outcome: r } : r;

export type WorkerSignInResult = SignInAlert &
  (
    | { status: "signed_in"; workerId: string; organisationId: string; authUserId: string }
    /** Wrong PIN, or an unknown company code or staff ID. Never say which. */
    | { status: "invalid" }
    | { status: "locked" }
    /** Locked 3 times in 24 hours: only a new PIN from an HR invite opens it. */
    | { status: "held" }
    | { status: "ip_blocked" }
    /** Too many wrong PINs for this company code just now; no worker was counted. */
    | { status: "company_throttled" }
  );

/**
 * The network address as a counter key: an HMAC with a server-side key, so the stored value
 * can't be turned back into the address by trying every IPv4 address. Throws PiiKeyError when
 * the personal data key is not configured.
 */
export function ipKey(ip: string | null | undefined): string {
  return createHmac("sha256", derivePiiSubkey("sign-in-network-key"))
    .update((ip ?? "").trim().toLowerCase() || "unknown")
    .digest("hex");
}

/**
 * The client address: `x-real-ip`, which Vercel sets itself. Never `x-forwarded-for`, which
 * the client controls (CLAUDE.md). Without it every request shares one counter.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const real = headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : null;
}

export async function checkWorkerPin(
  store: WorkerSignInStore,
  input: WorkerSignInInput,
  network: string,
  verify: (pin: string, hash: string | null) => Promise<boolean> = verifyPin,
): Promise<WorkerSignInResult> {
  const begun = await store.begin(input.companyCode, input.staffId, network);
  const { result, alertOrganisationId } = await checkBegun(store, begun, input, network, verify);
  // At most one of begin and finish carries the alert (the database hands it out once).
  const alert = begun.alertOrganisationId ?? alertOrganisationId;
  return alert ? { ...result, alertOrganisationId: alert } : result;
}

async function checkBegun(
  store: WorkerSignInStore,
  begun: BeginResult,
  input: WorkerSignInInput,
  network: string,
  verify: (pin: string, hash: string | null) => Promise<boolean>,
): Promise<{ result: WorkerSignInResult; alertOrganisationId?: string | null }> {
  if (begun.outcome !== "proceed") return { result: { status: begun.outcome } };

  const login = begun.login;
  let ok: boolean;
  try {
    ok = await verify(input.pin, begun.pinHash);
  } catch (error) {
    // begin may already have set a lock: record the try as failed so the lock is audited and
    // counted towards a hold, then report the failure.
    await store
      .finish(login?.workerId ?? null, false, network, begun.begunAt)
      .catch(() => undefined);
    throw error;
  }
  // Called for unknown IDs too, so both paths make the same round trips.
  const done = finishResult(
    await store.finish(login?.workerId ?? null, ok && login !== null, network, begun.begunAt),
  );
  const alertOrganisationId = done.alertOrganisationId;
  const finished = done.outcome;
  const reply = (result: WorkerSignInResult) => ({ result, alertOrganisationId });

  if (login) {
    // A real login: finish has the last word (the window may have been capped since begin, in
    // which case the lockout doesn't count towards a hold).
    if (ok && finished === "signed_in") return reply({ status: "signed_in", ...login });
    if (finished === "held") return reply({ status: "held" });
    if (finished === "locked") return reply({ status: "locked" });
    return reply({ status: "invalid" });
  }
  // An unknown pair: begin decided the lock and hold, the same answers a real login gets.
  if (begun.locksOnFailure && begun.holdsOnFailure) return reply({ status: "held" });
  if (begun.locksOnFailure) return reply({ status: "locked" });
  return reply({ status: "invalid" });
}

type Admin = SupabaseClient<Database>;

/** The sign-in store backed by the database, through the secret-key client. */
export function databaseSignInStore(admin: Admin): WorkerSignInStore {
  return {
    async begin(companyCode, staffId, network) {
      const { data, error } = await admin
        .rpc("worker_sign_in_begin", {
          p_company_code: companyCode,
          p_staff_id: staffId,
          p_ip_key: network,
        })
        .single();
      if (error || !data) throw new Error(`Sign-in check failed: ${error?.code ?? "no row"}`);
      const alert: SignInAlert = data.alert_organisation_id
        ? { alertOrganisationId: data.alert_organisation_id }
        : {};
      if (
        data.outcome === "ip_blocked" ||
        data.outcome === "locked" ||
        data.outcome === "held" ||
        data.outcome === "company_throttled"
      ) {
        return { outcome: data.outcome, ...alert };
      }
      if (data.outcome !== "proceed") throw new Error("Sign-in check returned an unknown outcome.");
      return {
        ...alert,
        outcome: "proceed",
        login:
          data.worker_id && data.organisation_id && data.auth_user_id
            ? {
                workerId: data.worker_id,
                organisationId: data.organisation_id,
                authUserId: data.auth_user_id,
              }
            : null,
        pinHash: data.pin_hash ?? null,
        locksOnFailure: data.locks_on_failure === true,
        holdsOnFailure: data.holds_on_failure === true,
        begunAt: data.begun_at ?? null,
      };
    },
    async finish(workerId, ok, network, begunAt) {
      const { data, error } = await admin
        .rpc("worker_sign_in_finish", {
          // The generated type says string; the function takes null for an unknown pair.
          p_worker_id: workerId as string,
          p_ok: ok,
          p_ip_key: network,
          ...(begunAt ? { p_begun_at: begunAt } : {}),
        })
        .single();
      if (error || !data)
        throw new Error(`Sign-in result was not saved: ${error?.code ?? "no row"}`);
      const outcome = data.outcome;
      if (
        outcome === "signed_in" ||
        outcome === "failed" ||
        outcome === "locked" ||
        outcome === "held"
      ) {
        return data.alert_organisation_id
          ? { outcome, alertOrganisationId: data.alert_organisation_id }
          : { outcome };
      }
      throw new Error("Sign-in result returned an unknown outcome.");
    },
  };
}
