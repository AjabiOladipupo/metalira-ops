"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sendMagicLink, signInWithPassword } from "@/server/identity/actions";

/** Carries ?next= through the form so the user lands where they were going. */
function NextInput() {
  const next = useSearchParams().get("next");
  return next ? <input type="hidden" name="next" value={next} /> : null;
}

function LinkError() {
  const error = useSearchParams().get("error");
  return (
    <FormAlert
      message={
        error === "link"
          ? "That link has expired or was already used. Sign in below or ask for a new link."
          : undefined
      }
    />
  );
}

function PasswordForm() {
  const [state, action] = useActionState(signInWithPassword, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Suspense fallback={null}>
        <NextInput />
      </Suspense>
      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        defaultValue={state?.values?.email}
        error={state?.fieldErrors?.email}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={state?.fieldErrors?.password}
      />
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}

function MagicLinkForm() {
  const [state, action] = useActionState(sendMagicLink, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Suspense fallback={null}>
        <NextInput />
      </Suspense>
      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        hint="We email you a link that signs you in. It works once and expires in 1 hour."
        defaultValue={state?.values?.email}
        error={state?.fieldErrors?.email}
      />
      <FormAlert message={state?.formError} />
      <SubmitButton pendingLabel="Sending…">Send link</SubmitButton>
    </form>
  );
}

export function SignInForm() {
  return (
    <div className="flex flex-col gap-5">
      <Suspense fallback={null}>
        <LinkError />
      </Suspense>
      <Tabs defaultValue="password">
        <TabsList aria-label="Sign-in method">
          <TabsTrigger value="password">Password</TabsTrigger>
          <TabsTrigger value="link">Email link</TabsTrigger>
        </TabsList>
        <TabsContent value="password">
          <PasswordForm />
        </TabsContent>
        <TabsContent value="link">
          <MagicLinkForm />
        </TabsContent>
      </Tabs>
    </div>
  );
}
