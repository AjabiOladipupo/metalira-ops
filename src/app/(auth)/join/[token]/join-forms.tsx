"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { acceptTeamInviteAction, signUpForInviteAction } from "@/server/identity/team-actions";

/** Accept the invite as the signed-in user. */
export function AcceptForm({
  token,
  organisationName,
  role,
}: {
  token: string;
  organisationName: string;
  role: string;
}) {
  const [state, action] = useActionState(acceptTeamInviteAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" aria-label="Accept the invite">
      <input type="hidden" name="token" value={token} />
      <p className="m-0 text-sm text-fg-muted">
        You will join {organisationName} as {role}. You can belong to more than one company and
        switch between them from the top bar.
      </p>
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Joining…" className="w-auto self-start px-5">
        Accept and join
      </SubmitButton>
    </form>
  );
}

/** Create an account for the invited address (the address is fixed by the invite). */
export function JoinSignUpForm({ token, email }: { token: string; email: string }) {
  const [state, action] = useActionState(signUpForInviteAction, null);
  const errors = state?.fieldErrors;
  return (
    <form
      action={action}
      className="flex flex-col gap-4"
      noValidate
      aria-label="Create your account"
    >
      <input type="hidden" name="token" value={token} />
      <Field
        label="Work email"
        name="emailShown"
        value={email}
        readOnly
        disabled
        hint="Set by the invite."
      />
      <Field
        label="Your full name"
        name="fullName"
        autoComplete="name"
        required
        defaultValue={state?.values?.fullName}
        error={errors?.fullName}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={72}
        hint="At least 8 characters, with letters and numbers."
        error={errors?.password}
      />
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
    </form>
  );
}
