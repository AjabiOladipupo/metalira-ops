"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { workerMessages } from "@/lib/messages/worker";
import { signInWorker } from "@/server/identity/worker-actions";

const copy = workerMessages.signIn;

/** After setting a PIN where the session could not be opened, the invite sends the worker here. */
function PinSetNote() {
  const pinSet = useSearchParams().get("pin") === "set";
  return pinSet ? (
    <p role="status" className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]">
      {copy.pinSet}
    </p>
  ) : null;
}

/** Company code, staff ID and 6-digit PIN. Errors never say which of the three was wrong. */
export function WorkerSignInForm() {
  const [state, action] = useActionState(signInWorker, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Suspense fallback={null}>
        <PinSetNote />
      </Suspense>
      <Field
        label={copy.companyCode}
        name="companyCode"
        inputSize="lg"
        autoComplete="organization"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder={copy.companyCodePlaceholder}
        required
        maxLength={64}
        defaultValue={state?.values?.companyCode}
        error={state?.fieldErrors?.companyCode}
      />
      <Field
        label={copy.staffId}
        name="staffId"
        inputSize="lg"
        autoComplete="username"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder={copy.staffIdPlaceholder}
        required
        maxLength={64}
        defaultValue={state?.values?.staffId}
        error={state?.fieldErrors?.staffId}
      />
      <Field
        label={copy.pin}
        name="pin"
        inputSize="lg"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        minLength={6}
        maxLength={6}
        autoComplete="current-password"
        required
        hint={copy.pinHint}
        error={state?.fieldErrors?.pin}
      />
      <FormAlert message={state?.formError} />
      <SubmitButton size="lg" pendingLabel={copy.pending}>
        {copy.submit}
      </SubmitButton>
    </form>
  );
}
