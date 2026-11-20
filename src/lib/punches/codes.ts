import type { SendResult } from "@/lib/offline/types";

/**
 * The fixed codes a punch send can end with (slice 3.5). The server maps every failure to one of
 * these; the phone's queue stores only the code (never a server message, a name or a place) and
 * decides from it whether to try again. Isomorphic.
 */
export const PUNCH_ERROR_CODES = [
  // Worth trying again.
  "wrong_session",
  "signed_out",
  "rate_limited",
  "photo_failed",
  "failed",
  // Never worth trying again: the server refused it for good.
  "not_worker",
  "left",
  "shifts_off",
  "no_consent",
  "conflict",
  "invalid",
  "bad_site",
] as const;

export type PunchErrorCode = (typeof PUNCH_ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<PunchErrorCode> = new Set([
  "wrong_session",
  "signed_out",
  "rate_limited",
  "photo_failed",
  "failed",
]);

export function isRetryableCode(code: PunchErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function isPunchErrorCode(value: unknown): value is PunchErrorCode {
  return typeof value === "string" && (PUNCH_ERROR_CODES as readonly string[]).includes(value);
}

/** The database's refusal (SQLSTATE) as a fixed code. Anything unknown is a transient failure. */
export function codeFromSqlState(sqlState: string | undefined | null): PunchErrorCode {
  switch (sqlState) {
    case "MLPU1":
    case "42501":
      return "not_worker";
    case "MLPU2":
      return "conflict";
    case "MLPU3":
      return "left";
    case "MLPU4":
      return "shifts_off";
    case "MLPU5":
    case "22023":
    case "22P02":
      return "invalid";
    case "MLPU6":
      return "no_consent";
    case "MLPU7":
      return "bad_site";
    case "MLPU8":
      return "rate_limited";
    case "MLPU9":
      return "wrong_session";
    default:
      return "failed";
  }
}

/** What the record-punch action answers. Never carries server text. */
export type RecordPunchResult =
  | {
      ok: true;
      punchId: string;
      duplicate: boolean;
      /** The server wants this punch's selfie (expected and not uploaded yet). */
      selfieWanted: boolean;
      geofence: "inside" | "near" | "outside" | "unknown";
      flags: string[];
    }
  | { ok: false; code: PunchErrorCode };

/** What the selfie upload answers. */
export type UploadSelfieResult =
  | { ok: true }
  | { ok: false; code: "photo_invalid" | "photo_refused" | PunchErrorCode };

/**
 * The queue's fixed code for a server code (src/lib/offline/types.ts QUEUE_ERROR_CODES). The
 * queue keeps only these: never a server message or a payload value.
 */
export function queueResultFor(code: PunchErrorCode): SendResult {
  switch (code) {
    case "wrong_session":
    case "signed_out":
      // Not this session's punch (or no session): it stays queued for its owner.
      return { ok: false, wrongSession: true };
    case "rate_limited":
      return { ok: false, retryable: true, error: "rate_limited" };
    case "failed":
    case "photo_failed":
      return { ok: false, retryable: true, error: "server_error" };
    case "invalid":
      return { ok: false, retryable: false, error: "invalid" };
    default:
      return { ok: false, retryable: false, error: "rejected" };
  }
}

/** The queue's verdict for one send, from the two answers. */
export function sendOutcome(
  record: RecordPunchResult,
  upload: UploadSelfieResult | null,
): SendResult {
  if (!record.ok) return queueResultFor(record.code);
  if (upload === null || upload.ok) return { ok: true };
  // The punch is recorded. A photo the server will never take (bad bytes, or the punch no
  // longer wants one) is dropped rather than blocking the queue; anything else is retried, and
  // the resend finds the punch already recorded.
  if (upload.code === "photo_invalid" || upload.code === "photo_refused") return { ok: true };
  if (!isRetryableCode(upload.code)) return { ok: true };
  return queueResultFor(upload.code);
}
