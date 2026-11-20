"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { ownContext } from "@/server/people/own-requests";

import type { WorkerActionState } from "./action-state";
import { runMarkRead } from "./inbox";

const copy = workerMessages.inbox;

/** "Mark as read" on one item, or "Mark all as read" (id "all"), in the worker's inbox. */
export async function markInboxReadAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  try {
    await runMarkRead(await ownContext(), formFields(formData));
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
      return { ok: false, message: copy.failed };
    }
    console.error(
      "workforce.inbox_read_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return { ok: false, message: copy.failed };
  }
  revalidatePath("/m", "layout");
  return { ok: true, message: copy.marked };
}
