"use client";

import { useActionState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { setClientTaxAction } from "@/server/business/actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

/**
 * A client's tax settings (owner, admin, finance): whether it is expected to deduct WHT, and
 * whether it pays the VAT to the tax authority itself. Audited with the reason given.
 */
export function TaxSettingsForm({
  clientId,
  deductsWht,
  withholdsVat,
}: {
  clientId: string;
  deductsWht: "expected" | "not_deducted";
  withholdsVat: boolean;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(setClientTaxAction, null);
  const typed = state && !state.ok ? state.values : undefined;
  const deducts = typed?.deductsWht ?? deductsWht;
  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label="Tax settings"
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-[13px] font-medium">Withholding tax</legend>
        <label className="flex min-h-11 items-start gap-3 text-[15px]">
          <input
            type="radio"
            name="deductsWht"
            value="expected"
            defaultChecked={deducts === "expected"}
            className="mt-1 size-4 accent-[var(--fg)]"
          />
          <span>
            Deducts WHT
            <span className="block text-sm text-fg-muted">
              Payments arrive less each line&apos;s WHT, worked out before VAT.
            </span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-3 text-[15px]">
          <input
            type="radio"
            name="deductsWht"
            value="not_deducted"
            defaultChecked={deducts === "not_deducted"}
            className="mt-1 size-4 accent-[var(--fg)]"
          />
          <span>
            Doesn&apos;t deduct WHT
            <span className="block text-sm text-fg-muted">
              For example a small company that pays in full. Payments will show you which applies.
            </span>
          </span>
        </label>
      </fieldset>
      <label className="flex min-h-11 items-start gap-3 text-[15px]">
        <input
          type="checkbox"
          name="withholdsVat"
          defaultChecked={typed ? typed.withholdsVat === "on" : withholdsVat}
          className="mt-1 size-4 accent-[var(--fg)]"
        />
        <span>
          Pays the VAT to the tax authority itself
          <span className="block text-sm text-fg-muted">
            Government bodies and appointed VAT withholding agents. Their payments arrive without
            the VAT.
          </span>
        </span>
      </label>
      <Field
        label="Reason for the change"
        name="reason"
        placeholder="Confirmed with their accounts team"
        defaultValue={typed?.reason ?? ""}
        error={state && !state.ok ? state.fieldErrors?.reason : undefined}
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save tax settings
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
