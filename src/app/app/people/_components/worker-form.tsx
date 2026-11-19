"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { BankAccountFields } from "@/components/bank-account-fields";
import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import { NIGERIAN_STATES } from "@/lib/company";
import { maskRsaPin, ninStatus } from "@/lib/mask";
import { EMPLOYMENT_TYPE_LABELS, PAY_TYPE_LABELS, type PayType } from "@/lib/people";
import { createWorkerAction, updateWorkerAction } from "@/server/people/actions";
import { lookupWorkerBankAccountAction } from "@/server/people/bank-change-actions";
import type { Option } from "@/server/people/people-data";

import { fieldValue } from "../../_company/form-footer";
import { PayAmountFields } from "./pay-amount-fields";

const EMPLOYMENT_OPTIONS = Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));
const PAY_OPTIONS = Object.entries(PAY_TYPE_LABELS).map(([value, label]) => ({ value, label }));
const STATE_OPTIONS = NIGERIAN_STATES.map((s) => ({ value: s, label: s }));

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4";

/** What the edit form starts from: the saved worker, with personal data as "on file" only. */
export interface WorkerFormValues {
  id: string;
  staffId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  lineManager: string;
  employmentType: string;
  startDate: string;
  ninOnFile: boolean;
  tin: string | null;
  taxState: string | null;
  pfaName: string | null;
  rsaPinLast4: string | null;
  rsaPinOnFile: boolean;
  nhfOptIn: boolean;
  annualRentDeclared: string | null;
  nextOfKinName: string | null;
  nextOfKinPhone: string | null;
  supervisorClockIn: boolean;
}

