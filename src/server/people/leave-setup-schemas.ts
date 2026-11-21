import { z } from "zod";

import { normaliseWorkDays } from "@/lib/leave/entitlements";

/**
 * Input schemas for leave setup and the company calendar (slice 4.1). Each takes the form's
 * string fields (or plain values from the capability registry) and gives what the SQL function
 * takes. The database checks every value again.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A ticked checkbox ("on"), or a boolean from the registry. */
const checkbox = z
  .union([z.boolean(), z.string().max(5)])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

/** Plain text: trimmed, no control characters, angle brackets or web addresses. */
function plainName(max: number, label: string) {
  const message = `${label} of up to ${max} characters, with no web addresses`;
  return z
    .string(message)
    .trim()
    .min(1, message)
    .max(max, message)
    .refine((v) => !/[\u0001-\u001f\u007f-\u009f<>]/.test(v), message)
    .refine((v) => !/(:\/\/|www\.)/i.test(v), message);
}

/** A whole number in range, from a form field or a number. */
function whole(min: number, max: number, message: string) {
  return z
    .union([z.number(), z.string().trim().regex(/^\d{1,3}$/, message)])
    .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int(message).min(min, message).max(max, message));
}

/** Like `whole`, but an empty field is null. */
function optionalWhole(min: number, max: number, message: string) {
  return z
    .union([z.number(), z.string().trim(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : /^\d{1,3}$/.test(v) ? Number.parseInt(v, 10) : NaN;
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return n;
    });
}

const isoDate = (message: string) =>
  z
    .string(message)
    .regex(ISO_DATE, message)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), message);

const year = z
  .union([z.number(), z.string().trim().regex(/^\d{4}$/, "Choose a year")])
  .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
  .pipe(z.number().int().min(2000, "Choose a year").max(2100, "Choose a year"));

export const addHolidaySchema = z.object({
  date: isoDate("Choose the holiday's date"),
  name: plainName(80, "Give the holiday a name"),
});

export const removeHolidaySchema = z.object({
  holidayId: z.uuid("Choose a holiday"),
});

export const copyHolidaysSchema = z
  .object({ fromYear: year, toYear: year })
  .refine((v) => v.fromYear !== v.toYear, {
    path: ["toYear"],
    message: "Copy from one year into another",
  });

/**
 * The working week: form checkboxes `day_1` to `day_7`, or `days` as a list of ISO weekdays from
 * the registry.
 */
export const workWeekSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    day_1: checkbox,
    day_2: checkbox,
    day_3: checkbox,
    day_4: checkbox,
    day_5: checkbox,
    day_6: checkbox,
    day_7: checkbox,
  })
  .transform((v, ctx) => {
    const ticked = [v.day_1, v.day_2, v.day_3, v.day_4, v.day_5, v.day_6, v.day_7].flatMap(
      (on, i) => (on ? [i + 1] : []),
    );
    const days = normaliseWorkDays(v.days ?? ticked);
    if (!days) {
      ctx.addIssue({ code: "custom", path: ["days"], message: "Choose at least one working day" });
      return z.NEVER;
    }
    return { days };
  });

export const COUNTINGS = ["working_days", "calendar_days"] as const;

const counting = z.enum(COUNTINGS, "Choose working days or calendar days");

const typeDetails = {
  name: plainName(60, "Give the leave type a name"),
  counting,
  paid: checkbox,
  needsCertificate: checkbox,
  minServiceMonths: whole(0, 120, "Enter 0 to 120 months"),
};

export const createLeaveTypeSchema = z
  .object({
    ...typeDetails,
    daysPerYear: whole(0, 366, "Enter 0 to 366 days"),
    carryOverCapDays: optionalWhole(0, 366, "Enter 0 to 366 days, or leave it empty"),
    payPercent: optionalWhole(0, 100, "Enter 0 to 100"),
  })
  .transform((v) => ({ ...v, payPercent: v.paid ? (v.payPercent ?? 100) : 0 }));

export const saveLeaveTypeSchema = z.object({
  leaveTypeId: z.uuid("Choose a leave type"),
  ...typeDetails,
  status: z.enum(["active", "retired"], "Choose active or retired"),
});

export const entitlementVersionSchema = z.object({
  leaveTypeId: z.uuid("Choose a leave type"),
  effectiveFrom: isoDate("Choose when the change starts"),
  daysPerYear: whole(0, 366, "Enter 0 to 366 days"),
  carryOverCapDays: optionalWhole(0, 366, "Enter 0 to 366 days, or leave it empty"),
  payPercent: whole(0, 100, "Enter 0 to 100"),
  payMinServiceMonths: optionalWhole(0, 120, "Enter 0 to 120 months, or leave it empty"),
});

export const applyPresetSchema = z.object({
  preset: z.enum(["A", "B"], "Choose preset A or B"),
  /** When changes to types the company already has start; empty for the next 1 January. */
  effectiveFrom: z
    .union([isoDate("Choose when the changes start"), z.literal("")])
    .optional()
    .transform((v) => (v ? v : null)),
});

export const holidayYearSchema = z.object({ year });

export type EntitlementVersionInput = z.output<typeof entitlementVersionSchema>;
