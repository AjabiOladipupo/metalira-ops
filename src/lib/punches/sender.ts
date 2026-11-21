import type {
  AnyQueueItem,
  QueueOwner,
  QueueSender,
  SendResult,
  SendTiming,
} from "@/lib/offline/types";

import { isPunchQueueKind } from "./clock";
import { sendOutcome, type RecordPunchResult, type UploadSelfieResult } from "./codes";

/**
 * The offline queue's sender for punches (slice 3.5). Every clock-in and clock-out goes through
 * the queue, online or not; this sends one item: record the punch first, then, if the server
 * wants it, the selfie. The queue's owner goes with every call, so the server records it only
 * for that worker; anything else comes back `wrongSession` and stays queued for its owner.
 *
 * Only the queue's fixed codes come back (src/lib/punches/codes.ts `queueResultFor`), never what
 * a server said. Network failures throw, which the sync engine treats as transient.
 *
 * The actions are injected so the mapping is tested without a server.
 */
export interface PunchActions {
  recordPunch(input: unknown): Promise<RecordPunchResult>;
  uploadSelfie(form: FormData): Promise<UploadSelfieResult>;
}

export function createPunchSender(
  actions: PunchActions,
  /** Sends kinds that aren't punches (the end-to-end test ping), or null. */
  other: QueueSender | null = null,
): QueueSender {
  return {
    async send(item: AnyQueueItem, timing: SendTiming, owner: QueueOwner): Promise<SendResult> {
      if (!isPunchQueueKind(item.kind)) {
        if (other) return other.send(item, timing, owner);
        return { ok: false, retryable: false, error: "invalid" };
      }
      const punch = item as Extract<AnyQueueItem, { kind: "clock_in" | "clock_out" }>;
      const record = await actions.recordPunch({
        owner: { organisationId: punch.organisation_id, workerId: punch.worker_id },
        client_event_id: punch.client_event_id,
        kind: punch.kind,
        payload: punch.payload,
        device_time: Math.round(punch.device_time),
        timing: {
          sent_device_time: Math.round(timing.sent_device_time),
          elapsed_since_event_ms: timing.elapsed_since_event_ms,
        },
      });
      let upload: UploadSelfieResult | null = null;
      if (record.ok && record.selfieWanted && punch.photo) {
        const form = new FormData();
        form.set("owner_org", punch.organisation_id);
        form.set("owner_worker", punch.worker_id);
        form.set("punch_id", record.punchId);
        form.set("photo", punch.photo, "selfie");
        upload = await actions.uploadSelfie(form);
      }
      return sendOutcome(record, upload);
    },
  };
}
