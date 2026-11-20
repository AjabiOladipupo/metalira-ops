"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { ownContext } from "@/server/people/own-requests";

import { runAcceptConsent, runWithdrawConsent } from "./consents";
import type { WorkerActionState } from "./action-state";

/**
 * Server Actions behind the consent screen (slice 3.1): the worker agrees to or withdraws the
 * location or selfie notice. Written with the worker's own session (channel worker_app); the
 * database decides. Logs carry error names only.
 */

const copy = workerMessages.consent;

function refusal(error: unknown): WorkerActionState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
    if (error.code === "forbidden" || error.code === "invalid") {
      return { ok: false, message: error.message || copy.failed };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error("workforce.consent_failed:", cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, message: copy.failed };
}

function refresh(): void {
  revalidatePath("/m/me/consent");
  revalidatePath("/m/me");
}

/** "I agree" on a notice. */
export async function acceptConsentAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  try {
    await runAcceptConsent(await ownContext(), formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  refresh();
  return { ok: true, message: copy.agreed };
}

/** "Withdraw" on a notice the worker agreed to. */
export async function withdrawConsentAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  try {
    await runWithdrawConsent(await ownContext(), formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  refresh();
  return { ok: true, message: copy.withdrawnDone };
}
