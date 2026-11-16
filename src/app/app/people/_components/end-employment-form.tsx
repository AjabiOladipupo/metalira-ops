"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { endEmploymentAction } from "@/server/people/actions";

/**
 * Ends employment on the last working day and closes the employee's current site and project
 * assignments on that day. The record stays; nothing is deleted.
 */
export function EndEmploymentForm({ workerId, today }: { workerId: string; today: string }) {
  const [state, action] = useActionState(endEmploymentAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;

  return (
    <form
      key={JSON.stringify(typed ?? null)}
      action={action}
      noValidate
      aria-label="End employment"
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="workerId" value={workerId} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4">
        <Field
          label="Last working day"
          name="endDate"
          type="date"
          required
          defaultValue={typed?.endDate ?? today}
          error={errors?.endDate}
        />
        <Field
          label="Reason"
          name="reason"
          hint="Optional. Kept in the audit log."
          maxLength={1000}
          defaultValue={typed?.reason ?? ""}
          error={errors?.reason}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          End employment
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
