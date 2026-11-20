"use server";

import type { RecordPunchResult, UploadSelfieResult } from "@/lib/punches/codes";
import { MutationError } from "@/server/identity/mutate";
import { ownContext, type OwnContext } from "@/server/people/own-requests";

import { runRecordPunch, runUploadSelfie } from "./punches";
import { runPunchSelfieLink, type SelfieLinkResult } from "./punch-selfie-link";

/**
 * Server Actions behind clock-in and clock-out (slice 3.5). The worker app's offline queue calls
 * them from its sender (src/app/m/_components/clock/punch-sender.ts) for every punch, online or
 * not, with the queue's owner. Answers are fixed codes only.
 */

type OwnResult = { ok: true; ctx: OwnContext } | { ok: false; code: "signed_out" | "not_worker" };

async function own(): Promise<OwnResult> {
  try {
    return { ok: true, ctx: await ownContext() };
  } catch (error) {
    if (error instanceof MutationError && error.code === "unauthenticated") {
      return { ok: false, code: "signed_out" };
    }
    if (error instanceof MutationError) return { ok: false, code: "not_worker" };
    console.error("workforce.punch_session_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "signed_out" };
  }
}

/** Records one queued clock-in or clock-out. */
export async function recordPunchAction(input: unknown): Promise<RecordPunchResult> {
  const session = await own();
  if (!session.ok) return { ok: false, code: session.code };
  try {
    return await runRecordPunch(session.ctx, input);
  } catch (error) {
    console.error("workforce.punch_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "failed" };
  }
}

/** Takes the selfie of a clock-in just recorded (form fields: owner_org, owner_worker, punch_id, photo). */
export async function uploadPunchSelfieAction(formData: FormData): Promise<UploadSelfieResult> {
  const session = await own();
  if (!session.ok) return { ok: false, code: session.code };
  const photo = formData.get("photo");
  try {
    return await runUploadSelfie(
      session.ctx,
      {
        owner: {
          organisationId: formData.get("owner_org"),
          workerId: formData.get("owner_worker"),
        },
        punchId: formData.get("punch_id"),
      },
      photo instanceof Blob ? photo : null,
    );
  } catch (error) {
    console.error("workforce.selfie_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "photo_failed" };
  }
}

/** A 60-second link to a punch's selfie, for owner, admin, ops_manager or the line manager. */
export async function punchSelfieLinkAction(input: unknown): Promise<SelfieLinkResult> {
  return runPunchSelfieLink(input);
}
