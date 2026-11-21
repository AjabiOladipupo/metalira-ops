"use client";

import { useActionState, useId, useState } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import type { WorkerActionState } from "@/server/workforce/action-state";
import { disputeTimesheetLineAction } from "@/server/workforce/timesheet-approval-actions";

/** "This is wrong" under one day on /m/hours: the worker says why, and it goes to the approver. */
export function DisputeForm({ lineId }: { lineId: string }) {
  const [state, action] = useActionState<WorkerActionState, FormData>(
    disputeTimesheetLineAction,
    null,
  );
  const [open, setOpen] = useState(false);
  const id = useId();
  if (state?.ok) {
    return (
      <p
        role="status"
        data-testid="dispute-sent"
        className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px] font-semibold"
      >
        {state.message}
      </p>
    );
  }
  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="h-11 self-start rounded-lg"
        onClick={() => setOpen(true)}
        data-testid="dispute-open"
      >
        This is wrong
      </Button>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3" aria-label="This is wrong">
      <input type="hidden" name="lineId" value={lineId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          What is wrong with this day?
        </label>
        <textarea
          id={id}
          name="reason"
          rows={3}
          required
          maxLength={500}
          className="w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
        <p className="m-0 text-xs text-fg-muted">
          For example: I clocked out at 19:00 but my phone was off.
        </p>
      </div>
      <FormAlert message={state && !state.ok ? state.message : undefined} />
      <SubmitButton size="lg" pendingLabel="Sending…">
        Send to my manager
      </SubmitButton>
    </form>
  );
}
