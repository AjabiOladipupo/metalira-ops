"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { acceptTeamInviteAction, signUpForInviteAction } from "@/server/identity/team-actions";

/**
 * Accept the invite as the signed-in user. After an email link (`needsPassword`), they choose
 * their password here first (slice 1.13).
 */
export function AcceptForm({
  token,
  organisationName,
  role,
  needsPassword,
}: {
  token: string;
  organisationName: string;
  role: string;
  needsPassword: boolean;
}) {
  const [state, action] = useActionState(acceptTeamInviteAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" aria-label="Accept the invite" noValidate>
      <input type="hidden" name="token" value={token} />
      <p className="m-0 text-sm text-fg-muted">
        You will join {organisationName} as {role}. You can belong to more than one company and
        switch between them from the top bar.
      </p>
      {needsPassword ? (
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
      ) : null}
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Joining…" className="w-auto self-start px-5">
        {needsPassword ? "Set password and join" : "Accept and join"}
      </SubmitButton>
    </form>
  );
}

/**
 * Start an account for the invited address (the address is fixed by the invite). No password
 * here: it is chosen after the email is confirmed (slice 1.13).
 */
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
      <p className="m-0 text-sm text-fg-muted">
        We email {email} a link to confirm it. You choose your password after opening it.
      </p>
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Sending…">Email me a link</SubmitButton>
    </form>
  );
}
