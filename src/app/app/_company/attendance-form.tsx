"use client";

import { useActionState } from "react";

import { Field } from "@/components/form";
import { LATE_GRACE, NO_SHOW_AFTER, type AttendanceSettings } from "@/lib/attendance";
import { saveAttendance } from "@/server/identity/attendance-actions";

import { CompanyFormFooter, fieldValue } from "./form-footer";

/** Settings -> Company -> Attendance (slice 3.1): late grace and no-show time, in minutes. */
export function AttendanceForm({ settings }: { settings: AttendanceSettings }) {
  const [state, action] = useActionState(saveAttendance, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const defaults = {
    lateGraceMinutes: fieldValue(state, "lateGraceMinutes", settings.lateGraceMinutes),
    noShowAfterMinutes: fieldValue(state, "noShowAfterMinutes", settings.noShowAfterMinutes),
  };

  return (
    <form key={JSON.stringify(defaults)} action={action} noValidate className="flex flex-col gap-6">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
        <Field
          label="Late after (minutes)"
          name="lateGraceMinutes"
          type="number"
          inputMode="numeric"
          min={LATE_GRACE.min}
          max={LATE_GRACE.max}
          required
          hint={`A clock-in this many minutes after the shift starts still counts as on time. ${LATE_GRACE.min} to ${LATE_GRACE.max}.`}
          defaultValue={defaults.lateGraceMinutes}
          error={errors?.lateGraceMinutes}
        />
        <Field
          label="No-show after (minutes)"
          name="noShowAfterMinutes"
          type="number"
          inputMode="numeric"
          min={NO_SHOW_AFTER.min}
          max={NO_SHOW_AFTER.max}
          required
          hint={`With no clock-in by then, the worker shows as a no-show on the live board. ${NO_SHOW_AFTER.min} to ${NO_SHOW_AFTER.max}.`}
          defaultValue={defaults.noShowAfterMinutes}
          error={errors?.noShowAfterMinutes}
        />
      </div>
      <CompanyFormFooter mode="settings" state={state} />
    </form>
  );
}
