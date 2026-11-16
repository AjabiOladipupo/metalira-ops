"use client";

import { useActionState, useState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { PAY_TYPE_LABELS, type PayType } from "@/lib/people";
import { changePayAction } from "@/server/people/actions";

import { PayAmountFields } from "./pay-amount-fields";

const PAY_OPTIONS = Object.entries(PAY_TYPE_LABELS).map(([value, label]) => ({ value, label }));

/**
 * "Change pay": a new dated version from the chosen date. The version in force closes the day
 * before; it is never edited (the database refuses that too).
 */
export function PayChangeForm({
  workerId,
  defaultPayType,
  defaultAmounts,
  defaultFrom,
  minFrom,
}: {
  workerId: string;
  defaultPayType: PayType;
  /** Current amounts in naira as typed, for example "150000.00". */
  defaultAmounts: Partial<Record<string, string>>;
  defaultFrom: string;
  minFrom: string;
}) {
  const [state, action] = useActionState(changePayAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  const [payType, setPayType] = useState<PayType>(
    (typed?.payType as PayType | undefined) ?? defaultPayType,
  );
  const from = typed?.effectiveFrom ?? defaultFrom;

  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label="Change pay"
      className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
    >
      <input type="hidden" name="workerId" value={workerId} />
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-semibold">Change pay</h3>
        <p className="m-0 text-sm text-fg-muted">
          Adds a new version from the date you choose. The current pay stays on record and ends the
          day before.
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4">
        <SelectField
          label="New pay type"
          name="payType"
          options={PAY_OPTIONS}
          value={payType}
          onChange={(event) => setPayType(event.currentTarget.value as PayType)}
          error={errors?.payType}
        />
        <Field
          label="Applies from"
          name="effectiveFrom"
          type="date"
          min={minFrom}
          required
          defaultValue={from}
          error={errors?.effectiveFrom}
        />
      </div>
      <PayAmountFields payType={payType} defaults={typed ?? defaultAmounts} errors={errors} />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save pay change
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
