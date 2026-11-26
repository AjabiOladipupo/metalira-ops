"use client";

import { useActionState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { NIGERIAN_BANKS } from "@/lib/banks";
import { CONSENT_NOTICES } from "@/lib/messages/consent";
import {
  emailOnboardingLinkAction,
  submitManagerOnboardingAction,
  submitWorkerOnboardingAction,
} from "@/server/people/self-onboarding-public-actions";
import type { OnboardingActionState } from "@/server/people/self-onboarding-state";

const BANK_OPTIONS = [...NIGERIAN_BANKS]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((bank) => ({ value: bank.code, label: bank.name }));

type Values = Partial<Record<string, string>>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-4 border-0 border-t border-line p-0 pt-5">
      <legend className="type-h3 float-left mb-1 w-full">{title}</legend>
      {children}
    </fieldset>
  );
}

function Check({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        name={name}
        value="true"
        defaultChecked={defaultChecked}
        className="mt-0.5 size-5 shrink-0"
      />
      <span>{label}</span>
    </label>
  );
}

/** Who they are: every role. */
function PersonFields({ v, e }: { v: Values; e: Values }) {
  return (
    <>
      <Field label="First name" name="firstName" autoComplete="given-name" required defaultValue={v.firstName ?? ""} error={e.firstName} />
      <Field label="Last name" name="lastName" autoComplete="family-name" required defaultValue={v.lastName ?? ""} error={e.lastName} />
      <Field label="Phone number" name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" required defaultValue={v.phone ?? ""} error={e.phone} />
    </>
  );
}

/** The employee details payroll needs. `required` marks the ones a worker must give. */
function EmployeeFields({ v, e, required }: { v: Values; e: Values; required: boolean }) {
  const optional = required ? "" : " (optional)";
  return (
    <>
      <Section title="About you">
        <Field label={`Date of birth${optional}`} name="dateOfBirth" type="date" defaultValue={v.dateOfBirth ?? ""} error={e.dateOfBirth} />
        <Field label={`Home address${optional}`} name="homeAddress" autoComplete="street-address" defaultValue={v.homeAddress ?? ""} error={e.homeAddress} />
        <Field label={`Emergency contact name${optional}`} name="nextOfKinName" defaultValue={v.nextOfKinName ?? ""} error={e.nextOfKinName} />
        <Field label={`Emergency contact phone${optional}`} name="nextOfKinPhone" type="tel" inputMode="tel" defaultValue={v.nextOfKinPhone ?? ""} error={e.nextOfKinPhone} />
        <Field label="NIN (optional)" name="nin" inputMode="numeric" autoComplete="off" hint="11 digits. Only HR sees it." error={e.nin} />
      </Section>
      <Section title="Where you are paid">
        <SelectField label="Bank (optional)" name="bankCode" options={BANK_OPTIONS} placeholder="Choose your bank" defaultValue={v.bankCode ?? ""} error={e.bankCode} />
        <Field label="Account number" name="bankAccountNumber" inputMode="numeric" autoComplete="off" hint="10 digits. A second person at your company checks it before it is used." error={e.bankAccountNumber} />
        <Field label="Name on the account" name="accountName" defaultValue={v.accountName ?? ""} error={e.accountName} />
      </Section>
      <Section title="Pension and tax">
        <Field label="Pension fund (PFA) (optional)" name="pfaName" defaultValue={v.pfaName ?? ""} error={e.pfaName} />
        <Field label="RSA PIN (optional)" name="rsaPin" autoComplete="off" placeholder="PEN100012344421" error={e.rsaPin} />
        <Field label="State you pay tax in (optional)" name="taxState" defaultValue={v.taxState ?? ""} error={e.taxState} />
        <Check name="nhfOptIn" label="I contribute to the National Housing Fund (NHF)" defaultChecked={v.nhfOptIn === "true"} />
        <Field label="NHF number (optional)" name="nhfNumber" autoComplete="off" error={e.nhfNumber} />
        <Field label="Annual rent you pay, in naira (optional)" name="annualRentDeclared" inputMode="decimal" hint="For rent relief on your tax. HR may ask for proof." defaultValue={v.annualRentDeclared ?? ""} error={e.annualRentDeclared} />
      </Section>
      <Section title="Clock-in">
        <div className="flex flex-col gap-1 text-sm text-fg-muted">
          {CONSENT_NOTICES.location.body.map((line) => (
            <p key={line} className="m-0">{line}</p>
          ))}
        </div>
        <Check name="locationConsent" label={CONSENT_NOTICES.location.agree} defaultChecked={v.locationConsent === "true"} />
        <div className="flex flex-col gap-1 text-sm text-fg-muted">
          {CONSENT_NOTICES.selfie.body.map((line) => (
            <p key={line} className="m-0">{line}</p>
          ))}
        </div>
        <Check name="selfieConsent" label={CONSENT_NOTICES.selfie.agree} defaultChecked={v.selfieConsent === "true"} />
        <p className="m-0 text-xs text-fg-muted">
          If you don&apos;t agree, your supervisor clocks you in instead.
        </p>
      </Section>
    </>
  );
}

function errorsOf(state: OnboardingActionState) {
  const failed = state && !state.ok ? state : null;
  return { v: failed?.values ?? {}, e: failed?.fieldErrors ?? {}, formError: failed?.formError };
}

/** A guard, cleaner or supervisor: everything on one form, no account. */
export function WorkerOnboardForm({ token }: { token: string }) {
  const [state, action] = useActionState(submitWorkerOnboardingAction, null);
  const { v, e, formError } = errorsOf(state);
  return (
    <form action={action} noValidate aria-label="Your details" className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <Field
        label="Your email address"
        name="confirmEmail"
        type="email"
        inputMode="email"
        autoComplete="email"
        hint="The address this invite was sent to."
        required
        defaultValue={v.confirmEmail ?? ""}
        error={e.confirmEmail}
      />
      <PersonFields v={v} e={e} />
      <EmployeeFields v={v} e={e} required />
      <FormAlert message={formError} />
      <SubmitButton pendingLabel="Sending…" size="lg">
        Send my details
      </SubmitButton>
    </form>
  );
}

/** A manager role, first step: an email link to the invited address creates or signs in. */
export function OnboardEmailLinkForm({ token }: { token: string }) {
  const [state, action] = useActionState(emailOnboardingLinkAction, null);
  const { formError } = errorsOf(state);
  return (
    <form action={action} noValidate aria-label="Create your account" className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <p className="m-0 text-sm text-fg-muted">
        We email a link to the address this invite was sent to. Open it on this device to continue.
      </p>
      <FormAlert message={formError} />
      <SubmitButton pendingLabel="Sending…" className="w-auto self-start px-5">
        Email me a link
      </SubmitButton>
    </form>
  );
}

/** A manager role, signed in as the invited address: profile, password, optional employee details. */
export function ManagerOnboardForm({
  token,
  needsPassword,
  onPayroll,
}: {
  token: string;
  needsPassword: boolean;
  onPayroll: boolean;
}) {
  const [state, action] = useActionState(submitManagerOnboardingAction, null);
  const { v, e, formError } = errorsOf(state);
  return (
    <form action={action} noValidate aria-label="Your details" className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <PersonFields v={v} e={e} />
      {needsPassword ? (
        <Field
          label="Choose a password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={72}
          hint="At least 8 characters, with letters and numbers."
          error={e.password}
        />
      ) : null}
      {onPayroll ? <EmployeeFields v={v} e={e} required={false} /> : null}
      <FormAlert message={formError} />
      <SubmitButton pendingLabel="Sending…" size="lg">
        Send my details
      </SubmitButton>
    </form>
  );
}
