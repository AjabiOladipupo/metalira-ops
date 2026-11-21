import { describe, expect, it, vi } from "vitest";

import { WORKER_CHECKPOINT_PATH, proxyDecision } from "@/lib/auth/routes";
import type { AnyQueueItem } from "@/lib/offline/types";
import {
  CHECKPOINT_SCAN_PATH,
  checkpointScanPayloadSchema,
  isCheckpointQueueKind,
  locationConsentKey,
  parseCheckpointFragment,
  rememberScanOutcome,
  scanOutcome,
  subscribeScanOutcomes,
} from "@/lib/punches/checkpoint";
import { codeFromSqlState, queueResultFor } from "@/lib/punches/codes";
import { isPunchQueueKind } from "@/lib/punches/clock";
import { createPunchSender } from "@/lib/punches/sender";

const TOKEN = "0123456789abcdef".repeat(4);
const ORG = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const owner = { organisationId: ORG, workerId: WORKER };
const timing = { sent_device_time: 1_800_000_000_000, elapsed_since_event_ms: 4000 };

describe("parseCheckpointFragment", () => {
  it("reads the token from the fragment as the printed codes write it", () => {
    expect(parseCheckpointFragment(`#${TOKEN}`)).toBe(TOKEN);
    expect(parseCheckpointFragment(TOKEN)).toBe(TOKEN);
  });

  it("forgives what scanner apps add: upper case, spaces and a trailing slash", () => {
    expect(parseCheckpointFragment(`#${TOKEN.toUpperCase()}`)).toBe(TOKEN);
    expect(parseCheckpointFragment(`  #${TOKEN}  `)).toBe(TOKEN);
    expect(parseCheckpointFragment(`#${TOKEN}/`)).toBe(TOKEN);
  });

  it("refuses anything that isn't exactly one token", () => {
    for (const value of [
      null,
      undefined,
      "",
      "#",
      `#${TOKEN.slice(1)}`,
      `#${TOKEN}0`,
      `#${TOKEN}${TOKEN}`,
      `#${TOKEN.slice(0, 63)}g`,
      `#token=${TOKEN}`,
      `#${TOKEN}?x=1`,
      `#${TOKEN}&x`,
      `##${TOKEN}`,
      `#${TOKEN.slice(0, 32)} ${TOKEN.slice(32)}`,
      `#/${TOKEN}`,
      `#%30${TOKEN.slice(1)}`,
    ]) {
      expect(parseCheckpointFragment(value), String(value)).toBeNull();
    }
  });

  it("never takes the token from the query string or the path", () => {
    // Only location.hash is passed in; a URL whose token is in the query or path has no hash.
    const inQuery = new URL(`https://ops.example/m/checkpoint?token=${TOKEN}`);
    const inPath = new URL(`https://ops.example/m/checkpoint/${TOKEN}`);
    expect(parseCheckpointFragment(inQuery.hash)).toBeNull();
    expect(parseCheckpointFragment(inPath.hash)).toBeNull();
    const printed = new URL(`https://ops.example${CHECKPOINT_SCAN_PATH}#${TOKEN}`);
    expect(parseCheckpointFragment(printed.hash)).toBe(TOKEN);
    // What the browser sends to the server: the fragment is not part of it.
    expect(`${printed.pathname}${printed.search}`).toBe("/m/checkpoint");
  });
});

describe("the scan page route", () => {
  it("is the path the printed codes use, open without a session", () => {
    expect(CHECKPOINT_SCAN_PATH).toBe(WORKER_CHECKPOINT_PATH);
    expect(CHECKPOINT_SCAN_PATH).toBe("/m/checkpoint");
    expect(proxyDecision("/m/checkpoint", "", false)).toEqual({ type: "next" });
  });
});

describe("the queued scan", () => {
  it("holds the token and the location, nothing else", () => {
    const ok = checkpointScanPayloadSchema.safeParse({
      token: TOKEN,
      latitude: 6.45,
      longitude: 3.36,
      accuracy_m: 12,
    });
    expect(ok.success).toBe(true);
    expect(
      checkpointScanPayloadSchema.safeParse({
        token: TOKEN.toUpperCase(),
        latitude: null,
        longitude: null,
        accuracy_m: null,
      }).success,
    ).toBe(false);
    expect(
      checkpointScanPayloadSchema.safeParse({
        token: TOKEN,
        latitude: 91,
        longitude: 3,
        accuracy_m: 5,
      }).success,
    ).toBe(false);
  });

  it("is its own queue kind, never a clock punch", () => {
    expect(isCheckpointQueueKind("checkpoint_scan")).toBe(true);
    expect(isPunchQueueKind("checkpoint_scan")).toBe(false);
    expect(isCheckpointQueueKind("clock_in")).toBe(false);
  });

  it("keeps a per-worker consent key, never a token", () => {
    expect(locationConsentKey(WORKER.toUpperCase())).toBe(`metalira.locationConsent.${WORKER}`);
  });
});

