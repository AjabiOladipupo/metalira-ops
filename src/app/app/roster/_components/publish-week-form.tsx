"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { publishRosterAction, resendPublishNoticesAction } from "@/server/workforce/roster-actions";

const notSent = (state: CompanyFormState) => Number(state?.values?.notSent ?? 0) > 0;

function Result({ message, testId }: { message?: string; testId: string }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="m-0 flex items-start gap-2 rounded-lg border border-line px-3.5 py-2.5 text-sm"
    >
      <StatusDot tone="done" className="mt-1.5" />
      {message}
    </p>
  );
}

/**
 * "Send notices again" after a publish where some workers weren't told: tells only the ones the
 * latest version affected who have no message for it yet, under the same email caps.
 */
function ResendNotices({ siteId, weekStart }: { siteId: string; weekStart: string }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    resendPublishNoticesAction,
    null,
  );
  return (
    <div className="flex flex-col gap-3">
      {state?.ok ? <Result message={state.message} testId="resend-result" /> : null}
      {!state?.ok || notSent(state) ? (
        <form action={action} aria-label="Send notices again" className="flex flex-col gap-3">
          <input type="hidden" name="siteId" value={siteId} />
          <input type="hidden" name="weekStart" value={weekStart} />
          <FormAlert message={state && !state.ok ? state.formError : undefined} />
          <SubmitButton pendingLabel="Sending…" className="sm:self-start">
            Send notices again
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

/**
 * "Publish roster", step two: confirm. The database checks everything again and refuses a
 * republish with nothing changed. After publishing, the result says who was told and how, and
 * offers "Send notices again" when someone wasn't told.
 */
export function PublishWeekForm({
  siteId,
  weekStart,
  version,
  back,
  nothingToPublish = false,
}: {
  siteId: string;
  weekStart: string;
  version: number;
  back: string;
  /** The latest version is up to date: only the way back. */
  nothingToPublish?: boolean;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(publishRosterAction, null);
  if (state?.ok) {
    return (
      <div className="flex flex-col gap-3">
        <Result message={state.message} testId="publish-result" />
        {notSent(state) ? <ResendNotices siteId={siteId} weekStart={weekStart} /> : null}
        <Button asChild variant="outline" className="self-start">
          <Link href={back}>Back to the roster</Link>
        </Button>
      </div>
    );
  }
  if (nothingToPublish) {
    return (
      <Button asChild variant="outline" className="self-start">
        <Link href={back}>Back to the roster</Link>
      </Button>
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
