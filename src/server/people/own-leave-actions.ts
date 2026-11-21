"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import type { WorkerActionState } from "@/server/workforce/action-state";

import { notifyLeaveDeciders } from "./leave-notices";
import { runCancelOwnLeave, runRequestLeave } from "./leave-requests";
import { ownContext } from "./own-requests";

/**
 * The worker's leave actions in the worker app (slice 4.4): ask for leave and cancel a request
 * before the final decision. Written with the worker's own session (channel worker_app); the
 * organisation and worker come from the session, and the database decides. The line manager is
 * emailed after the response. Logs carry error names only.
 */

const FAILED = "That was not sent. Try again in a minute.";

function refusal(error: unknown): WorkerActionState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
    if (error.code === "forbidden" || error.code === "invalid") {
      return { ok: false, message: error.message || FAILED };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error("people.own_leave_failed:", cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, message: FAILED };
}

/** "Send request" on /m/leave. */
export async function requestLeaveAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  let organisationId: string;
  let result;
  try {
    const ctx = await ownContext();
    organisationId = ctx.organisationId;
    result = await runRequestLeave(ctx, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  const id = result.id;
  after(() => notifyLeaveDeciders(organisationId, id, "line_manager"));
  revalidatePath("/m/leave");
  return {
    ok: true,
    message: `Sent · ${result.days} ${result.days === 1 ? "day" : "days"}. You will get a message when it is decided.`,
  };
}

/** "Cancel request" on a request still waiting for a decision. */
export async function cancelOwnLeaveAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  try {
    await runCancelOwnLeave(await ownContext(), formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  revalidatePath("/m/leave");
  return { ok: true, message: "Cancelled" };
}
