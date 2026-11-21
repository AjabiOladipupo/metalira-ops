import { z } from "zod";

import { addDays, formatDate } from "@/lib/dates";
import type { InboxMessage } from "@/lib/inbox";

/**
 * Queries (disciplinary and HR queries) and their replies (slice 4.6, owner decision 10). Pure
 * and browser-safe: the text rule, the schemas' building blocks, overdue and the worker notices.
 * The database checks the same text rule again (private.staff_query_text_ok in migration
 * 20261121160000); tests/unit/queries.test.ts holds the cases.
 */

export const QUERY_KINDS = [
  "lateness",
  "absence_without_leave",
  "conduct",
  "performance",
  "other",
] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export const QUERY_KIND_LABELS: Record<QueryKind, string> = {
  lateness: "Lateness",
  absence_without_leave: "Absence without leave",
  conduct: "Conduct",
  performance: "Performance",
  other: "Other",
};

export const QUERY_STATUSES = ["awaiting_reply", "replied", "closed", "withdrawn"] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

/** Length limits, in characters (the database enforces the same). */
export const QUERY_LIMITS = {
  subject: { min: 3, max: 120 },
  body: { min: 3, max: 2000 },
  reply: { min: 2, max: 2000 },
  outcome: { min: 3, max: 1000 },
} as const;

/** The furthest reply-by date, in days from today (the database enforces the same). */
export const MAX_REPLY_DAYS = 60;
/** The default reply-by date on the form: 3 days from today. */
export const DEFAULT_REPLY_DAYS = 3;
/**
 * Most replies one query takes: 25 from the worker and 5 follow-ups from managers, counted
 * apart so the worker can't use up the managers' follow-ups (the database enforces both).
 */
export const MAX_WORKER_REPLIES = 25;
export const MAX_FOLLOW_UPS = 5;

/** Common domain endings: "acme-pay.com" or "pay.ng" reads as a web address. */
const DOMAIN = /\b[a-z0-9-]+\.(com|net|org|ng|io|co|info|biz|xyz|app|ly|link|site|online)\b/i;

/** True when the text holds a web address: "://", "www." or a word ending in a common domain. */
export function hasWebAddress(text: string): boolean {
  return /:\/\/|www\./i.test(text) || DOMAIN.test(text);
}

/**
 * A personal number (rule 9): 10 or more digits with only spaces or hyphens between them, as the
 * inbox rule (src/lib/inbox.ts). Dates and times ("21/11/2026 08:00") stay allowed.
 */
export function hasLongDigitRun(text: string): boolean {
  return /[0-9](?:[ -]*[0-9]){9,}/.test(text);
}

/** Control characters other than a line break, or < and >. */
function hasControlOrMarkup(text: string, multiline: boolean): boolean {
  const checked = multiline ? text.replace(/\n/g, "") : text;
  return /[\p{Cc}<>]/u.test(checked);
}

/** Text as stored: Windows line breaks made plain, outer white space trimmed. */
export function normaliseQueryText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export type QueryTextProblem = "length" | "markup" | "web" | "number";

/** What is wrong with `text` (already normalised), or null when it may be stored. */
export function queryTextProblem(
  text: string,
  limits: { min: number; max: number },
  multiline: boolean,
): QueryTextProblem | null {
  if (text.length < limits.min || text.length > limits.max) return "length";
  if (hasControlOrMarkup(text, multiline)) return "markup";
  if (hasWebAddress(text)) return "web";
  if (hasLongDigitRun(text)) return "number";
  return null;
}

const PROBLEM_MESSAGES: Record<Exclude<QueryTextProblem, "length">, string> = {
  markup: "Use plain text, without < or >.",
  web: "Leave web addresses out.",
  number: "Leave out long numbers such as phone, account or ID numbers.",
};

