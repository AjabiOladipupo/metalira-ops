import "server-only";

import { attendanceSettingsSchema, type AttendanceSettings } from "@/lib/attendance";
import { createServerSupabase } from "@/lib/supabase/server";

import { COMPANY_ROLES } from "./company-mutations";
import { MutationError, type MutationSpec } from "./mutate";

/**
 * Settings -> Company -> Attendance (slice 3.1): the late grace period and when a missing
 * clock-in becomes a no-show. Owner and admin only, here and in the database
 * (organisations_update policy and a column grant); the organisations_audit trigger logs each
 * change. Slices 3.5 and 3.7 read them.
 */

export const saveAttendanceSpec = {
  schema: attendanceSettingsSchema,
  roles: COMPANY_ROLES,
  run: async (ctx) => {
    const { data, error } = await ctx.supabase
      .from("organisations")
      .update({
        late_grace_minutes: ctx.data.lateGraceMinutes,
        no_show_after_minutes: ctx.data.noShowAfterMinutes,
      })
      .eq("id", ctx.organisationId)
      .select("id");
    if (error) {
      if (error.code === "23514") {
        throw new MutationError("invalid", "Check the minutes and try again.");
      }
      throw new Error(`Could not save the attendance settings (${error.code})`);
    }
    if (!data || data.length === 0) {
      throw new MutationError("forbidden", "Your role can't make this change.");
    }
  },
} satisfies MutationSpec<typeof attendanceSettingsSchema, void>;

/** The company's attendance settings, read under RLS as the signed-in member. */
export async function loadAttendanceSettings(
  organisationId: string,
): Promise<AttendanceSettings | null> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("organisations")
    .select("late_grace_minutes, no_show_after_minutes")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the attendance settings (${error.code})`);
  if (!data) return null;
  return {
    lateGraceMinutes: data.late_grace_minutes,
    noShowAfterMinutes: data.no_show_after_minutes,
  };
}
