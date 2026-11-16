"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { cancelPayRateAction } from "@/server/people/actions";

/** Cancels a scheduled pay version (one that has not started) and reopens the one before it. */
export function CancelPayButton({ payRateId, label }: { payRateId: string; label: string }) {
  const [state, action, pending] = useActionState(cancelPayRateAction, null);
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name="payRateId" value={payRateId} />
      <Button
        type="submit"
        variant="link"
        size="sm"
        disabled={pending}
        aria-label={label}
        className="text-sm"
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
