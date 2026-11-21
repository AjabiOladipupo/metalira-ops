"use client";

import { useActionState, useId } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  adjustLeaveBalanceAction,
  cancelLeaveAction,
  decideLeaveHrAction,
  decideLeaveLineManagerAction,
} from "@/server/people/leave-request-actions";

function Done({ state }: { state: CompanyFormState }) {
  if (!state?.ok) return null;
  return (
    <p role="status" className="m-0 rounded-lg border border-line px-3 py-2.5 text-sm font-medium">
      {state.message}
    </p>
  );
}

function NoteField({ label, error, hint }: { label: string; error?: string; hint: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name="note"
        rows={2}
        maxLength={500}
        aria-invalid={error ? true : undefined}
        className="min-h-11 rounded-lg border border-line bg-background p-2.5 text-[15px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      />
      <p className={error ? "m-0 text-xs font-medium" : "m-0 text-xs text-fg-muted"}>
        {error ?? hint}
      </p>
    </div>
  );
}

/**
 * Approve or decline one step of a leave request. HR's form sits under the preview of what the
 * approval does (balance before and after, shifts covered). The database checks everything again.
 */
export function DecideLeaveForm({
  step,
  requestId,
  needsCertificate,
  certificateSeen,
}: {
  step: "line_manager" | "hr";
  requestId: string;
  needsCertificate: boolean;
  certificateSeen: boolean;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    step === "line_manager" ? decideLeaveLineManagerAction : decideLeaveHrAction,
    null,
  );
  if (state?.ok) return <Done state={state} />;
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      action={action}
      aria-label={step === "line_manager" ? "Line manager decision" : "HR decision"}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="requestId" value={requestId} />
      {needsCertificate ? (
        <label className="flex min-h-11 items-start gap-3 rounded-lg border border-line px-3 py-2.5">
          <input
            type="checkbox"
            name="certificateSeen"
            defaultChecked={certificateSeen}
            disabled={certificateSeen}
            className="mt-0.5 size-4 shrink-0 accent-[var(--signal)]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Certificate seen</span>
            <span className="text-xs text-fg-muted">
              {certificateSeen
                ? "Ticked at the earlier step."
                : step === "hr"
                  ? "Needed before HR approves."
                  : "Tick it if the worker showed you the certificate."}
            </span>
          </span>
        </label>
      ) : null}
      <NoteField
        label="Note to the worker"
        error={errors?.note}
        hint="Optional when approving; needed when declining."
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButtonNamed value="approved" pendingLabel="Saving…">
          {step === "line_manager" ? "Approve, send to HR" : "Approve"}
        </SubmitButtonNamed>
        <SubmitButtonNamed value="declined" pendingLabel="Saving…" outline>
          Decline
        </SubmitButtonNamed>
      </div>
    </form>
  );
}

/** A submit button that sends `decision` with its value. */
function SubmitButtonNamed({
  value,
  children,
  outline = false,
}: {
  value: "approved" | "declined";
  children: React.ReactNode;
  pendingLabel: string;
  outline?: boolean;
}) {
  return (
    <button
      type="submit"
      name="decision"
      value={value}
      className={
        outline
          ? "h-11 rounded-lg border border-line bg-background px-5 text-sm font-medium text-foreground hover:bg-surface"
          : "h-11 rounded-lg border border-foreground bg-foreground px-5 text-sm font-semibold text-background hover:opacity-90"
      }
    >
      {children}
    </button>
  );
}

/** HR cancels a live request with a reason; approved leave gives its days back. */
export function CancelLeaveForm({ requestId, approved }: { requestId: string; approved: boolean }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(cancelLeaveAction, null);
  if (state?.ok) return <Done state={state} />;
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={action} aria-label="Cancel leave" className="flex flex-col gap-3">
      <input type="hidden" name="requestId" value={requestId} />
      <Field
        label="Reason"
        name="reason"
        required
        maxLength={500}
        hint={approved ? "The days go back into the worker's balance." : "The worker is told why."}
        error={errors?.reason}
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton pendingLabel="Cancelling…" className="sm:w-auto sm:self-start sm:px-5">
        Cancel leave
      </SubmitButton>
    </form>
  );
}

/** HR adds or takes away days for one worker and type this year, with a reason. */
export function AdjustBalanceForm({
  workerId,
  year,
  types,
}: {
  workerId: string;
  year: number;
  types: { id: string; name: string }[];
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(adjustLeaveBalanceAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={action} aria-label="Adjust balance" className="flex flex-col gap-3">
      <input type="hidden" name="workerId" value={workerId} />
      <input type="hidden" name="year" value={year} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-3">
        <SelectField
          label="Leave type"
          name="leaveTypeId"
          options={types.map((t) => ({ value: t.id, label: t.name }))}
          error={errors?.leaveTypeId}
        />
        <Field
          label="Days"
          name="days"
          inputMode="numeric"
          required
          hint="2 adds two days; -1 takes one away"
          error={errors?.days}
        />
        <Field label="Reason" name="reason" required maxLength={500} error={errors?.reason} />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <Done state={state} />
      <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start sm:px-5">
        Save adjustment
      </SubmitButton>
    </form>
  );
}
