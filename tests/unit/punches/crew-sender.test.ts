import { describe, expect, it, vi } from "vitest";

import type { AnyQueueItem } from "@/lib/offline/types";
import { codeFromSqlState, type RecordCrewPunchResult } from "@/lib/punches/codes";
import { createCrewSender, crewSendOutcome } from "@/lib/punches/crew-sender";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const owner = { organisationId: ORG, workerId: ACTOR };
const timing = { sent_device_time: 1_800_000_000_000, elapsed_since_event_ms: 5000 };

function item(kind: "crew_in" | "crew_out" | "clock_in", photo?: Blob): AnyQueueItem {
  return {
    client_event_id: "33333333-3333-4333-8333-333333333333",
    organisation_id: ORG,
    worker_id: ACTOR,
    kind,
    payload: {
      site_id: "55555555-5555-4555-8555-555555555555",
      entries: [
        {
          worker_id: "66666666-6666-4666-8666-666666666666",
          client_event_id: "77777777-7777-4777-8777-777777777777",
        },
      ],
      latitude: null,
      longitude: null,
      accuracy_m: null,
      has_photo: Boolean(photo),
    },
    device_time: 1_800_000_000_000 - 5000,
    device_elapsed: { monotonic_ms: 1, time_origin_ms: 1, wall_ms: 1 },
    ...(photo ? { photo } : {}),
    attempts: 0,
    last_error: null,
    status: "queued",
    created_at: 1,
    next_attempt_at: 1,
    failed_at: null,
  } as AnyQueueItem;
}

const recorded: RecordCrewPunchResult = {
  ok: true,
  batchId: "44444444-4444-4444-8444-444444444444",
  duplicate: false,
  count: 1,
  photoWanted: true,
  geofence: "unknown",
};

describe("crew codes", () => {
  it("maps the crew refusals to fixed codes", () => {
    expect(codeFromSqlState("MLCR1")).toBe("not_your_crew");
    expect(codeFromSqlState("MLCR2")).toBe("not_on_shift");
    expect(codeFromSqlState("MLCR3")).toBe("not_rostered");
  });
});

describe("crew sender", () => {
  it("sends the batch with the queue's owner, then the photo when wanted", async () => {
    const recordCrewPunch = vi.fn().mockResolvedValue(recorded);
    const uploadCrewPhoto = vi.fn().mockResolvedValue({ ok: true });
    const sender = createCrewSender({ recordCrewPunch, uploadCrewPhoto });
    const photo = new Blob(["x"], { type: "image/webp" });
    expect(await sender.send(item("crew_in", photo), timing, owner)).toEqual({ ok: true });
    expect(recordCrewPunch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        client_batch_id: "33333333-3333-4333-8333-333333333333",
        kind: "crew_in",
        timing,
      }),
    );
    const form = uploadCrewPhoto.mock.calls[0]![0] as FormData;
    expect(form.get("owner_org")).toBe(ORG);
    expect(form.get("owner_actor")).toBe(ACTOR);
    expect(form.get("batch_id")).toBe(recorded.batchId);
  });

  it("sends no photo when the server does not want one", async () => {
    const uploadCrewPhoto = vi.fn();
    const sender = createCrewSender({
      recordCrewPunch: vi.fn().mockResolvedValue({ ...recorded, photoWanted: false }),
      uploadCrewPhoto,
    });
    await sender.send(item("crew_in", new Blob(["x"])), timing, owner);
    expect(uploadCrewPhoto).not.toHaveBeenCalled();
  });

  it("keeps another login's item queued and refuses a crew refusal for good", async () => {
    const wrong = createCrewSender({
      recordCrewPunch: vi.fn().mockResolvedValue({ ok: false, code: "wrong_session" }),
      uploadCrewPhoto: vi.fn(),
    });
    expect(await wrong.send(item("crew_out"), timing, owner)).toEqual({
      ok: false,
      wrongSession: true,
    });
    for (const code of ["not_your_crew", "not_on_shift", "not_rostered"] as const) {
      expect(crewSendOutcome({ ok: false, code }, null)).toEqual({
        ok: false,
        retryable: false,
        error: "rejected",
      });
    }
  });

  it("drops a photo the server will never take, retries a transient failure", () => {
    expect(crewSendOutcome(recorded, { ok: false, code: "photo_refused" })).toEqual({ ok: true });
    expect(crewSendOutcome(recorded, { ok: false, code: "photo_failed" })).toEqual({
      ok: false,
      retryable: true,
      error: "server_error",
    });
  });

  it("hands other kinds on", async () => {
    const other = { send: vi.fn().mockResolvedValue({ ok: true }) };
    const sender = createCrewSender({ recordCrewPunch: vi.fn(), uploadCrewPhoto: vi.fn() }, other);
    await sender.send(item("clock_in"), timing, owner);
    expect(other.send).toHaveBeenCalled();
  });
});
