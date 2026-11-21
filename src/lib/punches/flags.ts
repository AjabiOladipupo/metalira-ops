import { CLOCK_DRIFT_FLAG_SECONDS, DELAYED_MS, LATE_SYNC_MS, type TimeSource } from "./time";

/**
 * The flags a punch carries (slice 3.5), fixed when it is recorded. The database computes them
 * (private.punch_flags in migration 20261120190000); this mirror keeps the order and the rules
 * for the unit tests and the screens. tests/rls/punches.test.ts checks the two agree.
 */
export const PUNCH_FLAGS = [
  "outside",
  "near",
  "no_location",
  "no_shift",
  "late",
  "early_out",
  "no_selfie",
  "clock_drift",
  "delayed",
  "late_sync",
  "time_unverified",
  "double_in",
  "out_without_in",
] as const;

export type PunchFlag = (typeof PUNCH_FLAGS)[number];
export type PunchKind = "in" | "out";
export type GeofenceResult = "inside" | "near" | "outside" | "unknown";

/** A clock-in after a clock-in, or a clock-out with no clock-in, within this many hours. */
export const OPEN_PUNCH_HOURS = 20;

export interface FlagInput {
  kind: PunchKind;
  geofence: GeofenceResult;
  hasLocation: boolean;
  selfieExpected: boolean;
  /** The matched shift (ms epoch), or null with no shift. */
  shiftStartsAt: number | null;
  shiftEndsAt: number | null;
  graceMinutes: number;
  recordedAt: number;
  receivedAt: number;
  clockDriftSeconds: number;
  timeSource: TimeSource;
  previous: { kind: PunchKind; recordedAt: number } | null;
}

/** Plain-English label for each flag, for managers' screens and Lira. */
export const PUNCH_FLAG_LABELS: Record<PunchFlag, string> = {
  outside: "Outside the site",
  near: "Near the site",
  no_location: "No location",
  no_shift: "No shift",
  late: "Late",
  early_out: "Left early",
  no_selfie: "No selfie",
  clock_drift: "Phone clock wrong",
  delayed: "Time not checked live",
  late_sync: "Sent late",
  time_unverified: "Time not checked",
  double_in: "Clocked in twice",
  out_without_in: "Clock-out without clock-in",
};

export function punchFlags(input: FlagInput): PunchFlag[] {
  const graceMs = input.graceMinutes * 60_000;
  const openWindow = input.recordedAt - OPEN_PUNCH_HOURS * 60 * 60_000;
  const previousIn =
    input.previous !== null &&
    input.previous.kind === "in" &&
    input.previous.recordedAt > openWindow;
  // The time rests on the phone's word when it arrived more than 5 minutes after it says it
  // happened (security review M1): a delayed clock-in is also late when it arrived after the
  // grace period, whatever time it claims.
  const delayed = input.receivedAt - input.recordedAt > DELAYED_MS;
  const hits: Record<PunchFlag, boolean> = {
    outside: input.geofence === "outside",
    near: input.geofence === "near",
    no_location: !input.hasLocation,
    no_shift: input.shiftStartsAt === null,
    late:
      input.kind === "in" &&
      input.shiftStartsAt !== null &&
      (input.recordedAt > input.shiftStartsAt + graceMs ||
        (delayed && input.receivedAt > input.shiftStartsAt + graceMs)),
    early_out:
      input.kind === "out" &&
      input.shiftEndsAt !== null &&
      input.recordedAt < input.shiftEndsAt - graceMs,
    no_selfie: input.kind === "in" && !input.selfieExpected,
    clock_drift: Math.abs(input.clockDriftSeconds) > CLOCK_DRIFT_FLAG_SECONDS,
    delayed,
    late_sync: input.receivedAt - input.recordedAt > LATE_SYNC_MS,
    time_unverified: input.timeSource === "device",
    double_in: input.kind === "in" && previousIn,
    out_without_in: input.kind === "out" && !previousIn,
  };
  return PUNCH_FLAGS.filter((flag) => hits[flag]);
}