/** A Zod string for query text: normalised, then checked against the rule. */
export function queryText(label: string, limits: { min: number; max: number }, multiline: boolean) {
  return z
    .string(`Write the ${label}`)
    .transform(normaliseQueryText)
    .superRefine((value, ctx) => {
      const problem = queryTextProblem(value, limits, multiline);
      if (!problem) return;
      ctx.addIssue({
        code: "custom",
        message:
          problem === "length"
            ? `The ${label} needs ${limits.min} to ${limits.max.toLocaleString("en-NG")} characters.`
            : PROBLEM_MESSAGES[problem],
      });
    });
}

/** The reply-by dates the form allows: today to 60 days ahead, in the company's calendar. */
export function replyByRange(today: string): { min: string; max: string } {
  return { min: today, max: addDays(today, MAX_REPLY_DAYS) };
}

/** Overdue is worked out on read: still awaiting the worker's reply after the reply-by date. */
export function isQueryOverdue(query: { status: QueryStatus; replyBy: string }, today: string) {
  return query.status === "awaiting_reply" && query.replyBy < today;
}

/** Whether the query still takes replies. */
export function isQueryOpen(status: QueryStatus): boolean {
  return status === "awaiting_reply" || status === "replied";
}

/** The status a manager reads: "Awaiting reply", "Overdue", "Replied", "Closed", "Withdrawn". */
export function queryStatusLabel(
  query: { status: QueryStatus; replyBy: string },
  today: string,
): string {
  if (isQueryOverdue(query, today)) return "Overdue";
  switch (query.status) {
    case "awaiting_reply":
      return "Awaiting reply";
    case "replied":
      return "Replied";
    case "closed":
      return "Closed";
    case "withdrawn":
      return "Withdrawn";
  }
}

/** Counts for the HR file's heading: numbers only. */
export function summariseQueries(
  queries: readonly { status: QueryStatus; replyBy: string }[],
  today: string,
): { total: number; open: number; overdue: number; closed: number } {
  return {
    total: queries.length,
    open: queries.filter((q) => isQueryOpen(q.status)).length,
    overdue: queries.filter((q) => isQueryOverdue(q, today)).length,
    closed: queries.filter((q) => !isQueryOpen(q.status)).length,
  };
}

/**
 * The inbox item a worker gets for a new query. No query text in the notice: the worker reads
 * it in the app, so nothing the manager typed reaches an email. The subject passed the same
 * rule as inbox text.
 */
export function newQueryNotice(input: { subject: string; replyBy: string }): InboxMessage {
  return {
    kind: "staff_query",
    title: `New query: ${input.subject}`.slice(0, 120).trim(),
    body: `Reply by ${formatDate(input.replyBy)}. Open Queries in the app to read it and reply.`,
    link: "/m/queries",
  };
}

/** The reminder the day before the reply-by date (the daily cron). */
export function queryReminderNotice(input: { subject: string; replyBy: string }): InboxMessage {
  return {
    kind: "staff_query_reminder",
    title: `Reply by tomorrow: ${input.subject}`.slice(0, 120).trim(),
    body: `Your reply to this query is due by ${formatDate(input.replyBy)}. Open Queries in the app to reply.`,
    link: "/m/queries",
  };
}

/** A manager added a follow-up to the worker's query. */
export function queryFollowUpNotice(input: { subject: string }): InboxMessage {
  return {
    kind: "staff_query",
    title: `Follow-up on your query: ${input.subject}`.slice(0, 120).trim(),
    body: "Your manager added a follow-up. Open Queries in the app to read it and reply.",
    link: "/m/queries",
  };
}

/** The query was closed: the outcome note is shown in the app, not in the notice. */
export function queryClosedNotice(input: { subject: string }): InboxMessage {
  return {
    kind: "staff_query",
    title: `Query closed: ${input.subject}`.slice(0, 120).trim(),
    body: "Your manager closed this query. Open Queries in the app to read the outcome.",
    link: "/m/queries",
  };
}
