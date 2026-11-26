"use client";

import { useActionState, useState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { EMPLOYMENT_TYPE_LABELS, PAY_TYPE_LABELS } from "@/lib/people";
import { approveOnboardingAction } from "@/server/people/self-onboarding-actions";

const EMPLOYMENT_OPTIONS = Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const PAY_OPTIONS = Object.entries(PAY_TYPE_LABELS).map(([value, label]) => ({ value, label }));

/**
 * Approve what the invitee sent. For an employee: staff ID, start date, employment type and
 * (owner or HR) the first pay rate. The role is the invite's and isn't on this form.
 */
export function ApproveOnboardingForm({
  inviteId,
  onPayroll,
  canSetPay,
  today,
  hasBank,
}: {
  inviteId: string;
  onPayroll: boolean;
  canSetPay: boolean;
  today: string;
  hasBank: boolean;
}) {
  const [state, action] = useActionState(approveOnboardingAction, null);
  const failed = state && !state.ok ? state : null;
  const v = failed?.values ?? {};
  const e = failed?.fieldErrors ?? {};
  const [payType, setPayType] = useState<string>(v.payType ?? "");

  if (state?.ok) {
    return (
      <p role="status" className="m-0 rounded-xl bg-surface p-4 text-sm sm:p-5">
        {state.message}
      </p>
    );
  }

  return (
    <form
      action={action}
      noValidate
      aria-label="Approve"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <input type="hidden" name="inviteId" value={inviteId} />
      <h2 className="m-0 type-h3">Approve</h2>
      {onPayroll ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4">
            <Field
              label="Staff ID (optional)"
              name="staffId"
              hint="Blank gives the next free ID."
              defaultValue={v.staffId ?? ""}
              error={e.staffId}
            />
            <Field
              label="Start date"
              name="startDate"
              type="date"
              required
              defaultValue={v.startDate ?? today}
              error={e.startDate}
            />
            <SelectField
              label="Employment type"
              name="employmentType"
              options={EMPLOYMENT_OPTIONS}
              defaultValue={v.employmentType ?? "permanent"}
              error={e.employmentType}
            />
          </div>
          {canSetPay ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4">
              <SelectField
                label="Pay type (optional)"
                name="payType"
                options={PAY_OPTIONS}
                placeholder="Add pay later"
                value={payType}
                onChange={(ev) => setPayType(ev.currentTarget.value)}
                error={e.payType}
              />
              {payType === "monthly" ? (
                <>
                  <Field
                    label="Basic monthly (₦)"
                    name="basic"
                    inputMode="decimal"
                    defaultValue={v.basic ?? ""}
                    error={e.basic}
                  />
                  <Field
                    label="Housing monthly (₦)"
                    name="housing"
                    inputMode="decimal"
                    defaultValue={v.housing ?? ""}
                    error={e.housing}
                  />
                  <Field
                    label="Transport monthly (₦)"
                    name="transport"
                    inputMode="decimal"
                    defaultValue={v.transport ?? ""}
                    error={e.transport}
                  />
                  <Field
                    label="Other allowances monthly (₦)"
                    name="otherAllowances"
                    inputMode="decimal"
                    defaultValue={v.otherAllowances ?? ""}
                    error={e.otherAllowances}
                  />
                </>
              ) : null}
              {payType === "daily" ? (
                <Field
                  label="Daily rate (₦)"
                  name="dailyRate"
                  inputMode="decimal"
                  defaultValue={v.dailyRate ?? ""}
                  error={e.dailyRate}
                />
              ) : null}
              {payType === "hourly" ? (
                <Field
                  label="Hourly rate (₦)"
                  name="hourlyRate"
                  inputMode="decimal"
                  defaultValue={v.hourlyRate ?? ""}
                  error={e.hourlyRate}
                />
              ) : null}
              {payType ? (
                <Field
                  label="Pay from (optional)"
                  name="payEffectiveFrom"
                  type="date"
                  hint="Blank means the start date."
                  defaultValue={v.payEffectiveFrom ?? ""}
                  error={e.payEffectiveFrom}
                />
              ) : null}
            </div>
          ) : null}
          {hasBank ? (
            <p className="m-0 text-sm text-fg-muted">
              Their bank details become a bank-detail change. You raise it by approving, so a second
              person (owner, HR or finance) approves it in Approvals.
            </p>
          ) : null}
        </>
      ) : (
        <p className="m-0 text-sm text-fg-muted">
          Approving gives them access to the manager app with this role.
        </p>
      )}
      <FormAlert message={failed?.formError} />
      <SubmitButton pendingLabel="Approving…" className="w-auto self-start px-5">
        Approve
      </SubmitButton>
    </form>
  );
}
