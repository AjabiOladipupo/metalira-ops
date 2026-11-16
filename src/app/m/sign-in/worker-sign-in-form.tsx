"use client";

import { useState } from "react";

import { Field } from "@/components/form";
import { Button } from "@/components/ui/button";

/** Design only: submitting shows a note and makes no network call. */
export function WorkerSignInForm() {
  const [tried, setTried] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
      }}
    >
      <Field
        label="Company code"
        name="companyCode"
        inputSize="lg"
        autoComplete="organization"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="For example ADEBAYO"
      />
      <Field
        label="Staff ID"
        name="staffId"
        inputSize="lg"
        autoComplete="username"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="For example MO-0114"
      />
      <Field
        label="PIN"
        name="pin"
        inputSize="lg"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        minLength={4}
        maxLength={6}
        autoComplete="off"
        hint="4 to 6 digits."
      />
      <Button type="submit" className="h-[52px] w-full rounded-xl text-base">
        Sign in
      </Button>
      {tried ? (
        <p role="status" className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]">
          Phone sign-in arrives with worker invites. Your company will send you a code.
        </p>
      ) : null}
    </form>
  );
}