function Fieldset({
  legend,
  note,
  children,
}: {
  legend: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-4 border-0 border-t border-line p-0 pt-6">
      <legend className="float-left mb-1 w-full type-h3">{legend}</legend>
      {note ? <p className="m-0 text-sm text-fg-muted">{note}</p> : null}
      {children}
    </fieldset>
  );
}

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
    <label className="flex items-start gap-2.5 text-[15px]">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-[18px] shrink-0 accent-foreground"
      />
      <span className="flex flex-col gap-0.5">
        {label}
        {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * Add or edit an employee. Adding takes everything, including the first pay rate and bank
 * details (held for a second approver, slice 1.7). Editing leaves out the staff ID (fixed once saved), bank details (a second person
 * approves changes, slice 1.7) and pay (changed as a new dated version on the profile). Personal
 * data inputs start empty: blank keeps what is on file, and typed values are never sent back to
 * the browser after a refusal.
 */
export function WorkerForm({
  mode,
  options,
  worker,
  today,
}: {
  mode: "create" | "update";
  options: { departments: Option[]; lineManagers: Option[] };
  worker?: WorkerFormValues;
  today: string;
}) {
  const [state, action] = useActionState(
    mode === "create" ? createWorkerAction : updateWorkerAction,
    null,
  );
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  const checked = (name: string, saved: boolean) => (typed ? typed[name] !== undefined : saved);

  const defaults = {
    staffId: fieldValue(state, "staffId", worker?.staffId),
    firstName: fieldValue(state, "firstName", worker?.firstName),
    lastName: fieldValue(state, "lastName", worker?.lastName),
    phone: fieldValue(state, "phone", worker?.phone),
    email: fieldValue(state, "email", worker?.email),
    jobTitle: fieldValue(state, "jobTitle", worker?.jobTitle),
    departmentId: fieldValue(state, "departmentId", worker?.departmentId),
    lineManager: fieldValue(state, "lineManager", worker?.lineManager),
    employmentType: fieldValue(state, "employmentType", worker?.employmentType ?? "permanent"),
    startDate: fieldValue(state, "startDate", worker?.startDate ?? today),
    payType: fieldValue(state, "payType", ""),
    payEffectiveFrom: fieldValue(state, "payEffectiveFrom", ""),
    bankCode: fieldValue(state, "bankCode", ""),
    nameCheckReason: fieldValue(state, "nameCheckReason", ""),
    tin: fieldValue(state, "tin", worker?.tin),
    taxState: fieldValue(state, "taxState", worker?.taxState),
    pfaName: fieldValue(state, "pfaName", worker?.pfaName),
    nhfOptIn: checked("nhfOptIn", worker?.nhfOptIn ?? false),
    annualRentDeclared: fieldValue(state, "annualRentDeclared", worker?.annualRentDeclared),
    nextOfKinName: fieldValue(state, "nextOfKinName", worker?.nextOfKinName),
    nextOfKinPhone: fieldValue(state, "nextOfKinPhone", worker?.nextOfKinPhone),
    supervisorClockIn: checked("supervisorClockIn", worker?.supervisorClockIn ?? false),
  };

  const [payType, setPayType] = useState(defaults.payType);
  const formRef = useRef<HTMLFormElement>(null);
  const cancelHref = worker ? `/app/people/${worker.id}` : "/app/people";

  return (
    <form
      ref={formRef}
      key={JSON.stringify(defaults)}
      action={action}
      noValidate
      className="flex flex-col gap-7"
      aria-label={mode === "create" ? "Add employee" : "Edit employee"}
    >
      {worker ? <input type="hidden" name="workerId" value={worker.id} /> : null}

      <Fieldset legend="Identity and contact">
        <div className={GRID}>
          {mode === "create" ? (
            <Field
              label="Staff ID"
              name="staffId"
              hint="Leave blank to use the next ID in your pattern, like EMP-0001."
              maxLength={64}
              defaultValue={defaults.staffId}
              error={errors?.staffId}
            />
          ) : null}
          <Field
            label="First name"
            name="firstName"
            autoComplete="off"
            required
            defaultValue={defaults.firstName}
            error={errors?.firstName}
          />
          <Field
            label="Last name"
            name="lastName"
            autoComplete="off"
            required
            defaultValue={defaults.lastName}
            error={errors?.lastName}
          />
          <Field
            label="Phone"
            name="phone"
            type="tel"
            inputMode="tel"
            placeholder="0803 123 4567"
            defaultValue={defaults.phone}
            error={errors?.phone}
          />
          <Field
            label="Email"
            name="email"
            type="email"
            hint="Optional. Used for invites and notices."
            defaultValue={defaults.email}
            error={errors?.email}
          />
        </div>
        <Checkbox
          name="supervisorClockIn"
          label="Supervisor clocks this employee in"
          hint="For employees who share a phone. Set automatically when another employee already has this number."
          defaultChecked={defaults.supervisorClockIn}
        />
      </Fieldset>

      <Fieldset legend="Job">
        <div className={GRID}>
          <Field
            label="Job title"
            name="jobTitle"
            placeholder="Security guard"
            defaultValue={defaults.jobTitle}
            error={errors?.jobTitle}
          />
          <SelectField
            label="Department"
            name="departmentId"
            placeholder="No department yet"
            options={options.departments}
            defaultValue={defaults.departmentId}
            error={errors?.departmentId}
          />
          <SelectField
            label="Line manager"
            name="lineManager"
            placeholder="No line manager yet"
            options={options.lineManagers}
            defaultValue={defaults.lineManager}
            error={errors?.lineManager}
          />
          <SelectField
            label="Employment type"
            name="employmentType"
            options={EMPLOYMENT_OPTIONS}
            defaultValue={defaults.employmentType}
            error={errors?.employmentType}
          />
          <Field
            label="Start date"
            name="startDate"
            type="date"
            required
            defaultValue={defaults.startDate}
            error={errors?.startDate}
          />
        </div>
      </Fieldset>

      {mode === "create" ? (
        <Fieldset
          legend="Pay"
          note="Amounts in naira. Leave the pay type blank to add pay later; payroll skips employees without pay details."
        >
          <div className={GRID}>
            <SelectField
              label="Pay type"
              name="payType"
              placeholder="Add pay later"
              options={PAY_OPTIONS}
              defaultValue={defaults.payType}
              onChange={(event) => setPayType(event.currentTarget.value)}
              error={errors?.payType}
            />
            {payType ? (
              <Field
                label="Pay starts on"
                name="payEffectiveFrom"
                type="date"
                hint="Defaults to the start date."
                defaultValue={defaults.payEffectiveFrom}
                error={errors?.payEffectiveFrom}
              />
            ) : null}
          </div>
          {payType ? (
            <PayAmountFields payType={payType as PayType} defaults={typed ?? {}} errors={errors} />
          ) : null}
        </Fieldset>
      ) : null}

      {mode === "create" ? (
        <Fieldset
          legend="Bank details"
          note="Choose the bank and enter the account number, and the bank gives the account name. Or leave them blank and add them later. Someone other than you approves them, and payouts use them 72 hours after approval."
        >
          <BankAccountFields
            lookup={(input) => {
              const form = formRef.current ? new FormData(formRef.current) : null;
              const text = (key: string) => {
                const value = form?.get(key);
                return typeof value === "string" ? value : "";
              };
              return lookupWorkerBankAccountAction({
                ...input,
                firstName: text("firstName"),
                lastName: text("lastName"),
              });
            }}
            defaultBankCode={defaults.bankCode}
            defaultReason={defaults.nameCheckReason}
            errors={errors}
            whose="the employee's"
          />
        </Fieldset>
      ) : (
        <Fieldset
          legend="Bank details"
          note="Bank details change through a request on the employee page, which a second person approves. They can't be edited here."
        >
          {null}
        </Fieldset>
      )}

      <Fieldset legend="Tax and pension">
        <div className={GRID}>
          <Field
            label="NIN"
            name="nin"
            inputMode="numeric"
            autoComplete="off"
            placeholder="11 digits"
            maxLength={15}
            hint={
              worker
                ? `${ninStatus(worker.ninOnFile)}. ${worker.ninOnFile ? "Leave blank to keep it." : "11 digits."}`
                : "Optional. 11 digits."
            }
            error={errors?.nin}
          />
          <Field label="TIN" name="tin" defaultValue={defaults.tin} error={errors?.tin} />
          <SelectField
            label="Tax state"
            name="taxState"
            placeholder="Not set"
            options={STATE_OPTIONS}
            defaultValue={defaults.taxState}
            error={errors?.taxState}
          />
          <Field
            label="Pension fund (PFA)"
            name="pfaName"
            defaultValue={defaults.pfaName}
            error={errors?.pfaName}
          />
          <Field
            label="RSA PIN"
            name="rsaPin"
            autoComplete="off"
            placeholder="PEN100012344421"
            maxLength={40}
            hint={
              worker?.rsaPinOnFile
                ? `On file (${maskRsaPin(worker.rsaPinLast4) || "saved"}). Leave blank to keep it.`
                : "Optional."
            }
            error={errors?.rsaPin}
          />
          <Field
            label="Annual rent declared"
            name="annualRentDeclared"
            inputMode="decimal"
            placeholder="0.00"
            hint="In naira, for rent relief."
            defaultValue={defaults.annualRentDeclared}
            error={errors?.annualRentDeclared}
          />
        </div>
        <Checkbox
          name="nhfOptIn"
          label="Contributes to the National Housing Fund"
          defaultChecked={defaults.nhfOptIn}
        />
      </Fieldset>

      <Fieldset legend="Next of kin">
        <div className={GRID}>
          <Field
            label="Next of kin name"
            name="nextOfKinName"
            defaultValue={defaults.nextOfKinName}
            error={errors?.nextOfKinName}
          />
          <Field
            label="Next of kin phone"
            name="nextOfKinPhone"
            type="tel"
            inputMode="tel"
            defaultValue={defaults.nextOfKinPhone}
            error={errors?.nextOfKinPhone}
          />
        </div>
      </Fieldset>

      <div className="flex flex-col gap-4 border-t border-line pt-5">
        <FormAlert message={state && !state.ok ? state.formError : undefined} />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
            {mode === "create" ? "Add employee" : "Save changes"}
          </SubmitButton>
          <Button asChild variant="outline" className="h-11 rounded-lg px-4">
            <Link href={cancelHref}>Cancel</Link>
          </Button>
        </div>
      </div>
    </form>
  );
}
