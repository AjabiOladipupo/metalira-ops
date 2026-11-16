"use client";

import { useActionState } from "react";

import type { CompanyFormState } from "@/server/identity/company-form-state";

import { CompanyFormFooter } from "../../_company/form-footer";

/** Back and Continue for a wizard step with no fields of its own (Clients, Employees). */
export function StepForm({
  action,
  backHref,
  continueLabel,
}: {
  action: (prev: CompanyFormState, formData: FormData) => Promise<CompanyFormState>;
  backHref: string;
  continueLabel?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction}>
      <CompanyFormFooter
        mode="setup"
        state={state}
        backHref={backHref}
        continueLabel={continueLabel}
      />
    </form>
  );
}
