"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { cancelRateCardVersionAction } from "@/server/business/contract-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

/** Cancels a scheduled rate card version (one that hasn't started); the one before reopens. */
export function CancelVersionButton({
  id,
  clientId,
  label,
}: {
  id: string;
  clientId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<CompanyFormState, FormData>(
    cancelRateCardVersionAction,
    null,
  );
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name="rateCardId" value={id} />
      <input type="hidden" name="clientId" value={clientId} />
      <Button
        type="submit"
        variant="link"
        size="sm"
        disabled={pending}
        aria-label={label}
        className="px-0 text-sm"
      >
        {pending ? "Cancelling…" : "Cancel"}
      </Button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs font-medium">
          {state.formError}
        </span>
      ) : null}
    </form>
  );
}
