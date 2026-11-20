import { z } from "zod";

/**
 * Company attendance settings (slice 3.1, owner decision 20 Nov 2026). The database holds the
 * same ranges (organisations constraints in migration 20261120112000).
 */
export const LATE_GRACE = { min: 0, max: 120, default: 10 } as const;
export const NO_SHOW_AFTER = { min: 15, max: 480, default: 60 } as const;

function minutes(min: number, max: number, message: string) {
  return z
    .string(message)
    .trim()
    .regex(/^\d{1,3}$/, message)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(min, message).max(max, message));
}

export const attendanceSettingsSchema = z
  .object({
    lateGraceMinutes: minutes(
      LATE_GRACE.min,
      LATE_GRACE.max,
      `Enter ${LATE_GRACE.min} to ${LATE_GRACE.max} minutes`,
    ),
    noShowAfterMinutes: minutes(
      NO_SHOW_AFTER.min,
      NO_SHOW_AFTER.max,
      `Enter ${NO_SHOW_AFTER.min} to ${NO_SHOW_AFTER.max} minutes`,
    ),
  })
  .refine((value) => value.noShowAfterMinutes >= value.lateGraceMinutes, {
    path: ["noShowAfterMinutes"],
    message: "A no-show can't come before the end of the grace period",
  });

export type AttendanceSettings = z.output<typeof attendanceSettingsSchema>;
