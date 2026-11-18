"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { signUp } from "@/server/identity/actions";

export function SignUpForm() {
  const [state, action] = useActionState(signUp, null);
  const errors = state?.fieldErrors;
  const values = state?.values;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Field
        label="Your full name"
        name="fullName"
        autoComplete="name"
        required
        defaultValue={values?.fullName}
        error={errors?.fullName}
      />
      <Field
        label="Company name"
        name="companyName"
        autoComplete="organization"
        required
        hint="As your staff and clients know it. You can add the registered name later."
        defaultValue={values?.companyName}
        error={errors?.companyName}
      />
      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        defaultValue={values?.email}
        error={errors?.email}
      />
      <p className="m-0 text-sm text-fg-muted">
        We email you a link to confirm your address. You choose your password after opening it.
      </p>
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Sending…">Create account</SubmitButton>
    </form>
  );
}
