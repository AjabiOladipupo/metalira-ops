import type { AnyQueueItem, QueueOwner, QueueSender, SendResult, SendTiming } from "@/lib/offline/types";

import { isRetryableCode, queueResultFor, type RecordCrewPunchResult, type UploadSelfieResult } from "./codes";
import { isCrewQueueKind } from "./crew";

/**
 * The offline queue's sender for crew punches (slice 3.6), the same contract as the punch sender
 * (sender.ts): record the batch first, then, if the server wants it, the group photo. The queue's
 * owner (the supervisor's company and actor id) goes with every call; the server records it only
 * for that login and answers `wrong_session` otherwise, so the item stays queued for its owner.
 * Only fixed codes come back. The actions are injected so the mapping is tested without a server.
 */
export interface CrewActions {
  recordCrewPunch(input: unknown): Promise<RecordCrewPunchResult>;
  uploadCrewPhoto(form: FormData): Promise<UploadSelfieResult>;
}

/** The queue's verdict for one crew send, from the two answers. */
export function crewSendOutcome(
  record: RecordCrewPunchResult,
  upload: UploadSelfieResult | null,
): SendResult {
  if (!record.ok) return queueResultFor(record.code);
  if (upload === null || upload.ok) return { ok: true };
  // The punches are recorded. A photo the server will never take is dropped rather than
  // blocking the queue; a transient failure is retried and the resend finds the batch recorded.
  if (upload.code === "photo_invalid" || upload.code === "photo_refused") return { ok: true };
  if (!isRetryableCode(upload.code)) return { ok: true };
  return queueResultFor(upload.code);
}

export function createCrewSender(
  actions: CrewActions,
  /** Sends every other kind (punches, the test ping), or null. */
  other: QueueSender | null = null,
): QueueSender {
  return {
    async send(item: AnyQueueItem, timing: SendTiming, owner: QueueOwner): Promise<SendResult> {
      if (!isCrewQueueKind(item.kind)) {
        if (other) return other.send(item, timing, owner);
        return { ok: false, retryable: false, error: "invalid" };
      }
      const crew = item as Extract<AnyQueueItem, { kind: "crew_in" | "crew_out" }>;
      const record = await actions.recordCrewPunch({
        owner: { organisationId: crew.organisation_id, workerId: crew.worker_id },
        client_batch_id: crew.client_event_id,
        kind: crew.kind,
        payload: crew.payload,
        device_time: Math.round(crew.device_time),
        timing: {
          sent_device_time: Math.round(timing.sent_device_time),
          elapsed_since_event_ms: timing.elapsed_since_event_ms,
        },
      });
      let upload: UploadSelfieResult | null = null;
      if (record.ok && record.photoWanted && crew.photo) {
        const form = new FormData();
        form.set("owner_org", crew.organisation_id);
        form.set("owner_actor", crew.worker_id);
        form.set("batch_id", record.batchId);
        form.set("photo", crew.photo, "crew");
        upload = await actions.uploadCrewPhoto(form);
      }
      return crewSendOutcome(record, upload);
    },
  };
}
