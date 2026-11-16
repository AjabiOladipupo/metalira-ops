"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  decideBankChangeAction,
  requestBankChangeAction,
  withdrawBankChangeAction,
} from "@/server/people/bank-change-actions";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4";

/**
 * "Change bank details" on an employee. Raises a request; nothing changes until someone other
 * than the requester approves it and the 72-hour hold has passed. The account number is never
 * sent back to the browser after a refusal.
 */
export function BankChangeRequestForm({ workerId }: { workerId: string }) {
  const [state, action] = useActionState(requestBankChangeAction, null);
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
    <form
      key={JSON.stringify(typed ?? null)}
      action={action}
      noValidate
      aria-label="Change bank details"
      className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
    >
      <input type="hidden" name="workerId" value={workerId} />
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-semibold">Change bank details</h3>
        <p className="m-0 text-sm text-fg-muted">
          Someone other than you approves the change. Payouts use the new account 72 hours after
          approval, and the employee is told by email.
        </p>
      </div>
      <div className={GRID}>
        <Field
          label="New bank name"
          name="bankName"
          defaultValue={typed?.bankName ?? ""}
          error={errors?.bankName}
        />
        <Field
          label="New account name"
          name="accountName"
          defaultValue={typed?.accountName ?? ""}
          error={errors?.accountName}
        />
        <Field
          label="New account number"
          name="bankAccountNumber"
          inputMode="numeric"
          autoComplete="off"
          placeholder="10 digits"
          maxLength={14}
          error={errors?.bankAccountNumber}
        />
      </div>
      <Field
        label="Reason"
        name="reason"
        hint="Optional. Shown to the approver, for example “Moved to GTBank, letter on file”."
        maxLength={500}
        defaultValue={typed?.reason ?? ""}
        error={errors?.reason}
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div>
        <SubmitButton pendingLabel="Sending…" className="w-auto px-5">
          Send for approval
        </SubmitButton>
      </div>
    </form>
  );
}

type DecisionKind = "approve" | "reject" | "stop";

const DECISION_LABEL: Record<DecisionKind, string> = {
  approve: "Approve",
  reject: "Reject",
  stop: "Stop this change",
};

/**
 * What a second person can do with a request: approve or reject while it waits, or stop it
 * during the 72-hour hold. The database refuses the requester and the worker themselves, even
 * if these buttons were shown to them.
 */
export function BankChangeDecision({
  changeId,
  decisions,
  label,
}: {
  changeId: string;
  decisions: readonly DecisionKind[];
  /** Names the request for screen readers, for example "Musa Ibrahim's bank change". */
  label: string;
}) {
  const [state, action, pending] = useActionState(decideBankChangeAction, null);

  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }

  return (
    <form action={action} aria-label={label} className="flex flex-col gap-3">
      <input type="hidden" name="changeId" value={changeId} />
      <Field
        label="Note"
        name="note"
        hint="Optional. Kept with the decision."
        maxLength={500}
        className="max-w-md"
      />
      <div className="flex flex-wrap items-center gap-2">
        {decisions.map((decision) => (
          <Button
            key={decision}
            type="submit"
            name="decision"
            value={decision}
            variant={decision === "approve" ? "default" : "outline"}
            disabled={pending}
            className="h-10 rounded-lg"
          >
            {DECISION_LABEL[decision]}
          </Button>
        ))}
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

/** The requester takes back a request nobody has decided yet. */
export function BankChangeWithdraw({ changeId }: { changeId: string }) {
  const [state, action, pending] = useActionState(withdrawBankChangeAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="changeId" value={changeId} />
      <div>
        <Button type="submit" variant="outline" disabled={pending} className="h-10 rounded-lg">
          {pending ? "Withdrawing…" : "Withdraw request"}
        </Button>
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
    </form>
  );
}
