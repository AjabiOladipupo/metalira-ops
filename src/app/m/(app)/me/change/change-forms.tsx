"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { workerMessages } from "@/lib/messages/worker";
import { cn } from "@/lib/utils";
import { CHANGE_REQUEST_MAX, REQUEST_CHOICES, type RequestChoice } from "@/lib/worker-requests";
import {
  requestOwnBankChangeAction,
  requestOwnChangeAction,
} from "@/server/people/own-request-actions";

const copy = workerMessages.change;

function Sent({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px] font-semibold">
        {message}
      </p>
      <Link
        href="/m/me"
        className="flex h-[52px] items-center justify-center rounded-xl border border-foreground text-base font-semibold text-foreground no-underline hover:text-foreground"
      >
        {copy.back}
      </Link>
    </div>
  );
}

/** New bank details: a request HR approves, then 72 hours before pay goes there. */
function BankForm() {
  const [state, action] = useActionState(requestOwnBankChangeAction, null);
  if (state?.ok && state.message) return <Sent message={state.message} />;
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  return (
    <form
      key={JSON.stringify(typed ?? null)}
      action={action}
      noValidate
      aria-label={copy.topics.bank}
      className="flex flex-col gap-4"
    >
      <p className="m-0 text-[15px]">{workerMessages.me.bankNote}</p>
      <Field
        label={copy.bankName}
        name="bankName"
        inputSize="lg"
        hint={copy.bankNameHint}
        maxLength={200}
        defaultValue={typed?.bankName ?? ""}
        error={errors?.bankName}
      />
      <Field
        label={copy.accountName}
        name="accountName"
        inputSize="lg"
        hint={copy.accountNameHint}
        maxLength={200}
        autoComplete="off"
        defaultValue={typed?.accountName ?? ""}
        error={errors?.accountName}
      />
      <Field
        label={copy.accountNumber}
        name="bankAccountNumber"
        inputSize="lg"
        inputMode="numeric"
        autoComplete="off"
        hint={copy.accountNumberHint}
        maxLength={14}
        error={errors?.bankAccountNumber}
      />
      <Field
        label={copy.reason}
        name="reason"
        inputSize="lg"
        hint={copy.reasonHint}
        maxLength={500}
        defaultValue={typed?.reason ?? ""}
        error={errors?.reason}
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton size="lg" pendingLabel={copy.pending}>
        {copy.bankSubmit}
      </SubmitButton>
    </form>
  );
}

/** Anything else: the worker's own words, for HR to act on. */
function RequestForm({ topic }: { topic: Exclude<RequestChoice, "bank"> }) {
  const [state, action] = useActionState(requestOwnChangeAction, null);
  const id = useId();
  if (state?.ok && state.message) return <Sent message={state.message} />;
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  const error = errors?.details ?? errors?.topic;
  return (
    <form
      key={JSON.stringify(typed ?? null)}
      action={action}
      noValidate
      aria-label={copy.topics[topic]}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="topic" value={topic} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[13px] font-medium">
          {copy.details}
        </label>
        <textarea
          id={id}
          name="details"
          rows={5}
          maxLength={CHANGE_REQUEST_MAX}
          defaultValue={typed?.details ?? ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-note`}
          className="min-h-32 w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-foreground"
        />
        <p
          id={`${id}-note`}
          className={cn("m-0 text-xs", error ? "font-medium text-foreground" : "text-fg-muted")}
        >
          {error ?? copy.detailsHint}
        </p>
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton size="lg" pendingLabel={copy.pending}>
        {copy.submit}
      </SubmitButton>
    </form>
  );
}

/**
 * "Request a change": the worker picks what to change, then fills the bank form (a
 * two-person bank-detail change) or describes the change for HR.
 */
export function ChangeForms({ bankOpen }: { bankOpen: boolean }) {
  const [choice, setChoice] = useState<RequestChoice | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-[15px] font-semibold">{copy.topic}</legend>
        {REQUEST_CHOICES.map((value) => {
          const disabled = value === "bank" && bankOpen;
          return (
            <label
              key={value}
              className={cn(
                "flex min-h-[52px] items-center gap-3 rounded-xl border px-4 py-3 text-[15px]",
                choice === value ? "border-foreground" : "border-line",
                disabled ? "cursor-not-allowed text-fg-muted" : "cursor-pointer",
              )}
            >
              <input
                type="radio"
                name="choice"
                value={value}
                checked={choice === value}
                disabled={disabled}
                onChange={() => setChoice(value)}
                className="size-5 accent-foreground"
              />
              <span className="flex flex-col">
                <span>{copy.topics[value]}</span>
                {disabled ? <span className="text-xs">{copy.bankWaiting}</span> : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      {choice === "bank" ? <BankForm /> : null}
      {choice && choice !== "bank" ? <RequestForm key={choice} topic={choice} /> : null}
    </div>
  );
}
