"use client";

import { useActionState } from "react";

import { Field, SelectField } from "@/components/form";
import { INDUSTRIES, NIGERIAN_STATES, ordinal } from "@/lib/company";
import { saveBusiness } from "@/server/identity/company-actions";
import type { Company } from "@/server/identity/company-data";

import { CompanyFormFooter, fieldValue, type CompanyFormMode } from "./form-footer";

const INDUSTRY_OPTIONS = INDUSTRIES.map((i) => ({ value: i.id, label: i.name }));
const STATE_OPTIONS = NIGERIAN_STATES.map((s) => ({ value: s, label: s }));
const CYCLE_DAYS = Array.from({ length: 28 }, (_, i) => ({
  value: String(i + 1),
  label: `${ordinal(i + 1)} of the month`,
}));
const PAY_DAYS = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: `${ordinal(i + 1)} of the month`,
}));

export type BusinessDetails = Pick<
  Company,
  | "name"
  | "legalName"
  | "tradingName"
  | "rcNumber"
  | "tin"
  | "industry"
  | "headOfficeState"
  | "address"
  | "phone"
  | "payCycleStartDay"
  | "payDay"
>;

/**
 * Business step: what goes on payslips, invoices and receipts, and the monthly pay settings.
 * Weekly pay and "last working day" from the board wait until payroll rules cover them.
 */
export function BusinessForm({
  mode,
  company,
  backHref,
}: {
  mode: CompanyFormMode;
  company: BusinessDetails;
  backHref?: string;
}) {
  const [state, action] = useActionState(saveBusiness, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const defaults = {
    legalName: fieldValue(state, "legalName", company.legalName ?? company.name),
    tradingName: fieldValue(state, "tradingName", company.tradingName ?? company.name),
    rcNumber: fieldValue(state, "rcNumber", company.rcNumber),
    tin: fieldValue(state, "tin", company.tin),
    industry: fieldValue(state, "industry", company.industry),
    headOfficeState: fieldValue(state, "headOfficeState", company.headOfficeState),
    address: fieldValue(state, "address", company.address),
    phone: fieldValue(state, "phone", company.phone),
    payCycleStartDay: fieldValue(state, "payCycleStartDay", company.payCycleStartDay),
    payDay: fieldValue(state, "payDay", company.payDay),
  };

  return (
    <form key={JSON.stringify(defaults)} action={action} noValidate className="flex flex-col gap-6">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
        <Field
          label="Registered business name"
          name="legalName"
          autoComplete="organization"
          required
          defaultValue={defaults.legalName}
          error={errors?.legalName}
        />
        <Field
          label="Trading name"
          name="tradingName"
          hint="Shown across the app and on emails."
          defaultValue={defaults.tradingName}
          error={errors?.tradingName}
        />
        <Field
          label="CAC RC number"
          name="rcNumber"
          placeholder="RC 1234567"
          defaultValue={defaults.rcNumber}
          error={errors?.rcNumber}
        />
        <Field
          label="Tax ID (TIN)"
          name="tin"
          inputMode="numeric"
          placeholder="12345678-0001"
          defaultValue={defaults.tin}
          error={errors?.tin}
        />
        <SelectField
          label="Industry"
          name="industry"
          required
          placeholder="Choose an industry"
          options={INDUSTRY_OPTIONS}
          defaultValue={defaults.industry}
          error={errors?.industry}
        />
        <SelectField
          label="Head office state"
          name="headOfficeState"
          required
          placeholder="Choose a state"
          options={STATE_OPTIONS}
          defaultValue={defaults.headOfficeState}
          error={errors?.headOfficeState}
        />
        <Field
          label="Office address"
          name="address"
          autoComplete="street-address"
          defaultValue={defaults.address}
          error={errors?.address}
        />
        <Field
          label="Business phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="0800 000 0000"
          defaultValue={defaults.phone}
          error={errors?.phone}
        />
      </div>

      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="mb-1 type-h3">Pay</legend>
        <p className="m-0 text-sm text-fg-muted">
          Monthly pay. The cycle runs from the start day to the day before it in the next month.
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
          <SelectField
            label="Pay cycle starts on"
            name="payCycleStartDay"
            options={CYCLE_DAYS}
            defaultValue={defaults.payCycleStartDay}
            error={errors?.payCycleStartDay}
          />
          <SelectField
            label="Pay day"
            name="payDay"
            options={PAY_DAYS}
            defaultValue={defaults.payDay}
            error={errors?.payDay}
          />
        </div>
      </fieldset>

      <CompanyFormFooter mode={mode} state={state} backHref={backHref} />
    </form>
  );
}
