"use client";

import { useActionState, useMemo, useState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { planEndContract, type ActivationCode } from "@/lib/activation";
import { activateContractAction, endContractAction } from "@/server/business/activation-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

/**
 * The confirm steps for activating and ending a contract (slice 2.7). The checklist and preview
 * are worked out on the server (`planActivation`); the database checks everything again inside
 * the activation and refuses with the same list, which shows here when it does.
 */

const CODE_ORDER: readonly ActivationCode[] = [
  "MLCT1",
  "MLCT2",
  "MLCT3",
  "MLCT8",
  "MLCT4",
  "MLCT5",
  "MLCT9",
  "MLCT6",
  "MLCT7",
];

export function ActivateContractForm({
  clientId,
  contractId,
  goLiveDate,
  ready,
  summary,
}: {
  clientId: string;
  contractId: string;
  goLiveDate: string;
  ready: boolean;
  summary: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(activateContractAction, null);
  const refused = state && !state.ok ? state : null;
  const dbIssues = refused?.fieldErrors
    ? CODE_ORDER.flatMap((code) => {
        const message = refused.fieldErrors?.[code];
        return message ? [message] : [];
      })
    : [];
  return (
    <form
      action={action}
      aria-label="Activate contract"
      className="flex flex-col gap-4 rounded-xl border border-line p-4"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="goLiveDate" value={goLiveDate} />
      <p className="m-0 text-[15px] font-medium" data-testid="activation-summary">
        {summary}
      </p>
      <label className="flex min-h-11 items-center gap-3 text-[15px]">
        <input
          type="checkbox"
          name="sendWelcome"
          defaultChecked
          className="size-4 accent-[var(--fg)]"
        />
        Send a welcome email to the client&apos;s ops and billing contacts
      </label>
      <FormAlert message={refused?.formError} />
      {dbIssues.length > 0 ? (
        <ul
          className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm"
          data-testid="activation-refusal"
        >
          {dbIssues.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {ready ? (
        <SubmitButton pendingLabel="Activating…">Activate contract</SubmitButton>
      ) : (
        <p className="m-0 text-sm text-fg-muted">
          Fix the items above, then come back to activate.
        </p>
      )}
    </form>
  );
}

export function EndContractForm({
  clientId,
  contractId,
  today,
  goLiveDate,
  endDate,
  openPosts,
}: {
  clientId: string;
  contractId: string;
  today: string;
  goLiveDate: string | null;
  endDate: string | null;
  openPosts: number;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(endContractAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const [endOn, setEndOn] = useState(state?.values?.endDate ?? endDate ?? today);
  const plan = useMemo(
    () =>
      /^\d{4}-\d{2}-\d{2}$/.test(endOn)
        ? planEndContract({
            status: "active",
            goLiveDate,
            endDate,
            endReason: null,
            today,
            endOn,
            openPosts,
          })
        : null,
    [endOn, goLiveDate, endDate, today, openPosts],
  );
  return (
    <form
      action={action}
      aria-label="End contract"
      className="flex flex-col gap-4 rounded-xl border border-line p-4"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contractId} />
      <Field
        label="Last day of service"
        name="endDate"
        type="date"
        min={today}
        max={endDate ?? undefined}
        value={endOn}
        onChange={(e) => setEndOn(e.target.value)}
        error={errors?.endDate}
        required
      />
      <Field
        label="Reason"
        name="reason"
        maxLength={500}
        defaultValue={state?.values?.reason ?? ""}
        hint="For example: client gave notice on 1 Nov."
        error={errors?.reason}
        required
      />
      {plan ? (
        <p className="m-0 text-sm" data-testid="end-preview">
          {plan.ok ? plan.summary : plan.reason}
        </p>
      ) : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton pendingLabel="Ending…">End contract</SubmitButton>
    </form>
  );
}
