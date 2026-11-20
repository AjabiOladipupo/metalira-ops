/**
 * The server-corrected time of a punch (slice 3.5). The database is the authority
 * (private.punch_corrected_time in migration 20261120190000); this mirror is what the unit tests
 * pin down and what the worker app uses to preview. tests/rls/punches.test.ts checks the two
 * agree on the same cases.
 *
 * - `elapsed`: the phone measured how long ago the event was with its monotonic clock (same page
 *   session), so event time = received - elapsed. A wrong phone clock doesn't matter.
 * - `offset`: after a reload the monotonic clock restarts; the phone's wall clock at the event
 *   and at the send still give the gap, so event time = received - (sent - device). Corrects a
 *   phone clock that is off by a constant amount.
 * - `device`: nothing to correct with (no send time, a negative or absurd gap): the phone's own
 *   clock, clamped to [received - 7 days, received], flagged `time_unverified`.
 */

/** The longest gap between the event and its send that the server believes. */
export const MAX_ELAPSED_MS = 7 * 24 * 60 * 60_000;
/** More than this between the phone's clock and the corrected time is `clock_drift`. */
export const CLOCK_DRIFT_FLAG_SECONDS = 5 * 60;
/** Received more than this after it happened is `late_sync`. */
export const LATE_SYNC_MS = 2 * 60 * 60_000;

export type TimeSource = "elapsed" | "offset" | "device";

export interface TimeInput {
  /** The phone's clock at the event (ms epoch). */
  deviceTime: number;
  /** The phone's clock just before the send (ms epoch), or null. */
  sentDeviceTime: number | null;
  /** Monotonic ms between the event and the send, or null after a reload. */
  elapsedMs: number | null;
  /** The server's clock when it received the punch (ms epoch). */
  receivedAt: number;
}

export interface CorrectedTime {
  recordedAt: number;
  source: TimeSource;
  /** device_time - recorded_at, whole seconds (positive: the phone's clock is ahead). */
  clockDriftSeconds: number;
}

export function correctedTime(input: TimeInput): CorrectedTime {
  const { deviceTime, sentDeviceTime, elapsedMs, receivedAt } = input;
  let recordedAt: number;
  let source: TimeSource;
  if (elapsedMs !== null && elapsedMs >= 0 && elapsedMs <= MAX_ELAPSED_MS) {
    recordedAt = receivedAt - elapsedMs;
    source = "elapsed";
  } else if (
    sentDeviceTime !== null &&
    sentDeviceTime >= deviceTime &&
    sentDeviceTime - deviceTime <= MAX_ELAPSED_MS
  ) {
    recordedAt = receivedAt - (sentDeviceTime - deviceTime);
    source = "offset";
  } else {
    recordedAt = Math.min(Math.max(deviceTime, receivedAt - MAX_ELAPSED_MS), receivedAt);
    source = "device";
  }
  return {
    recordedAt,
    source,
    // Postgres rounds half away from zero.
    clockDriftSeconds: roundHalfAway((deviceTime - recordedAt) / 1000),
  };
}

function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value)) || 0;
}
