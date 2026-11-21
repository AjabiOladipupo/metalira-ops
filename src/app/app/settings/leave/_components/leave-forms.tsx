"use client";

import { useActionState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  addEntitlementVersionAction,
  applyPresetAction,
  createLeaveTypeAction,
  saveLeaveTypeAction,
} from "@/server/people/leave-setup-actions";

import { fieldValue } from "../../../_company/form-footer";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-start gap-4";

const COUNTING_OPTIONS = [
  { value: "working_days", label: "Working days (skips off-days and holidays)" },
  { value: "calendar_days", label: "Calendar days (every day counts)" },
] as const;

function Checkbox({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex min-h-11 items-start gap-3 rounded-lg border border-line px-3 py-2.5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 shrink-0 accent-[var(--signal)]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

function Message({ state }: { state: CompanyFormState }) {
  return (
    <p role="status" className="m-0 text-sm text-fg-muted">
      {state?.ok ? state.message : null}
    </p>
  );
}

/** Confirms applying a preset after its preview. The database checks everything again. */
export function ApplyPresetForm({
  preset,
  effectiveFrom,
  label,
}: {
  preset: "A" | "B";
  effectiveFrom: string;
  label: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(applyPresetAction, null);
  return (
    <form action={action} aria-label={`Apply preset ${preset}`} className="flex flex-col gap-3">
      <input type="hidden" name="preset" value={preset} />
      <input type="hidden" name="effectiveFrom" value={effectiveFrom} />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton pendingLabel="Applying…" className="sm:w-auto sm:self-start sm:px-5">
        {label}
      </SubmitButton>
    </form>
  );
}

type Details = {
  name: string;
  counting: "working_days" | "calendar_days";
  paid: boolean;
  needsCertificate: boolean;
  minServiceMonths: number;
};

function DetailsFields({
  state,
  saved,
}: {
  state: CompanyFormState;
  saved: Details;
}) {
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  const checked = (name: string, value: boolean) => (typed ? typed[name] === "on" : value);
  return (
    <>
      <div className={GRID}>
        <Field
          label="Name"
          name="name"
          required
          maxLength={60}
          placeholder="Casual"
          defaultValue={fieldValue(state, "name", saved.name)}
          error={errors?.name}
        />
        <SelectField
          label="Counts"
          name="counting"
          options={COUNTING_OPTIONS}
          defaultValue={fieldValue(state, "counting", saved.counting)}
          error={errors?.counting}
        />
        <Field
          label="Minimum service (months)"
          name="minServiceMonths"
          inputMode="numeric"
          required
          hint="0 means it can be asked for from the first day"
          defaultValue={fieldValue(state, "minServiceMonths", saved.minServiceMonths)}
          error={errors?.minServiceMonths}
        />
      </div>
      <div className={GRID}>
        <Checkbox name="paid" label="Paid" defaultChecked={checked("paid", saved.paid)} />
        <Checkbox
          name="needsCertificate"
          label="Needs a certificate"
          hint="The approver ticks Certificate seen"
          defaultChecked={checked("needsCertificate", saved.needsCertificate)}
        />
      </div>
    </>
  );
}

/** Changes a type's details. Days a year change through EntitlementForm. */
export function LeaveTypeDetailsForm({
  leaveTypeId,
  saved,
  status,
}: {
  leaveTypeId: string;
  saved: Details;
  status: "active" | "retired";
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(saveLeaveTypeAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      key={JSON.stringify(state?.ok ? saved : null)}
      action={action}
      noValidate
      aria-label="Leave type details"
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      <DetailsFields state={state} saved={saved} />
      <div className={GRID}>
        <SelectField
          label="Status"
          name="status"
          options={[
            { value: "active", label: "Active: workers can ask for it" },
            { value: "retired", label: "Retired: kept, no new requests" },
          ]}
          defaultValue={fieldValue(state, "status", status)}
          error={errors?.status}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save details
        </SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}

/**
 * A new entitlement version: days a year, carry-over cap and pay, from tomorrow or the next
 * 1 January. Earlier days stay as they were (rule 3).
 */
export function EntitlementForm({
  leaveTypeId,
  saved,
  choices,
  paid,
}: {
  leaveTypeId: string;
  saved: {
    daysPerYear: number;
    carryOverCapDays: number | null;
    payPercent: number;
    payMinServiceMonths: number | null;
  };
  choices: { value: string; label: string }[];
  paid: boolean;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    addEntitlementVersionAction,
    null,
  );
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      key={state?.ok ? state.message : "entitlement"}
      action={action}
      noValidate
      aria-label="Days and pay"
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      <div className={GRID}>
        <Field
          label="Days a year"
          name="daysPerYear"
          inputMode="numeric"
          required
          defaultValue={fieldValue(state, "daysPerYear", saved.daysPerYear)}
          error={errors?.daysPerYear}
        />
        <Field
          label="Carry over up to (days)"
          name="carryOverCapDays"
          inputMode="numeric"
          hint="Empty: nothing carries over"
          defaultValue={fieldValue(state, "carryOverCapDays", saved.carryOverCapDays)}
          error={errors?.carryOverCapDays}
        />
        <Field
          label="Pay (% of wages)"
          name="payPercent"
          inputMode="numeric"
          required
          readOnly={!paid}
          hint={paid ? "100 is full pay" : "Unpaid leave pays 0"}
          defaultValue={fieldValue(state, "payPercent", paid ? saved.payPercent : 0)}
          error={errors?.payPercent}
        />
        <Field
          label="Pay needs service of (months)"
          name="payMinServiceMonths"
          inputMode="numeric"
          hint="Empty: paid from the first day"
          defaultValue={fieldValue(state, "payMinServiceMonths", saved.payMinServiceMonths)}
          error={errors?.payMinServiceMonths}
        />
        <SelectField
          label="Starts"
          name="effectiveFrom"
          options={choices}
          defaultValue={fieldValue(state, "effectiveFrom", choices[0]?.value)}
          error={errors?.effectiveFrom}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save days and pay
        </SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}

/** Adds a leave type of the company's own. */
export function CreateLeaveTypeForm() {
  const [state, action] = useActionState<CompanyFormState, FormData>(createLeaveTypeAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={action} noValidate aria-label="Add a leave type" className="flex flex-col gap-4">
      <DetailsFields
        state={state}
        saved={{
          name: "",
          counting: "working_days",
          paid: true,
          needsCertificate: false,
          minServiceMonths: 0,
        }}
      />
      <div className={GRID}>
        <Field
          label="Days a year"
          name="daysPerYear"
          inputMode="numeric"
          required
          defaultValue={fieldValue(state, "daysPerYear", "")}
          error={errors?.daysPerYear}
        />
        <Field
          label="Carry over up to (days)"
          name="carryOverCapDays"
          inputMode="numeric"
          hint="Empty: nothing carries over"
          defaultValue={fieldValue(state, "carryOverCapDays", "")}
          error={errors?.carryOverCapDays}
        />
        <Field
          label="Pay (% of wages)"
          name="payPercent"
          inputMode="numeric"
          hint="Empty: full pay. Unpaid types pay 0"
          defaultValue={fieldValue(state, "payPercent", "")}
          error={errors?.payPercent}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton pendingLabel="Adding…" className="sm:w-auto sm:self-start sm:px-5">
        Add leave type
      </SubmitButton>
    </form>
  );
}