describe("scan codes", () => {
  it("maps the scan refusals to fixed codes refused for good", () => {
    expect(codeFromSqlState("MLCK1")).toBe("unknown_checkpoint");
    expect(codeFromSqlState("MLCK2")).toBe("not_on_shift");
    expect(queueResultFor("unknown_checkpoint")).toEqual({
      ok: false,
      retryable: false,
      error: "rejected",
    });
    expect(queueResultFor("not_on_shift")).toEqual({
      ok: false,
      retryable: false,
      error: "rejected",
    });
  });
});

function scanItem(): AnyQueueItem {
  return {
    client_event_id: EVENT,
    organisation_id: ORG,
    worker_id: WORKER,
    kind: "checkpoint_scan",
    payload: { token: TOKEN, latitude: 6.45, longitude: 3.36, accuracy_m: 12 },
    device_time: 1_800_000_000_000 - 4000,
    device_elapsed: { monotonic_ms: 1, time_origin_ms: 1, wall_ms: 1 },
    attempts: 0,
    last_error: null,
    status: "queued",
    created_at: 1,
    next_attempt_at: 1,
    failed_at: null,
  } as AnyQueueItem;
}

describe("the sender for scans", () => {
  it("sends the scan with the queue's owner and remembers the receipt in memory", async () => {
    const recordCheckpointScan = vi.fn().mockResolvedValue({
      ok: true,
      punchId: "44444444-4444-4444-8444-444444444444",
      duplicate: false,
      recordedAt: "2027-01-15T08:00:00Z",
      geofence: "inside",
      flags: [],
      checkpointName: "Gate B",
      siteName: "Apapa Warehouse 3",
    });
    const recordPunch = vi.fn();
    const sender = createPunchSender({ recordPunch, uploadSelfie: vi.fn(), recordCheckpointScan });
    const heard = vi.fn();
    const stop = subscribeScanOutcomes(heard);
    await expect(sender.send(scanItem(), timing, owner)).resolves.toEqual({ ok: true });
    stop();
    expect(recordPunch).not.toHaveBeenCalled();
    expect(recordCheckpointScan).toHaveBeenCalledWith({
      owner,
      client_event_id: EVENT,
      payload: { token: TOKEN, latitude: 6.45, longitude: 3.36, accuracy_m: 12 },
      device_time: 1_800_000_000_000 - 4000,
      timing,
    });
    expect(heard).toHaveBeenCalled();
    expect(scanOutcome(EVENT)).toMatchObject({
      ok: true,
      receipt: { checkpointName: "Gate B", geofence: "inside" },
    });
  });

  it("passes refusals on as the queue's fixed codes, wrong_session included", async () => {
    const refused = createPunchSender({
      recordPunch: vi.fn(),
      uploadSelfie: vi.fn(),
      recordCheckpointScan: vi.fn().mockResolvedValue({ ok: false, code: "not_on_shift" }),
    });
    await expect(refused.send(scanItem(), timing, owner)).resolves.toEqual({
      ok: false,
      retryable: false,
      error: "rejected",
    });
    expect(scanOutcome(EVENT)).toEqual({ ok: false, code: "not_on_shift" });
    const stranger = createPunchSender({
      recordPunch: vi.fn(),
      uploadSelfie: vi.fn(),
      recordCheckpointScan: vi.fn().mockResolvedValue({ ok: false, code: "wrong_session" }),
    });
    await expect(stranger.send(scanItem(), timing, owner)).resolves.toEqual({
      ok: false,
      wrongSession: true,
    });
  });

  it("throws network failures for the engine to retry", async () => {
    const offline = createPunchSender({
      recordPunch: vi.fn(),
      uploadSelfie: vi.fn(),
      recordCheckpointScan: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    });
    await expect(offline.send(scanItem(), timing, owner)).rejects.toThrow(TypeError);
  });

  it("keeps at most 50 outcomes in memory", () => {
    for (let i = 0; i < 60; i += 1) rememberScanOutcome(`id-${i}`, { ok: false, code: "failed" });
    expect(scanOutcome("id-0")).toBeNull();
    expect(scanOutcome("id-59")).not.toBeNull();
  });
});
