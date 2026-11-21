"use client";

import { useActionState, useId, useState } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import type { WorkerActionState } from "@/server/workforce/action-state";
import {
  approveCrewDayAction,
  decideCrewLeaveAction,
  rejectCrewDayAction,
} from "@/server/workforce/crew-team-actions";

const TEXTAREA =
  "w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

function Done({ message, testId }: { message: string; testId: string }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px] font-semibold"
    >
      {message}
    </p>
  );
}

/** Approve, or Reject with a reason, under one crew day on /m/team. */
export function CrewDayActions({ lineId, running }: { lineId: string; running: boolean }) {
  const [approved, approve] = useActionState<WorkerActionState, FormData>(approveCrewDayAction, null);
  const [rejected, reject] = useActionState<WorkerActionState, FormData>(rejectCrewDayAction, null);
  const [rejecting, setRejecting] = useState(false);
  const id = useId();
  const done = approved?.ok ? approved : rejected?.ok ? rejected : null;
  if (done) return <Done message={done.message} testId="crew-day-done" />;
  if (running) {
    return (
      <p className="m-0 text-sm text-fg-muted">This shift hasn&apos;t finished yet. Decide it once it ends.</p>
    );
  }
  if (rejecting) {
    return (
      <form action={reject} className="flex flex-col gap-3" aria-label="Reject this day">
        <input type="hidden" name="lineId" value={lineId} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            Why isn&apos;t this day right?
          </label>
          <textarea id={id} name="reason" rows={3} required maxLength={500} className={TEXTAREA} />
          <p className="m-0 text-xs text-fg-muted">The worker sees this reason.</p>
        </div>
        <FormAlert message={rejected && !rejected.ok ? rejected.message : undefined} />
        <div className="flex gap-2">
          <SubmitButton size="lg" pendingLabel="Rejecting…">
            Reject day
          </SubmitButton>
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-lg"
            onClick={() => setRejecting(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <FormAlert message={approved && !approved.ok ? approved.message : undefined} />
      <div className="flex gap-2">
        <form action={approve} className="flex-1">
          <input type="hidden" name="lineId" value={lineId} />
          <SubmitButton size="lg" pendingLabel="Approving…" className="w-full">
            Approve
          </SubmitButton>
        </form>
        <Button
          type="button"
          variant="outline"
          className="h-11 flex-1 rounded-lg"
          onClick={() => setRejecting(true)}
          data-testid="crew-day-reject"
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

/** Approve (on to HR) or Decline with a note, under one leave request on /m/team. */
export function CrewLeaveActions({
  requestId,
  needsCertificate,
}: {
  requestId: string;
  needsCertificate: boolean;
}) {
  const [state, action] = useActionState<WorkerActionState, FormData>(decideCrewLeaveAction, null);
  const [declining, setDeclining] = useState(false);
  const noteId = useId();
  const certId = useId();
  if (state?.ok) return <Done message={state.message} testId="crew-leave-done" />;
  return (
    <form action={action} className="flex flex-col gap-3" aria-label="Decide this leave">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="decision" value={declining ? "declined" : "approved"} />
      {needsCertificate && !declining ? (
        <label htmlFor={certId} className="flex min-h-11 items-center gap-3 text-[15px]">
          <input id={certId} type="checkbox" name="certificateSeen" className="size-5" />
          Certificate seen
        </label>
      ) : null}
      {declining ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={noteId} className="text-sm font-medium">
            Why are you declining?
          </label>
          <textarea id={noteId} name="note" rows={3} required maxLength={500} className={TEXTAREA} />
          <p className="m-0 text-xs text-fg-muted">The worker sees this note.</p>
        </div>
      ) : null}
      <FormAlert message={state && !state.ok ? state.message : undefined} />
      {declining ? (
        <div className="flex gap-2">
          <SubmitButton size="lg" pendingLabel="Declining…">
            Decline
          </SubmitButton>
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-lg"
            onClick={() => setDeclining(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <SubmitButton size="lg" pendingLabel="Approving…" className="flex-1">
            Approve
          </SubmitButton>
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1 rounded-lg"
            onClick={() => setDeclining(true)}
            data-testid="crew-leave-decline"
          >
            Decline
          </Button>
        </div>
      )}
    </form>
  );
}
