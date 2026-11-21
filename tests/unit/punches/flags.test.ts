import { describe, expect, it } from "vitest";

import { punchFlags, type FlagInput } from "@/lib/punches/flags";

const NOW = Date.UTC(2026, 10, 20, 8, 0, 0);
const MIN = 60_000;

const base: FlagInput = {
  kind: "in",
  geofence: "inside",
  hasLocation: true,
  selfieExpected: true,
  shiftStartsAt: NOW - 5 * MIN,
  shiftEndsAt: NOW + 12 * 60 * MIN,
  graceMinutes: 10,
  recordedAt: NOW,
  receivedAt: NOW,
  clockDriftSeconds: 0,
  timeSource: "elapsed",
  previous: null,
};

describe("punch flags", () => {
  it("a clean clock-in carries none", () => {
    expect(punchFlags(base)).toEqual([]);
  });

  it("outside, near, no location and no shift", () => {
    expect(punchFlags({ ...base, geofence: "outside" })).toEqual(["outside"]);
    expect(punchFlags({ ...base, geofence: "near" })).toEqual(["near"]);
    expect(punchFlags({ ...base, hasLocation: false, geofence: "unknown" })).toEqual([
      "no_location",
    ]);
    expect(punchFlags({ ...base, shiftStartsAt: null, shiftEndsAt: null })).toEqual(["no_shift"]);
  });

  it("late only past the grace period", () => {
    expect(punchFlags({ ...base, shiftStartsAt: NOW - 10 * MIN })).toEqual([]);
    expect(punchFlags({ ...base, shiftStartsAt: NOW - 11 * MIN })).toEqual(["late"]);
    expect(punchFlags({ ...base, graceMinutes: 0, shiftStartsAt: NOW - MIN })).toEqual(["late"]);
  });

  it("early out before the end less the grace period", () => {
    const out: FlagInput = {
      ...base,
      kind: "out",
      selfieExpected: false,
      shiftStartsAt: NOW - 8 * 60 * MIN,
      shiftEndsAt: NOW + 30 * MIN,
      previous: { kind: "in", recordedAt: NOW - 8 * 60 * MIN },
    };
    expect(punchFlags(out)).toEqual(["early_out"]);
    expect(punchFlags({ ...out, shiftEndsAt: NOW + 5 * MIN })).toEqual([]);
  });

  it("no selfie on a clock-in only", () => {
    expect(punchFlags({ ...base, selfieExpected: false })).toEqual(["no_selfie"]);
    expect(
      punchFlags({
        ...base,
        kind: "out",
        selfieExpected: false,
        previous: { kind: "in", recordedAt: NOW - 60 * MIN },
        shiftEndsAt: NOW,
      }),
    ).toEqual([]);
  });

  it("clock drift over 5 minutes, late sync over 2 hours, unverified time", () => {
    expect(punchFlags({ ...base, clockDriftSeconds: 300 })).toEqual([]);
    expect(punchFlags({ ...base, clockDriftSeconds: -301 })).toEqual(["clock_drift"]);
    // A later shift start keeps "late" out of the way.
    const later = { ...base, shiftStartsAt: NOW + 3 * 60 * MIN };
    expect(punchFlags({ ...later, receivedAt: NOW + 2 * 60 * MIN })).toEqual(["delayed"]);
    expect(punchFlags({ ...later, receivedAt: NOW + 2 * 60 * MIN + 1 })).toEqual([
      "delayed",
      "late_sync",
    ]);
    expect(punchFlags({ ...base, timeSource: "device" })).toEqual(["time_unverified"]);
  });

  it("delayed over 5 minutes, and a delayed clock-in that arrived after the grace is late", () => {
    const later = { ...base, shiftStartsAt: NOW + 60 * MIN };
    expect(punchFlags({ ...later, receivedAt: NOW + 5 * MIN })).toEqual([]);
    expect(punchFlags({ ...later, receivedAt: NOW + 5 * MIN + 1 })).toEqual(["delayed"]);
    // Claims 5 minutes after the start (on time) but arrived 30 minutes after it: late.
    expect(punchFlags({ ...base, receivedAt: NOW + 25 * MIN })).toEqual(["late", "delayed"]);
    // Arrived 3 minutes late of the claim: not delayed, so the claim decides.
    expect(
      punchFlags({ ...base, shiftStartsAt: NOW - 9 * MIN, receivedAt: NOW + 3 * MIN }),
    ).toEqual([]);
  });

  it("sequencing: a double clock-in and a clock-out without one", () => {
    expect(punchFlags({ ...base, previous: { kind: "in", recordedAt: NOW - 60 * MIN } })).toEqual([
      "double_in",
    ]);
    expect(
      punchFlags({ ...base, previous: { kind: "in", recordedAt: NOW - 21 * 60 * MIN } }),
    ).toEqual([]);
    const out: FlagInput = { ...base, kind: "out", shiftEndsAt: NOW };
    expect(punchFlags(out)).toEqual(["out_without_in"]);
    expect(punchFlags({ ...out, previous: { kind: "out", recordedAt: NOW - MIN } })).toEqual([
      "out_without_in",
    ]);
  });

  it("keeps the declared order", () => {
    expect(
      punchFlags({
        ...base,
        geofence: "outside",
        selfieExpected: false,
        shiftStartsAt: null,
        shiftEndsAt: null,
        clockDriftSeconds: 900,
      }),
    ).toEqual(["outside", "no_shift", "no_selfie", "clock_drift"]);
  });
});
