"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { publishRosterAction } from "@/server/workforce/roster-actions";

/**
 * "Publish roster", step two: confirm. The database checks everything again and refuses a
 * republish with nothing changed. After publishing, the result says who was told and how.
 */
export function PublishWeekForm({
  siteId,
  weekStart,
  version,
  back,
}: {
  siteId: string;
  weekStart: string;
  version: number;
  back: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(publishRosterAction, null);
  if (state?.ok) {
    return (
      <div className="flex flex-col gap-3">
        <p
          role="status"
          data-testid="publish-result"
          className="m-0 flex items-start gap-2 rounded-lg border border-line px-3.5 py-2.5 text-sm"
        >
          <StatusDot tone="done" className="mt-1.5" />
          {state.message}
        </p>
        <Button asChild variant="outline" className="self-start">
          <Link href={back}>Back to the roster</Link>
        </Button>
      </div>
    );
  }
  return (
    <form action={action} aria-label="Publish roster" className="flex flex-col gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="weekStart" value={weekStart} />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <SubmitButton pendingLabel="Publishing…" className="sm:self-start">
        {version > 1 ? `Publish version ${version}` : "Publish roster"}
      </SubmitButton>
    </form>
  );
}
