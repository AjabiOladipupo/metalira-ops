"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useState, useTransition } from "react";

import {
  BankAccountFields,
  BankPicker,
  type BankLookupResult,
  type BankLookupState,
} from "@/components/bank-account-fields";
import { Field, FormAlert, SubmitButton } from "@/components/form";
import { NameCheckStatus, TestLookupBadge } from "@/components/name-check";
import { Button } from "@/components/ui/button";
import {
  checkWorkerBankDetailsAction,
  decideBankChangeAction,
  lookupWorkerBankAccountAction,
  requestBankChangeAction,
  withdrawBankChangeAction,
} from "@/server/people/bank-change-actions";

/**
 * "Change bank details" on an employee. Raises a request; nothing changes until someone other
 * than the requester approves it and the 72-hour hold has passed. The account number is never
 * sent back to the browser after a refusal.
 */
export function BankChangeRequestForm({ workerId }: { workerId: string }) {
  const [state, action] = useActionState(requestBankChangeAction, null);
  const [lookup, setLookup] = useState<BankLookupState>({ status: "idle" });
  const sendable =
    lookup.status === "done" && lookup.result.result !== "no_match" && !lookup.result.blocked;
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
      <BankAccountFields
        lookup={(input) => lookupWorkerBankAccountAction({ ...input, workerId })}
        labelPrefix="New "
        defaultBankCode={typed?.bankCode ?? ""}
        defaultReason={typed?.nameCheckReason ?? ""}
        errors={errors}
        onStateChange={setLookup}
        whose="the employee's"
      />
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
        <SubmitButton pendingLabel="Sending…" className="w-auto px-5" disabled={!sendable}>
          Send for approval
        </SubmitButton>
      </div>
    </form>
  );
}

/**
 * "Check bank details" on the person page (slice 2.3b): looks the bank details on file up with
 * the bank, for details that were never checked (imports). The bank is pre-selected from the
 * saved bank name when it names one bank; the person confirms or changes it.
 */
export function CheckBankDetails({
  workerId,
  defaultBankCode,
  bankFixed = false,
}: {
  workerId: string;
  defaultBankCode: string;
  /** The bank's code is on file: the check uses it, and the picker isn't shown. */
  bankFixed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [bankCode, setBankCode] = useState(defaultBankCode);
  const [result, setResult] = useState<BankLookupResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="outline"
          className="h-10 rounded-lg"
          onClick={() => setOpen(true)}
        >
          Check bank details
        </Button>
      </div>
    );
  }

  function check() {
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await checkWorkerBankDetailsAction({ workerId, bankCode }));
      } catch {
        setResult({
          ok: false,
          message: "The account couldn't be checked. Try again in a minute.",
        });
      }
    });
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-line p-4"
      data-testid="check-bank-details"
    >
      <p className="m-0 text-sm text-fg-muted">
        Asks the bank for the name on the account on file and compares it with the employee&apos;s
        name. Nothing changes on the record except the check.
      </p>
      <div className={bankFixed ? "hidden" : "max-w-sm"}>
        <BankPicker
          label="Bank"
          name="checkBankCode"
          value={bankCode}
          onChange={(code) => {
            setBankCode(code);
            setResult(null);
          }}
          hint={
            defaultBankCode
              ? "Chosen from the saved bank name. Change it if it's wrong."
              : undefined
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={check}
          disabled={!bankCode || pending}
          className="h-10 rounded-lg"
        >
          {pending ? "Checking…" : "Check with the bank"}
        </Button>
        {pending ? (
          <span role="status" className="inline-flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden />
            Asking the bank…
          </span>
        ) : null}
      </div>
      <div aria-live="polite">
        {result && !result.ok ? (
          <p className="m-0 text-sm font-medium" role="alert">
            {result.message}
          </p>
        ) : null}
        {result?.ok ? (
          <div className="flex flex-col gap-1" data-testid="bank-check-result">
            <span className="type-label text-fg-muted">Account name from the bank</span>
            <span className="text-[15px] font-semibold break-words">{result.accountName}</span>
            <span className="flex flex-wrap items-center gap-3">
              <NameCheckStatus status={result.result} />
              {result.test ? <TestLookupBadge /> : null}
              {result.result !== "match" ? (
                <span className="text-sm text-fg-muted">Expected: {result.expected}</span>
              ) : null}
            </span>
            {result.result === "no_match" ? (
              <p className="m-0 text-sm">
                This account isn&apos;t in the employee&apos;s name. Raise a bank change with their
                own account before the next payroll.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
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
  unchecked = false,
}: {
  changeId: string;
  decisions: readonly DecisionKind[];
  /** Names the request for screen readers, for example "Musa Ibrahim's bank change". */
  label: string;
  /** The bank never checked the account name: approving needs a note saying how it was confirmed. */
  unchecked?: boolean;
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
        label={unchecked ? "How you confirmed this account" : "Note"}
        name="note"
        hint={
          unchecked
            ? "Needed to approve an account the bank didn't check, for example “Bank letter dated 3 Nov seen”. Kept with the decision."
            : "Optional. Kept with the decision."
        }
        error={state && !state.ok ? state.fieldErrors?.note : undefined}
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
