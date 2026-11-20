"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import { createContractAction, updateContractAction } from "@/server/business/contract-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

import { fieldValue } from "../../_company/form-footer";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4";

type Option = { value: string; label: string; hint?: string };

export interface ContractFormValues {
  id: string;
  reference: string;
  name: string;
  type: string;
  startDate: string;
  endDate: string | null;
  billingFrequency: string;
  billingTermsDays: number | null;
  vatApplies: boolean;
  /** Percent text, like "98". */
  coverageTarget: string;
  responseMinutes: number | null;
  slaNotes: string;
  siteIds: string[];
}

/**
 * New contract, or a draft's terms. The reference is given by the database when left blank and
 * never changes. Rates come next, on the rate card page.
 */
export function ContractForm({
  mode,
  clientId,
  contract,
  sites,
  types,
  frequencies,
  terms,
  companyTermsLabel,
  defaultVat,
  defaultStart,
}: {
  mode: "create" | "edit";
  clientId: string;
  contract?: ContractFormValues;
  sites: { id: string; name: string }[];
  types: Option[];
  frequencies: Option[];
  terms: Option[];
  /** "Client terms (30 days)". */
  companyTermsLabel: string;
  defaultVat: boolean;
  defaultStart: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    mode === "create" ? createContractAction : updateContractAction,
    null,
  );
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  const value = (name: string, saved: string | number | null | undefined) =>
    fieldValue(state, name, saved);
  // After a refusal, the ticks come back as typed (FormData keeps only the last siteIds value,
  // so fall back to the saved set).
  const ticked = new Set(contract?.siteIds ?? sites.map((s) => s.id));
  const vatChecked = typed ? typed.vatApplies === "on" : (contract?.vatApplies ?? defaultVat);
  const cancelHref = contract
    ? `/app/clients/${clientId}/contracts/${contract.id}`
    : `/app/clients/${clientId}?tab=contracts`;

  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label={mode === "create" ? "Add contract" : "Edit contract"}
      className="flex max-w-[880px] flex-col gap-6"
    >
      <input type="hidden" name="clientId" value={clientId} />
      {contract ? <input type="hidden" name="contractId" value={contract.id} /> : null}

      <section aria-labelledby="contract-terms" className="flex flex-col gap-4">
        <h2 id="contract-terms" className="m-0 type-h3">
          Contract
        </h2>
        <div className={GRID}>
          <Field
            label="Contract name"
            name="name"
            required
            placeholder="Apapa guarding"
            defaultValue={value("name", contract?.name)}
            error={errors?.name}
          />
          {mode === "create" ? (
            <Field
              label="Reference"
              name="reference"
              placeholder="CTR-0001"
              hint="Leave blank for the next number. It never changes."
              defaultValue={value("reference", null)}
              error={errors?.reference}
            />
          ) : (
            <Field label="Reference" name="reference" disabled defaultValue={contract?.reference} />
          )}
          <SelectField
            label="Type"
            name="type"
            options={types}
            defaultValue={value("type", contract?.type ?? "manned_post")}
            error={errors?.type}
          />
        </div>
        <div className={GRID}>
          <Field
            label="Start date"
            name="startDate"
            type="date"
            required
            defaultValue={value("startDate", contract?.startDate ?? defaultStart)}
            error={errors?.startDate}
          />
          <Field
            label="End date"
            name="endDate"
            type="date"
            hint="Leave blank for a rolling contract."
            defaultValue={value("endDate", contract?.endDate)}
            error={errors?.endDate}
          />
        </div>
      </section>

      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-3 p-0 type-h3">Sites</legend>
        {errors?.siteIds ? <p className="m-0 text-xs font-medium">{errors.siteIds}</p> : null}
        {sites.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            This client has no sites yet. Add them on the client page, then tick them here.
          </p>
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-2 p-0">
            {sites.map((site) => (
              <li key={site.id}>
                <label className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-3 text-[15px]">
                  <input
                    type="checkbox"
                    name="siteIds"
                    value={site.id}
                    defaultChecked={ticked.has(site.id)}
                    className="size-4 accent-[var(--fg)]"
                  />
                  {site.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <section aria-labelledby="contract-billing" className="flex flex-col gap-4">
        <h2 id="contract-billing" className="m-0 type-h3">
          Billing
        </h2>
        <div className={GRID}>
          <SelectField
            label="Invoice"
            name="billingFrequency"
            options={frequencies}
            defaultValue={value("billingFrequency", contract?.billingFrequency ?? "monthly")}
            error={errors?.billingFrequency}
          />
          <SelectField
            label="Payment terms"
            name="billingTermsDays"
            placeholder={companyTermsLabel}
            options={terms}
            defaultValue={value("billingTermsDays", contract?.billingTermsDays)}
            error={errors?.billingTermsDays}
          />
        </div>
        <label className="flex min-h-11 items-center gap-3 text-[15px]">
          <input
            type="checkbox"
            name="vatApplies"
            defaultChecked={vatChecked}
            className="size-4 accent-[var(--fg)]"
          />
          Charge VAT on invoices (7.5%, added to the rates)
        </label>
      </section>

      <section aria-labelledby="contract-sla" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="contract-sla" className="m-0 type-h3">
            Service level
          </h2>
          <p className="m-0 text-sm text-fg-muted">Optional. What you promised the client.</p>
        </div>
        <div className={GRID}>
          <Field
            label="Coverage target (%)"
            name="coverageTargetBps"
            inputMode="decimal"
            placeholder="98"
            defaultValue={value("coverageTargetBps", contract?.coverageTarget)}
            error={errors?.coverageTargetBps}
          />
          <Field
            label="Response time (minutes)"
            name="responseMinutes"
            inputMode="numeric"
            placeholder="30"
            defaultValue={value("responseMinutes", contract?.responseMinutes)}
            error={errors?.responseMinutes}
          />
        </div>
        <Field
          label="SLA notes"
          name="slaNotes"
          placeholder="Relief guard within 2 hours of a no-show"
          defaultValue={value("slaNotes", contract?.slaNotes)}
          error={errors?.slaNotes}
        />
      </section>

      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          {mode === "create" ? "Add contract" : "Save changes"}
        </SubmitButton>
        <Button asChild variant="outline" className="h-11 px-4">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
