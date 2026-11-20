"use client";

import { useActionState } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { copyLastWeekAction } from "@/server/workforce/roster-actions";

/** "Copy last week", step two: confirm the preview. The database checks each row again. */
export function CopyWeekForm({
  siteId,
  weekStart,
  copies,
}: {
  siteId: string;
  weekStart: string;
  copies: number;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(copyLastWeekAction, null);
  return (
    <form action={action} aria-label="Copy last week" className="flex flex-col gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="weekStart" value={weekStart} />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton pendingLabel="Copying…" className="sm:self-start">
        {`Copy ${copies} ${copies === 1 ? "assignment" : "assignments"}`}
      </SubmitButton>
    </form>
  );
}
