"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { quickAddClientAction } from "@/server/business/actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

import { fieldValue } from "../../_company/form-footer";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-start gap-4";

/** Setup step 4: a client, its billing email and a first site, as on the Setup board. */
export function QuickAddClientForm() {
  const [state, action] = useActionState<CompanyFormState, FormData>(quickAddClientAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label="Add client"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <div className={GRID}>
        <Field
          label="Client"
          name="name"
          required
          placeholder="Coastline Logistics"
          defaultValue={fieldValue(state, "name", "")}
          error={errors?.name}
        />
        <Field
          label="Billing email"
          name="billingEmail"
          type="email"
          placeholder="accounts@coastline.ng"
          hint="Invoices go here."
          defaultValue={fieldValue(state, "billingEmail", "")}
          error={errors?.billingEmail}
        />
        <Field
          label="First site"
          name="siteName"
          placeholder="Apapa Warehouse 3"
          defaultValue={fieldValue(state, "siteName", "")}
          error={errors?.siteName}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Adding…" className="w-auto px-5">
          Add client
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
