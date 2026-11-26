"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  isManagerOnboardingRole,
  isOnboardingRole,
  ONBOARDING_ROLE_HINTS,
  ONBOARDING_ROLE_LABELS,
  type OnboardingRole,
} from "@/lib/self-onboarding";
import {
  cancelOnboardingInviteAction,
  inviteToOnboardAction,
  resendOnboardingInviteAction,
} from "@/server/people/self-onboarding-actions";
import type { OnboardingActionState } from "@/server/people/self-onboarding-state";

type Option = { value: string; label: string };

function Outcome({ state }: { state: OnboardingActionState }) {
  if (!state) return null;
  if (!state.ok) return <FormAlert message={state.formError ?? "That was not saved."} />;
  return (
    <p role="status" className="m-0 text-sm text-fg-muted">
      {state.message}
    </p>
  );
}

function ShareLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium" htmlFor="onboarding-invite-link">
        Invite link
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="onboarding-invite-link"
          readOnly
          value={link}
          data-testid="onboarding-invite-link"
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 min-w-0 flex-[1_1_240px] rounded-lg border border-line bg-background px-3 font-mono text-[13px]"
        />
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-lg"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </div>
  );
}

/** Invite by email with one role. The invitee can never change it. */
export function OnboardInviteForm({
  departments,
  lineManagers,
  emailsLeft,
  emailCap,
  roles,
}: {
  departments: Option[];
  lineManagers: Option[];
  emailsLeft: number;
  emailCap: number;
  /** The roles this caller may offer (owner: all; HR: worker roles). */
  roles: readonly OnboardingRole[];
}) {
  const [state, action] = useActionState(inviteToOnboardAction, null);
  const failed = state && !state.ok ? state : null;
  const [role, setRole] = useState<string>(failed?.values?.role ?? "guard");
  const manager = isOnboardingRole(role) && isManagerOnboardingRole(role);
  return (
    <form
      key={state?.ok ? state.message : "invite"}
      action={action}
      noValidate
      aria-label="Invite to onboard"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 type-h3">Invite to onboard</h2>
        <span className="text-[13px] text-fg-muted" data-testid="emails-left">
          {emailsLeft} of {emailCap} emails left today
        </span>
      </div>
      <p className="m-0 text-sm text-fg-muted">
        They get an email link, fill in their own details for this role and send them to you. The
        role is fixed: they can&apos;t change it. Nothing starts until you approve.
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-start gap-4">
        <Field
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="musa@example.com"
          required
          defaultValue={failed?.values?.email ?? ""}
          error={failed?.fieldErrors?.email}
        />
        <SelectField
          label="Role"
          name="role"
          options={roles.map((r) => ({ value: r, label: ONBOARDING_ROLE_LABELS[r] }))}
          value={role}
          onChange={(e) => setRole(e.currentTarget.value)}
          hint={isOnboardingRole(role) ? ONBOARDING_ROLE_HINTS[role] : undefined}
          error={failed?.fieldErrors?.role}
        />
        <SelectField
          label="Department (optional)"
          name="departmentId"
          options={departments}
          placeholder="None"
          defaultValue={failed?.values?.departmentId ?? ""}
          error={failed?.fieldErrors?.departmentId}
        />
        <SelectField
          label="Line manager (optional)"
          name="lineManager"
          options={lineManagers}
          placeholder="None"
          defaultValue={failed?.values?.lineManager ?? ""}
          error={failed?.fieldErrors?.lineManagerWorkerId}
        />
      </div>
      {manager ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="onPayroll"
            value="true"
            defaultChecked={failed?.values?.onPayroll === "true"}
            className="mt-0.5 size-4"
          />
          <span>Also paid through payroll (they can add employee details too)</span>
        </label>
      ) : null}
      <FormAlert message={failed?.formError} />
      {emailsLeft === 0 ? (
        <p className="m-0 text-sm font-medium">
          Today&apos;s email limit is reached. An invite made now is saved but not emailed until you
          resend it tomorrow.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Sending…" className="w-auto px-5">
          Send invite
        </SubmitButton>
        {state?.ok ? (
          <p role="status" className="m-0 text-sm text-fg-muted">
            {state.message}
          </p>
        ) : null}
      </div>
      {state?.ok && state.link ? <ShareLink link={state.link} /> : null}
    </form>
  );
}

function RowButton({ children, pending }: { children: React.ReactNode; pending: string }) {
  const status = useFormStatus();
  return (
    <Button
      type="submit"
      variant="outline"
      className="h-9 rounded-lg px-3 text-sm"
      disabled={status.pending}
    >
      {status.pending ? pending : children}
    </Button>
  );
}

/** Resend and Cancel on one invite. */
export function InviteRowActions({
  inviteId,
  canResend,
  canCancel,
}: {
  inviteId: string;
  canResend: boolean;
  canCancel: boolean;
}) {
  const [resent, resend] = useActionState(resendOnboardingInviteAction, null);
  const [cancelled, cancel] = useActionState(cancelOnboardingInviteAction, null);
  if (!canResend && !canCancel && !resent && !cancelled) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {canResend ? (
          <form action={resend}>
            <input type="hidden" name="inviteId" value={inviteId} />
            <RowButton pending="Sending…">Resend</RowButton>
          </form>
        ) : null}
        {canCancel ? (
          <form action={cancel}>
            <input type="hidden" name="inviteId" value={inviteId} />
            <RowButton pending="Cancelling…">Cancel</RowButton>
          </form>
        ) : null}
      </div>
      <Outcome state={resent} />
      {resent?.ok && resent.link ? <ShareLink link={resent.link} /> : null}
      <Outcome state={cancelled} />
    </div>
  );
}
