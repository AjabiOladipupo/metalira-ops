import { describe, expect, it, vi } from "vitest";

import type { AnyQueueItem } from "@/lib/offline/types";
import {
  PUNCH_ERROR_CODES,
  codeFromSqlState,
  isRetryableCode,
  queueResultFor,
  sendOutcome,
  type RecordPunchResult,
} from "@/lib/punches/codes";
import { createPunchSender } from "@/lib/punches/sender";

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const owner = { organisationId: ORG, workerId: WORKER };
const timing = { sent_device_time: 1_800_000_000_000, elapsed_since_event_ms: 5000 };

function item(kind: "clock_in" | "clock_out" | "test_ping", photo?: Blob): AnyQueueItem {
  return {
    client_event_id: "33333333-3333-4333-8333-333333333333",
    organisation_id: ORG,
    worker_id: WORKER,
    kind,
    payload:
      kind === "test_ping"
        ? { note: "x" }
        : {
            site_id: null,
            latitude: 6.45,
            longitude: 3.39,
            accuracy_m: 12,
            outside_reason: null,
            outside_note: null,
            has_selfie: Boolean(photo),
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

const recorded: RecordPunchResult = {
  ok: true,
  punchId: "44444444-4444-4444-8444-444444444444",
  duplicate: false,
  selfieWanted: true,
  geofence: "inside",
  flags: [],
};

describe("punch codes", () => {
  it("maps every database refusal to a fixed code", () => {
    expect(codeFromSqlState("MLPU1")).toBe("not_worker");
    expect(codeFromSqlState("MLPU2")).toBe("conflict");
    expect(codeFromSqlState("MLPU3")).toBe("left");
    expect(codeFromSqlState("MLPU4")).toBe("shifts_off");
    expect(codeFromSqlState("MLPU5")).toBe("invalid");
    expect(codeFromSqlState("MLPU6")).toBe("no_consent");
    expect(codeFromSqlState("MLPU7")).toBe("bad_site");
    expect(codeFromSqlState("MLPU8")).toBe("rate_limited");
    expect(codeFromSqlState("MLPU9")).toBe("wrong_session");
    for (const state of ["22003", "22008", "23514"])
      expect(codeFromSqlState(state)).toBe("invalid");
    expect(codeFromSqlState("08006")).toBe("failed");
    expect(codeFromSqlState(undefined)).toBe("failed");
  });

  it("retries what may pass later and refuses for good what never will", () => {
    expect(PUNCH_ERROR_CODES.filter(isRetryableCode)).toEqual([
      "wrong_session",
      "signed_out",
      "rate_limited",
      "photo_failed",
      "failed",
    ]);
    expect(queueResultFor("wrong_session")).toEqual({ ok: false, wrongSession: true });
    expect(queueResultFor("signed_out")).toEqual({ ok: false, wrongSession: true });
    expect(queueResultFor("rate_limited")).toEqual({
      ok: false,
      retryable: true,
      error: "rate_limited",
    });
    expect(queueResultFor("failed")).toEqual({ ok: false, retryable: true, error: "server_error" });
    expect(queueResultFor("invalid")).toEqual({ ok: false, retryable: false, error: "invalid" });
    for (const code of [
      "not_worker",
      "left",
      "shifts_off",
      "no_consent",
      "conflict",
      "bad_site",
    ] as const) {
      expect(queueResultFor(code)).toEqual({ ok: false, retryable: false, error: "rejected" });
    }
  });

  it("a recorded punch whose photo the server will never take is done", () => {
    expect(sendOutcome(recorded, { ok: false, code: "photo_invalid" })).toEqual({ ok: true });
    expect(sendOutcome(recorded, { ok: false, code: "photo_refused" })).toEqual({ ok: true });
    expect(sendOutcome(recorded, { ok: false, code: "photo_failed" })).toEqual({
      ok: false,
      retryable: true,
      error: "server_error",
    });
    expect(sendOutcome(recorded, { ok: false, code: "wrong_session" })).toEqual({
      ok: false,
      wrongSession: true,
    });
  });
});

describe("punch sender", () => {
  it("records the punch with the queue's owner, then uploads the selfie", async () => {
    const recordPunch = vi.fn().mockResolvedValue(recorded);
    const uploadSelfie = vi.fn().mockResolvedValue({ ok: true });
    const sender = createPunchSender({ recordPunch, uploadSelfie });
    const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
    await expect(sender.send(item("clock_in", photo), timing, owner)).resolves.toEqual({
      ok: true,
    });
    expect(recordPunch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        kind: "clock_in",
        client_event_id: "33333333-3333-4333-8333-333333333333",
        timing,
      }),
    );
    const form = uploadSelfie.mock.calls[0]![0] as FormData;
    expect(form.get("punch_id")).toBe(recorded.punchId);
    expect(form.get("owner_worker")).toBe(WORKER);
  });

  it("skips the upload when the server doesn't want a selfie (a duplicate already has one)", async () => {
    const recordPunch = vi
      .fn()
      .mockResolvedValue({ ...recorded, duplicate: true, selfieWanted: false });
    const uploadSelfie = vi.fn();
    const sender = createPunchSender({ recordPunch, uploadSelfie });
    const photo = new Blob([new Uint8Array([1])]);
    await expect(sender.send(item("clock_in", photo), timing, owner)).resolves.toEqual({
      ok: true,
    });
    expect(uploadSelfie).not.toHaveBeenCalled();
  });

  it("passes on refusals as fixed codes and throws network failures", async () => {
    const sender = createPunchSender({
      recordPunch: vi.fn().mockResolvedValue({ ok: false, code: "no_consent" }),
      uploadSelfie: vi.fn(),
    });
    await expect(sender.send(item("clock_out"), timing, owner)).resolves.toEqual({
      ok: false,
      retryable: false,
      error: "rejected",
    });
    const offline = createPunchSender({
      recordPunch: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      uploadSelfie: vi.fn(),
    });
    await expect(offline.send(item("clock_out"), timing, owner)).rejects.toThrow(TypeError);
  });

  it("hands other kinds to the other sender, or refuses them", async () => {
    const other = { send: vi.fn().mockResolvedValue({ ok: true }) };
    const actions = { recordPunch: vi.fn(), uploadSelfie: vi.fn() };
    await createPunchSender(actions, other).send(item("test_ping"), timing, owner);
    expect(other.send).toHaveBeenCalled();
    expect(actions.recordPunch).not.toHaveBeenCalled();
    await expect(
      createPunchSender(actions).send(item("test_ping"), timing, owner),
    ).resolves.toEqual({ ok: false, retryable: false, error: "invalid" });
  });
});
