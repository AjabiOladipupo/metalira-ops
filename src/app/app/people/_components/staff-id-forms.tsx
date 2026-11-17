"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  decideStaffIdCorrectionAction,
  requestStaffIdCorrectionAction,
  unlockSignInAction,
  withdrawStaffIdCorrectionAction,
} from "@/server/people/staff-id-actions";

/**
 * "Correct staff ID" on an employee (slice 1.11). Raises a correction; nothing changes until
 * someone other than the requester approves it. Collapsed by default: a typo fix is rare.
 */
export function StaffIdCorrectionForm({
  workerId,
  currentStaffId,
}: {
  workerId: string;
  currentStaffId: string;
}) {
  const [state, action] = useActionState(requestStaffIdCorrectionAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;

  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm text-fg-muted">
        {state.message}
      </p>
    );
  }

  return (
    <details className="group rounded-xl border border-line" open={Boolean(typed)}>
      <summary className="cursor-pointer list-none p-4 text-sm font-semibold sm:px-5 [&::-webkit-details-marker]:hidden">
        Correct staff ID
        <span className="ml-2 font-normal text-fg-muted">
          For a typo, before any clock-ins or pay
        </span>
      </summary>
      <form
        key={JSON.stringify(typed ?? null)}
        action={action}
        noValidate
        aria-label="Correct staff ID"
        className="flex flex-col gap-4 border-t border-line p-4 sm:p-5"
      >
        <input type="hidden" name="workerId" value={workerId} />
        <p className="m-0 text-sm text-fg-muted">
          Someone other than you approves the change. After that the employee signs in with the
          new ID, and {currentStaffId} can never be given to anyone else in your company.
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
          <Field
            label="New staff ID"
            name="newStaffId"
            autoComplete="off"
            maxLength={40}
            defaultValue={typed?.newStaffId ?? ""}
            error={errors?.newStaffId}
          />
          <Field
            label="Reason"
            name="reason"
            hint="Shown to the approver, for example “Typo at import”."
            maxLength={500}
            defaultValue={typed?.reason ?? ""}
            error={errors?.reason}
          />
        </div>
        <FormAlert message={state && !state.ok ? state.formError : undefined} />
        <div>
          <SubmitButton pendingLabel="Sending…" className="w-auto px-5">
            Send for approval
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}

/** Approve or reject a correction someone else raised. */
export function StaffIdDecision({ correctionId, label }: { correctionId: string; label: string }) {
  const [state, action, pending] = useActionState(decideStaffIdCorrectionAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} aria-label={label} className="flex flex-col gap-3">
      <input type="hidden" name="correctionId" value={correctionId} />
      <Field
        label="Note"
        name="note"
        hint="Optional. Kept with the decision."
        maxLength={500}
        className="max-w-md"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className="h-10 rounded-lg"
        >
          Approve
        </Button>
        <Button
          type="submit"
          name="decision"
          value="reject"
          variant="outline"
          disabled={pending}
          className="h-10 rounded-lg"
        >
          Reject
        </Button>
        {pending ? (
          <span role="status" className="text-sm text-fg-muted">
            Saving…
          </span>
        ) : null}
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
    </form>
  );
}

/** The requester takes back a correction nobody has decided yet. */
export function StaffIdWithdraw({ correctionId }: { correctionId: string }) {
  const [state, action, pending] = useActionState(withdrawStaffIdCorrectionAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="correctionId" value={correctionId} />
      <div>
        <Button type="submit" variant="outline" disabled={pending} className="h-10 rounded-lg">
          {pending ? "Withdrawing…" : "Withdraw correction"}
        </Button>
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
    </form>
  );
}

/** "Unlock sign-in" for a worker whose PIN is locked for 15 minutes. */
export function UnlockSignInButton({ workerId }: { workerId: string }) {
  const [state, action, pending] = useActionState(unlockSignInAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="workerId" value={workerId} />
      <div>
        <Button type="submit" disabled={pending} className="h-10 rounded-lg">
          {pending ? "Unlocking…" : "Unlock sign-in"}
        </Button>
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
    </form>
  );
}
