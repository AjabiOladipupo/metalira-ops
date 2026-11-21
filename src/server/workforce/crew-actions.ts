"use server";

import type { RecordCrewPunchResult, UploadSelfieResult } from "@/lib/punches/codes";

import { runRecordCrewPunch, runUploadCrewPhoto } from "./crew";
import { lookupCrewSession, type CrewSession } from "./crew-session";

/**
 * Server Actions behind crew clock-in (slice 3.6). The worker app's offline queue calls them from
 * the crew sender (src/lib/punches/crew-sender.ts) for every crew punch, online or not, with the
 * queue's owner. Answers are fixed codes only.
 */

type Session =
  { ok: true; session: CrewSession } | { ok: false; code: "signed_out" | "not_your_crew" };

async function crew(): Promise<Session> {
  try {
    const lookup = await lookupCrewSession();
    if (lookup.type === "crew") return { ok: true, session: lookup.session };
    if (lookup.type === "signed_out") return { ok: false, code: "signed_out" };
    return { ok: false, code: "not_your_crew" };
  } catch (error) {
    console.error(
      "workforce.crew_session_failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return { ok: false, code: "signed_out" };
  }
}

/** Records one queued crew clock-in or clock-out. */
export async function recordCrewPunchAction(input: unknown): Promise<RecordCrewPunchResult> {
  const found = await crew();
  if (!found.ok) return { ok: false, code: found.code };
  try {
    return await runRecordCrewPunch(found.session, input);
  } catch (error) {
    console.error("workforce.crew_punch_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "failed" };
  }
}

/** Takes the group photo of a crew clock-in just recorded (owner_org, owner_actor, batch_id, photo). */
export async function uploadCrewPhotoAction(formData: FormData): Promise<UploadSelfieResult> {
  const found = await crew();
  if (!found.ok) return { ok: false, code: found.code };
  const photo = formData.get("photo");
  try {
    return await runUploadCrewPhoto(
      found.session,
      {
        owner: {
          organisationId: formData.get("owner_org"),
          workerId: formData.get("owner_actor"),
        },
        batchId: formData.get("batch_id"),
      },
      photo instanceof Blob ? photo : null,
    );
  } catch (error) {
    console.error("workforce.crew_photo_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "photo_failed" };
  }
}
