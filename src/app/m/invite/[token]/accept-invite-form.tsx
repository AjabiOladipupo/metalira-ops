"use client";

import { useActionState, useId } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { workerMessages } from "@/lib/messages/worker";
import { acceptWorkerInvite } from "@/server/identity/worker-actions";

const copy = workerMessages.invite;

/** New PIN twice, the notice and its tick box. The PINs are never echoed back on an error. */
export function AcceptInviteForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptWorkerInvite, null);
  const noticeId = useId();
  const noticeError = state?.fieldErrors?.notice;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <Field
        label={copy.pin}
        name="pin"
        inputSize="lg"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        minLength={6}
        maxLength={6}
        autoComplete="new-password"
        required
        hint={copy.pinHint}
        error={state?.fieldErrors?.pin}
      />
      <Field
        label={copy.pinConfirm}
        name="pinConfirm"
        inputSize="lg"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        minLength={6}
        maxLength={6}
        autoComplete="new-password"
        required
        error={state?.fieldErrors?.pinConfirm}
      />
      <section
        aria-labelledby={`${noticeId}-title`}
        className="flex flex-col gap-2 rounded-xl border border-line p-4"
      >
        <h2 id={`${noticeId}-title`} className="m-0 text-[15px] font-semibold">
          {copy.noticeTitle}
        </h2>
        <p className="m-0 text-sm text-fg-muted">{copy.notice}</p>
        <label className="flex min-h-11 items-start gap-3 pt-1 text-[15px]">
          <input
            type="checkbox"
            name="notice"
            value="yes"
            required
            aria-invalid={noticeError ? true : undefined}
            aria-describedby={noticeError ? `${noticeId}-error` : undefined}
            className="mt-1 size-5 shrink-0 accent-[var(--fg)]"
          />
          <span>{copy.noticeAgree}</span>
        </label>
        {noticeError ? (
          <p id={`${noticeId}-error`} className="m-0 text-xs font-medium">
            {noticeError}
          </p>
        ) : null}
      </section>
      <FormAlert message={state?.formError} />
      <SubmitButton size="lg" pendingLabel={copy.pending}>
        {copy.submit}
      </SubmitButton>
    </form>
  );
}
