"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert, SelectField, SubmitButton } from "@/components/form";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { assignTeamShiftAction, removeTeamShiftAction } from "@/server/people/team-actions";

export interface AssignChoice {
  /** `<postId>|<date>`. */
  value: string;
  label: string;
}

export interface UpcomingShift {
  assignmentId: string;
  label: string;
  canRemove: boolean;
}

function RemoveButton({ assignmentId, label }: { assignmentId: string; label: string }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(removeTeamShiftAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-1" aria-label={`Take off ${label}`}>
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <button
        type="submit"
        className="h-9 rounded-lg border border-line bg-background px-3 text-[13px] font-medium text-foreground hover:bg-surface"
      >
        Take off
      </button>
      {state && !state.ok ? <span className="text-xs font-medium">{state.formError}</span> : null}
    </form>
  );
}

/**
 * "Assign a shift" (Team board): the reportee, an open shift at the team's sites, Assign and
 * Cancel; below it, their upcoming shifts with Take off. The database checks the reportee and
 * the site again, and the roster's guard refuses clashes, full shifts and approved leave.
 */
export function AssignPanel({
  workerId,
  workerName,
  choices,
  upcoming,
}: {
  workerId: string;
  workerName: string;
  choices: readonly AssignChoice[];
  upcoming: readonly UpcomingShift[];
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(assignTeamShiftAction, null);
  return (
    <section
      aria-labelledby="assign-title"
      data-testid="team-assign-panel"
      className="flex flex-col gap-4 rounded-xl border-[1.5px] border-foreground p-4"
    >
      <form
        key={state?.ok ? state.message : "form"}
        action={action}
        className="flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="workerId" value={workerId} />
        <input type="hidden" name="workerName" value={workerName} />
        <span className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
          <span id="assign-title" className="type-label text-fg-muted">
            Assign a shift
          </span>
          <span className="text-base font-semibold">{workerName}</span>
        </span>
        {choices.length === 0 ? (
          <p className="m-0 flex-[2_1_280px] text-sm text-fg-muted">
            No open shifts at your team&apos;s sites in the next 14 days.
          </p>
        ) : (
          <>
            <SelectField
              label="Open shift"
              name="slot"
              options={choices}
              className="min-w-0 flex-[2_1_280px]"
            />
            <SubmitButton pendingLabel="Assigning…" className="w-auto px-5 sm:w-auto">
              Assign
            </SubmitButton>
          </>
        )}
        <Link
          href="/app/team"
          className="inline-flex h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-foreground no-underline hover:bg-surface hover:text-foreground"
        >
          {state?.ok ? "Done" : "Cancel"}
        </Link>
      </form>
      {state?.ok ? (
        <p role="status" className="m-0 rounded-lg bg-surface px-3 py-2.5 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {upcoming.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="type-label text-fg-muted">Upcoming shifts</span>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {upcoming.map((s) => (
              <li key={s.assignmentId} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">{s.label}</span>
                {s.canRemove ? <RemoveButton assignmentId={s.assignmentId} label={s.label} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
