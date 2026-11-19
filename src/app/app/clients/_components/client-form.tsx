"use client";

import Link from "next/link";
import { useActionState, useId } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import { NIGERIAN_STATES, paymentTermsLabel } from "@/lib/company";
import { cn } from "@/lib/utils";
import { createClientAction, updateClientAction } from "@/server/business/actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

import { fieldValue } from "../../_company/form-footer";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4";

const TERMS = [0, 7, 14, 30, 45, 60, 90] as const;

export interface ClientFormValues {
  id: string;
  name: string;
  legalName: string | null;
  rcNumber: string | null;
  tin: string | null;
  billingAddress: string | null;
  state: string | null;
  billingTermsDays: number | null;
  notes: string | null;
}

/** A multi-line plain-text field laid out like Field. */
function TextAreaField({
  label,
  name,
  defaultValue,
  error,
  hint,
  rows = 3,
}: {
  label: string;
  name: string;
  defaultValue: string;
  error?: string;
  hint?: string;
  rows?: number;
}) {
  const id = useId();
  const note = error ?? hint;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        className="w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-[15px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-foreground"
      />
      {note ? (
        <p
          id={`${id}-note`}
          className={cn("m-0 text-xs", error ? "font-medium text-foreground" : "text-fg-muted")}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Add client (with an optional billing contact) or edit a client's details. Blank optional fields
 * are saved as "not set". Payment terms left on "Company terms" follow Settings > Company.
 */
export function ClientForm({
  mode,
  client,
  companyTermsDays,
}: {
  mode: "create" | "edit";
  client?: ClientFormValues;
  companyTermsDays: number;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    mode === "create" ? createClientAction : updateClientAction,
    null,
  );
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const value = (name: string, saved: string | number | null | undefined) =>
    fieldValue(state, name, saved);
  const cancelHref = client ? `/app/clients/${client.id}` : "/app/clients";

  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label={mode === "create" ? "Add client" : "Edit client"}
      className="flex max-w-[880px] flex-col gap-6"
    >
      {client ? <input type="hidden" name="clientId" value={client.id} /> : null}

      <section aria-labelledby="client-details" className="flex flex-col gap-4">
        <h2 id="client-details" className="m-0 type-h3">
          Company
        </h2>
        <div className={GRID}>
          <Field
            label="Client name"
            name="name"
            required
            placeholder="Coastline Logistics"
            hint="The name your team uses."
            defaultValue={value("name", client?.name)}
            error={errors?.name}
          />
          <Field
            label="Registered name"
            name="legalName"
            placeholder="Coastline Logistics Nigeria Ltd"
            hint="As on the CAC certificate. Goes on invoices."
            defaultValue={value("legalName", client?.legalName)}
            error={errors?.legalName}
          />
          <Field
            label="CAC RC number"
            name="rcNumber"
            placeholder="RC 1234567"
            defaultValue={value("rcNumber", client?.rcNumber)}
            error={errors?.rcNumber}
          />
          <Field
            label="Tax ID (TIN)"
            name="tin"
            placeholder="12345678-0001"
            defaultValue={value("tin", client?.tin)}
            error={errors?.tin}
          />
        </div>
      </section>

      <section aria-labelledby="client-billing" className="flex flex-col gap-4">
        <h2 id="client-billing" className="m-0 type-h3">
          Billing
        </h2>
        <TextAreaField
          label="Billing address"
          name="billingAddress"
          defaultValue={value("billingAddress", client?.billingAddress)}
          error={errors?.billingAddress}
          hint="Where invoices are addressed."
        />
        <div className={GRID}>
          <SelectField
            label="State"
            name="state"
            placeholder="Not set"
            options={NIGERIAN_STATES.map((s) => ({ value: s, label: s }))}
            defaultValue={value("state", client?.state)}
            error={errors?.state}
          />
          <SelectField
            label="Payment terms"
            name="billingTermsDays"
            placeholder={`Company terms (${paymentTermsLabel(companyTermsDays)})`}
            options={TERMS.map((d) => ({ value: String(d), label: paymentTermsLabel(d) }))}
            defaultValue={value("billingTermsDays", client?.billingTermsDays)}
            error={errors?.billingTermsDays}
          />
        </div>
      </section>

      {mode === "create" ? (
        <section aria-labelledby="client-contact" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="client-contact" className="m-0 type-h3">
              Billing contact
            </h2>
            <p className="m-0 text-sm text-fg-muted">
              Invoices and receipts go to this person. Add approvers and site contacts on the client
              page.
            </p>
          </div>
          <div className={GRID}>
            <Field
              label="Contact name"
              name="contactName"
              placeholder="Ngozi Eze"
              defaultValue={value("contactName", null)}
              error={errors?.contactName}
            />
            <Field
              label="Contact email"
              name="contactEmail"
              type="email"
              placeholder="accounts@coastline.ng"
              defaultValue={value("contactEmail", null)}
              error={errors?.contactEmail}
            />
            <Field
              label="Contact phone"
              name="contactPhone"
              type="tel"
              placeholder="0803 123 4567"
              defaultValue={value("contactPhone", null)}
              error={errors?.contactPhone}
            />
          </div>
        </section>
      ) : null}

      <TextAreaField
        label="Notes"
        name="notes"
        defaultValue={value("notes", client?.notes)}
        error={errors?.notes}
        hint="For your team only. Never sent to the client."
      />

      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          {mode === "create" ? "Add client" : "Save changes"}
        </SubmitButton>
        <Button asChild variant="outline" className="h-11 px-4">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
