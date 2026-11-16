import { Constants, type Database } from "@/types/db";

/**
 * Pure rules for "Request a change" in the worker app (slice 1.10). Bank details go through
 * the two-person bank-detail change (slice 1.7); everything else is a free-text request HR sees
 * on the worker page (public.worker_change_requests). Browser-safe: no I/O.
 */

export type WorkerChangeTopic = Database["public"]["Enums"]["worker_change_topic"];
export type WorkerChangeRequestStatus =
  Database["public"]["Enums"]["worker_change_request_status"];

/** The topics a free-text request can be about, in the order the form lists them. */
export const WORKER_CHANGE_TOPICS: readonly WorkerChangeTopic[] =
  Constants.public.Enums.worker_change_topic;

/** What the worker picks first: bank details, or one of the free-text topics. */
export type RequestChoice = "bank" | WorkerChangeTopic;
export const REQUEST_CHOICES: readonly RequestChoice[] = ["bank", ...WORKER_CHANGE_TOPICS];

/** Most requests one worker may have waiting for HR (the database enforces the same). */
export const MAX_OPEN_CHANGE_REQUESTS = 5;
/** Longest request text, in characters (the database enforces the same). */
export const CHANGE_REQUEST_MAX = 500;
export const CHANGE_REQUEST_MIN = 3;

/** Separators people type inside numbers: spaces, dots, dashes, brackets and slashes. */
const NUMBER_SEPARATORS = /[\s.()/-]/g;

/**
 * True when the text holds a run of 10 or more digits once separators are removed: a NIN,
 * bank account, RSA PIN or phone number. Such text is refused (the database check matches), so
 * personal numbers never reach the request or the audit log in clear (CLAUDE.md rule 9).
 */
export function hasPersonalNumber(text: string): boolean {
  return /[0-9]{10,}/.test(text.replace(NUMBER_SEPARATORS, ""));
}

/** Text as stored: Windows line breaks made plain, outer spaces trimmed. */
export function normaliseRequestText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Plain text: line breaks allowed; other control characters and < > refused. */
export function isPlainRequestText(text: string): boolean {
  return !/[\p{Cc}<>]/u.test(text.replace(/\n/g, ""));
}
