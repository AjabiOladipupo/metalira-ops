"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import { WEEKDAYS } from "@/lib/leave/entitlements";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  addHolidayAction,
  copyHolidaysAction,
  removeHolidayAction,
  setWorkWeekAction,
} from "@/server/people/leave-setup-actions";

import { fieldValue } from "../../../_company/form-footer";

/** Adds a public holiday on a date in the year shown. */
export function AddHolidayForm({ year }: { year: number }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(addHolidayAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      key={state?.ok ? state.message : "add-holiday"}
      action={action}
      noValidate
      aria-label="Add a holiday"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-start gap-4">
        <Field
          label="Date"
          name="date"
          type="date"
          required
          min={`${year}-01-01`}
          max={`${year}-12-31`}
          defaultValue={fieldValue(state, "date", "")}
          error={errors?.date}
        />
        <Field
          label="Name"
          name="name"
          required
          maxLength={80}
          placeholder="Independence Day"
          defaultValue={fieldValue(state, "name", "")}
          error={errors?.name}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Adding…" className="w-auto px-5">
          Add holiday
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}

/** Removes one holiday. The row is kept, marked removed. */
export function RemoveHolidayForm({ holidayId, name }: { holidayId: string; name: string }) {
  const [state, action, pending] = useActionState<CompanyFormState, FormData>(
    removeHolidayAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="holidayId" value={holidayId} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`Remove ${name}`}
      >
        {pending ? "Removing…" : "Remove"}
      </Button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs font-medium">
          {state.formError}
        </span>
      ) : null}
    </form>
  );
}

/** Confirms copying holidays after the preview. */
export function CopyHolidaysForm({
  fromYear,
  toYear,
  count,
}: {
  fromYear: number;
  toYear: number;
  count: number;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(copyHolidaysAction, null);
  return (
    <form action={action} aria-label="Copy holidays" className="flex flex-col gap-3">
      <input type="hidden" name="fromYear" value={fromYear} />
      <input type="hidden" name="toYear" value={toYear} />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton pendingLabel="Copying…" className="sm:w-auto sm:self-start sm:px-5">
        {`Copy ${count} ${count === 1 ? "holiday" : "holidays"}`}
      </SubmitButton>
    </form>
  );
}

/** The company's working week: a box per day, Monday first. */
export function WorkWeekForm({ days }: { days: number[] }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(setWorkWeekAction, null);
  const typed = state && !state.ok ? state.values : undefined;
  return (
    <form
      key={state?.ok ? days.join(",") : "work-week"}
      action={action}
      aria-label="Working week"
      className="flex flex-col gap-4"
    >
      <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
        <legend className="mb-2 text-[13px] font-medium">Working days</legend>
        {WEEKDAYS.map((d) => (
          <label
            key={d.iso}
            className="flex h-11 min-w-16 items-center justify-center gap-2 rounded-lg border border-line px-3 text-sm has-checked:border-foreground has-checked:font-semibold"
          >
            <input
              type="checkbox"
              name={`day_${d.iso}`}
              defaultChecked={typed ? typed[`day_${d.iso}`] === "on" : days.includes(d.iso)}
              className="size-4 accent-[var(--signal)]"
            />
            <span title={d.long}>{d.short}</span>
          </label>
        ))}
      </fieldset>
      <FormAlert
        message={state && !state.ok ? (state.fieldErrors?.days ?? state.formError) : undefined}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save working week
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
