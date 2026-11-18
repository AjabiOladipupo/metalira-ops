"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { setPasswordAction } from "@/server/identity/password-actions";

/** Choose a password after an email link (slice 1.13). */
export function SetPasswordForm({ next }: { next: string }) {
  const [state, action] = useActionState(setPasswordAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate aria-label="Set your password">
      <input type="hidden" name="next" value={next} />
      <Field
        label="Choose a password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={72}
        hint="At least 8 characters, with letters and numbers. You sign in with it from now on."
        error={state?.fieldErrors?.password}
      />
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Saving…">Save password</SubmitButton>
    </form>
  );
}
