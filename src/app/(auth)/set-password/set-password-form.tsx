"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { setPasswordAction } from "@/server/identity/password-actions";

/** Choose a password after an email link (slice 1.13). */
export function SetPasswordForm({
  next,
  company,
}: {
  next: string;
  /** For a new company's owner: their name and company name, prefilled from sign-up. */
  company: { fullName: string; companyName: string } | null;
}) {
  const [state, action] = useActionState(setPasswordAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate aria-label="Set your password">
      <input type="hidden" name="next" value={next} />
      {company ? (
        <>
          <input type="hidden" name="withCompany" value="1" />
          <Field
            label="Your full name"
            name="fullName"
            autoComplete="name"
            required
            defaultValue={state?.values?.fullName ?? company.fullName}
            error={state?.fieldErrors?.fullName}
          />
          <Field
            label="Company name"
            name="companyName"
            autoComplete="organization"
            required
            hint="Check it: this is the company your account will own."
            defaultValue={state?.values?.companyName ?? company.companyName}
            error={state?.fieldErrors?.companyName}
          />
        </>
      ) : null}
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
