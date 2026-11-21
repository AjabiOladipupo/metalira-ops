import { z } from "zod";

import { cleanLeaveText } from "@/lib/leave/requests";

/**
 * Input schemas for leave requests, decisions, cancellations and balance adjustments (slice 4.4).
 * Each takes the form's string fields (or plain values from the capability registry) and gives
 * what the SQL function takes. The organisation and, in the worker app, the worker come from the
 * session, never from here. The database checks every value again.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const TEXT_RULE = "Up to 500 characters of plain text, with no web addresses or long numbers";

const isoDate = (message: string) =>
  z
    .string(message)
    .regex(ISO_DATE, message)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), message);

/** A ticked checkbox ("on"), or a boolean from the registry. */
const checkbox = z
  .union([z.boolean(), z.string().max(5)])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

/** Optional plain text: empty is null. */
const optionalText = z
  .string()
  .max(2000, TEXT_RULE)
  .nullish()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v.trim() === "") return null;
    const clean = cleanLeaveText(v);
    if (clean === null) {
      ctx.addIssue({ code: "custom", message: TEXT_RULE });
      return z.NEVER;
    }
    return clean;
  });

/** Required plain text. */
function requiredText(message: string) {
  return z
    .string(message)
    .max(2000, TEXT_RULE)
    .transform((v, ctx) => {
      const clean = cleanLeaveText(v);
      if (clean === null) {
        ctx.addIssue({ code: "custom", message: v.trim() === "" ? message : TEXT_RULE });
        return z.NEVER;
      }
      return clean;
    });
}

/** The worker asks for leave (worker app). */
export const requestLeaveSchema = z
  .object({
    leaveTypeId: z.uuid("Choose a leave type"),
    startDate: isoDate("Choose the first day"),
    endDate: isoDate("Choose the last day"),
    reason: optionalText,
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "Choose a last day on or after the first",
    path: ["endDate"],
  });

export const leaveRequestIdSchema = z.object({ requestId: z.uuid("Choose a request") });

/** The worker cancels their own request before the final decision. */
export const cancelOwnLeaveSchema = leaveRequestIdSchema;

/** A decision at either step. A decline needs a note for the worker. */
export const decideLeaveSchema = z
  .object({
    requestId: z.uuid("Choose a request"),
    decision: z.enum(["approved", "declined"], { error: "Approve or decline" }),
    note: optionalText,
    certificateSeen: checkbox,
  })
  .refine((v) => v.decision === "approved" || v.note !== null, {
    message: "Say why, so the worker knows",
    path: ["note"],
  });

/** HR cancels a live request, with a reason; approved leave gives its days back. */
export const cancelLeaveSchema = z.object({
  requestId: z.uuid("Choose a request"),
  reason: requiredText("Say why it is cancelled, so the worker knows"),
});

/** HR adds or takes away days, with a reason. */
export const adjustLeaveSchema = z.object({
  workerId: z.uuid("Choose a worker"),
  leaveTypeId: z.uuid("Choose a leave type"),
  year: z
    .union([z.number(), z.string().trim().regex(/^\d{4}$/, "Choose a year")])
    .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(2000, "Choose a year").max(2100, "Choose a year")),
  days: z
    .union([z.number(), z.string().trim().regex(/^[+-]?\d{1,3}$/, "A whole number of days, such as 2 or -1")])
    .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
    .pipe(
      z
        .number()
        .int("A whole number of days")
        .min(-366, "At most 366 days")
        .max(366, "At most 366 days")
        .refine((n) => n !== 0, "Add or take away at least 1 day"),
    ),
  reason: requiredText("Give a reason"),
});

/** The requests list's filters (manager app and the registry read). */
export const leaveListSchema = z.object({
  status: z.enum(["waiting", "all", "approved"]).optional(),
  from: isoDate("Choose a day").optional(),
  to: isoDate("Choose a day").optional(),
});

/** One worker's balances for a year (registry read). */
export const leaveBalancesSchema = z.object({
  workerId: z.uuid("Choose a worker").optional(),
  year: z.number().int().min(2000).max(2100).optional(),
});
