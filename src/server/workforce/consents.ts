import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { CONSENT_KINDS, CONSENT_NOTICES, type ConsentKind } from "@/lib/messages/consent";
import { workerMessages } from "@/lib/messages/worker";
import { MutationError } from "@/server/identity/mutate";
import type { OwnContext } from "@/server/people/own-requests";

/**
 * Location and selfie consents from the worker app (slice 3.1). The worker writes with their
 * own session through public.accept_worker_consent and public.withdraw_worker_consent; the
 * organisation and worker come from the session, never from the form, and the database checks
 * them again. The notice version is the one the screen showed (src/lib/messages/consent.ts).
 */

const copy = workerMessages.consent;

export const consentKindSchema = z.object({
  kind: z.enum(CONSENT_KINDS, { error: copy.failed }),
});

export interface MyConsent {
  kind: ConsentKind;
  /** When the open consent was given, or null when there is none. */
  acceptedAt: string | null;
  /** The notice version of the open consent. */
  noticeVersion: string | null;
  /** When the last consent was withdrawn, if the latest row is withdrawn. */
  withdrawnAt: string | null;
}

function fromDbError(error: PostgrestError): never {
  switch (error.code) {
    case "MLCN1":
    case "42501":
      throw new MutationError("forbidden", copy.failed);
    case "MLCN2":
      throw new MutationError("invalid", copy.left);
    case "MLCN3":
      throw new MutationError("invalid", copy.failed);
  }
  throw new Error(`Database refused the consent (${error.code})`);
}

/** The worker's current state for each kind, read with their own session. */
export async function loadMyConsents(ctx: Pick<OwnContext, "supabase" | "workerId">) {
  const { data, error } = await ctx.supabase
    .from("worker_consents")
    .select("kind, notice_version, accepted_at, withdrawn_at")
    .eq("worker_id", ctx.workerId)
    .order("accepted_at", { ascending: false });
  if (error) throw new Error(`Could not load consents (${error.code})`);
  return CONSENT_KINDS.map((kind): MyConsent => {
    const latest = (data ?? []).find((row) => row.kind === kind);
    const open = latest && latest.withdrawn_at === null ? latest : null;
    return {
      kind,
      acceptedAt: open?.accepted_at ?? null,
      noticeVersion: open?.notice_version ?? null,
      withdrawnAt: latest?.withdrawn_at ?? null,
    };
  });
}

export async function runAcceptConsent(ctx: OwnContext, input: unknown): Promise<void> {
  const parsed = consentKindSchema.safeParse(input);
  if (!parsed.success) throw new MutationError("invalid", copy.failed);
  const { kind } = parsed.data;
  const { error } = await ctx.supabase.rpc("accept_worker_consent", {
    p_organisation_id: ctx.organisationId,
    p_kind: kind,
    p_notice_version: CONSENT_NOTICES[kind].version,
  });
  if (error) fromDbError(error);
}

export async function runWithdrawConsent(ctx: OwnContext, input: unknown): Promise<void> {
  const parsed = consentKindSchema.safeParse(input);
  if (!parsed.success) throw new MutationError("invalid", copy.failed);
  const { error } = await ctx.supabase.rpc("withdraw_worker_consent", {
    p_organisation_id: ctx.organisationId,
    p_kind: parsed.data.kind,
  });
  if (error) fromDbError(error);
}
