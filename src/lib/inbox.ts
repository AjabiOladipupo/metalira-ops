import { z } from "zod";

import { hasPersonalNumber } from "@/lib/worker-requests";

/**
 * Worker inbox rules shared by the server and its tests (slice 3.1). The database checks the same
 * things again (inbox_items constraints in migration 20261120111000).
 */

/** An internal worker-app path: "/m" or "/m/shifts", letters, digits, "_" and "-" only. */
const WORKER_PATH = /^\/m(\/[A-Za-z0-9_-]+)*$/;

/** True for a path inside the worker app that can't lead anywhere else ("//x", "/m/../app"). */
export function isWorkerAppPath(path: string): boolean {
  return path.length <= 200 && WORKER_PATH.test(path);
}

const NO_WEB_ADDRESS = (value: string) => !/:\/\/|www\./i.test(value);

/**
 * What notifyWorker takes. Plain text only, no web addresses: links are internal paths. Never
 * personal numbers (NIN, BVN, account numbers, RSA PIN; rule 9): a run of 10 or more digits is
 * refused, because each item is also copied to the audit log and owner, admin and HR can read it.
 */
export const inboxMessageSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z_]{1,39}$/, "Use a short lower_case kind"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\p{Cc}<>]*$/u, "Plain text only")
    .refine(NO_WEB_ADDRESS, "No web addresses"),
  body: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    // Line breaks are fine; other control characters and angle brackets are not.
    .refine((value) => !/[\p{Cc}<>]/u.test(value.replace(/\n/g, "")), "Plain text only")
    .refine(NO_WEB_ADDRESS, "No web addresses")
    .refine((value) => !hasPersonalNumber(value), "No personal numbers"),
  link: z
    .string()
    .refine(isWorkerAppPath, "Links must be a worker-app path such as /m/shifts")
    .nullish(),
});

export type InboxMessage = z.input<typeof inboxMessageSchema>;

/**
 * Email caps for worker notices (Resend Free sends 100 emails a day for the whole account):
 * at most 30 per company and 80 overall in any 24 hours, leaving room for invites and other
 * mail. Past a cap the inbox item is still added; only the email is skipped. Slice 3.3 sends one
 * email per worker per roster publish, not one per shift, to stay inside them.
 */
export const INBOX_EMAIL_CAPS = { perCompany: 30, overall: 80 } as const;

/** Whether one more email fits, given what was sent in the last 24 hours. */
export function emailFits(
  sent: { company: number; overall: number },
  caps: { perCompany: number; overall: number } = INBOX_EMAIL_CAPS,
): boolean {
  return sent.company < caps.perCompany && sent.overall < caps.overall;
}
