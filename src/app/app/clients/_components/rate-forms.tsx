"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  addWhtRateAction,
  cancelRateCardVersionAction,
  cancelWhtRateAction,
} from "@/server/business/contract-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

/** Cancels a scheduled rate card or WHT version (one that hasn't started); the one before reopens. */
export function CancelVersionButton({
  kind,
  id,
  clientId,
  label,
}: {
  kind: "rate_card" | "wht";
  id: string;
  clientId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<CompanyFormState, FormData>(
    kind === "rate_card" ? cancelRateCardVersionAction : cancelWhtRateAction,
    null,
  );
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name={kind === "rate_card" ? "rateCardId" : "whtRateId"} value={id} />
      <input type="hidden" name="clientId" value={clientId} />
      <Button
        type="submit"
        variant="link"
        size="sm"
        disabled={pending}
        aria-label={label}
        className="px-0 text-sm"
      >
        {pending ? "Cancelling…" : "Cancel"}
      </Button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs font-medium">
          {state.formError}
        </span>
      ) : null}
    </form>
  );
}

/** "Change WHT rate from": a new dated rate; the current one ends the day before. */
export function WhtRateForm({
  clientId,
  contractId,
  defaultFrom,
  minFrom,
  hasRate,
}: {
  clientId: string;
  contractId: string;
  defaultFrom: string;
  minFrom: string;
  hasRate: boolean;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(addWhtRateAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label={hasRate ? "Change WHT rate" : "Set WHT rate"}
      className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contractId} />
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-semibold">
          {hasRate ? "Change WHT rate from" : "Set the WHT rate"}
        </h3>
        <p className="m-0 text-sm text-fg-muted">
          The rate the client withholds from payments on this contract.
          {hasRate ? " The current rate stays on record and ends the day before." : ""}
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4">
        <Field
          label="WHT rate (%)"
          name="rate"
          inputMode="decimal"
          placeholder="5"
          defaultValue={typed?.rate ?? ""}
          error={errors?.rate}
        />
        <Field
          label="From"
          name="effectiveFrom"
          type="date"
          min={minFrom}
          defaultValue={typed?.effectiveFrom ?? defaultFrom}
          error={errors?.effectiveFrom}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save WHT rate
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
