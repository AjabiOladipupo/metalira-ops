import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/types/db";

import { pinSchema, verifyPin } from "./pin";

/**
 * Worker PIN sign-in (owner decision 6), apart from the session itself so it can be unit
 * tested. The database counts attempts and holds the lock (public.worker_sign_in_begin and
 * worker_sign_in_finish); this module checks the PIN in between and turns the result into one
 * of a few answers. The answers never say whether the company code or staff ID exists: an
 * unknown pair is checked against a dummy hash, counted and locked exactly like a real one.
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

export type BeginResult =
  | { outcome: "ip_blocked" | "locked" }
  | {
      outcome: "proceed";
      /** The worker with a login, or null for a company code and staff ID with none. */
      login: { workerId: string; organisationId: string; authUserId: string } | null;
      pinHash: string | null;
      /** True when a wrong PIN now locks sign-in (the 5th try in a row). */
      locksOnFailure: boolean;
    };

export interface WorkerSignInStore {
  begin(companyCode: string, staffId: string, ipKey: string): Promise<BeginResult>;
  finish(
    workerId: string | null,
    ok: boolean,
    ipKey: string,
  ): Promise<"signed_in" | "failed" | "locked">;
}

export type WorkerSignInResult =
  | { status: "signed_in"; workerId: string; organisationId: string; authUserId: string }
  /** Wrong PIN, or an unknown company code or staff ID. Never say which. */
  | { status: "invalid" }
  | { status: "locked" }
  | { status: "ip_blocked" };

/** The network address as a counter key: hashed, so the raw address is never stored. */
export function ipKey(ip: string | null | undefined): string {
  return createHash("sha256")
    .update(`ip|${(ip ?? "").trim().toLowerCase() || "unknown"}`)
    .digest("hex");
}

/**
 * The client address from the request headers. On Vercel `x-real-ip` and the first
 * `x-forwarded-for` entry are set by the platform; elsewhere they may be missing, and every
 * request then shares one counter.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : null;
}

export async function checkWorkerPin(
  store: WorkerSignInStore,
  input: WorkerSignInInput,
  network: string,
  verify: (pin: string, hash: string | null) => Promise<boolean> = verifyPin,
): Promise<WorkerSignInResult> {
  const begun = await store.begin(input.companyCode, input.staffId, network);
  if (begun.outcome !== "proceed") return { status: begun.outcome };

  const ok = await verify(input.pin, begun.pinHash);
  const login = begun.login;
  // Called for unknown IDs too, so both paths make the same round trips.
  const finished = await store.finish(login?.workerId ?? null, ok && login !== null, network);

  if (login && ok && finished === "signed_in") {
    return { status: "signed_in", ...login };
  }
  if (finished === "locked" || begun.locksOnFailure) return { status: "locked" };
  return { status: "invalid" };
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
      if (data.outcome === "ip_blocked" || data.outcome === "locked") {
        return { outcome: data.outcome };
      }
      if (data.outcome !== "proceed") throw new Error("Sign-in check returned an unknown outcome.");
      return {
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
      };
    },
    async finish(workerId, ok, network) {
      const { data, error } = await admin.rpc("worker_sign_in_finish", {
        // The generated type says string; the function takes null for an unknown pair.
        p_worker_id: workerId as string,
        p_ok: ok,
        p_ip_key: network,
      });
      if (error) throw new Error(`Sign-in result was not saved: ${error.code}`);
      if (data === "signed_in" || data === "failed" || data === "locked") return data;
      throw new Error("Sign-in result returned an unknown outcome.");
    },
  };
}
