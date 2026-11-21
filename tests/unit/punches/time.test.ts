import { describe, expect, it } from "vitest";

import { MAX_ELAPSED_MS, correctedTime } from "@/lib/punches/time";

const RECEIVED = Date.UTC(2026, 10, 20, 8, 0, 0);
const MIN = 60_000;

describe("server-corrected punch time", () => {
  it("uses the monotonic elapsed time when it has one, whatever the phone's clock says", () => {
    // The phone's clock is 10 minutes fast; the event was 30 minutes before the send.
    const t = correctedTime({
      deviceTime: RECEIVED - 30 * MIN + 10 * MIN,
      sentDeviceTime: RECEIVED + 10 * MIN,
      elapsedMs: 30 * MIN,
      receivedAt: RECEIVED,
    });
    expect(t.source).toBe("elapsed");
    expect(t.recordedAt).toBe(RECEIVED - 30 * MIN);
    expect(t.clockDriftSeconds).toBe(600);
  });

  it("corrects a constant clock offset after a reload (no elapsed time)", () => {
    const t = correctedTime({
      deviceTime: RECEIVED - 2 * MIN - 5 * MIN,
      sentDeviceTime: RECEIVED - 5 * MIN,
      elapsedMs: null,
      receivedAt: RECEIVED,
    });
    expect(t.source).toBe("offset");
    expect(t.recordedAt).toBe(RECEIVED - 2 * MIN);
    expect(t.clockDriftSeconds).toBe(-300);
  });

  it("falls back to the phone's clock for a negative or absurd elapsed time", () => {
    for (const elapsedMs of [-1, MAX_ELAPSED_MS + 1]) {
      const t = correctedTime({
        deviceTime: RECEIVED - 3 * MIN,
        sentDeviceTime: null,
        elapsedMs,
        receivedAt: RECEIVED,
      });
      expect(t.source).toBe("device");
      expect(t.recordedAt).toBe(RECEIVED - 3 * MIN);
    }
  });

  it("never records a time in the future", () => {
    const t = correctedTime({
      deviceTime: RECEIVED + 60 * MIN,
      sentDeviceTime: null,
      elapsedMs: null,
      receivedAt: RECEIVED,
    });
    expect(t.source).toBe("device");
    expect(t.recordedAt).toBe(RECEIVED);
    expect(t.clockDriftSeconds).toBe(3600);
  });

  it("never goes back more than 7 days", () => {
    const old = correctedTime({
      deviceTime: RECEIVED - 30 * 24 * 60 * MIN,
      sentDeviceTime: RECEIVED,
      elapsedMs: null,
      receivedAt: RECEIVED,
    });
    expect(old.source).toBe("device");
    expect(old.recordedAt).toBe(RECEIVED - MAX_ELAPSED_MS);
  });

  it("does not treat a send time before the event as an offset", () => {
    const t = correctedTime({
      deviceTime: RECEIVED,
      sentDeviceTime: RECEIVED - MIN,
      elapsedMs: null,
      receivedAt: RECEIVED,
    });
    expect(t.source).toBe("device");
  });
});
