"use client";

import { useActionState } from "react";

import { Field, FormAlert } from "@/components/form";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { CHANGE_TOPIC_LABELS } from "@/lib/people";
import { resolveChangeRequestAction } from "@/server/people/change-request-actions";
import type { ChangeRequestView } from "@/server/people/change-requests";

function ResolveForm({ request }: { request: ChangeRequestView }) {
  const [state, action, pending] = useActionState(resolveChangeRequestAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <form
      action={action}
      aria-label={`Deal with the ${CHANGE_TOPIC_LABELS[request.topic].toLowerCase()} request`}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="requestId" value={request.id} />
      <Field
        label="Note to the employee"
        name="note"
        hint="Optional. The employee sees it on their profile."
        maxLength={500}
        className="max-w-md"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          name="decision"
          value="done"
          disabled={pending}
          className="h-10 rounded-lg"
        >
          Mark done
        </Button>
        <Button
          type="submit"
          name="decision"
          value="declined"
          variant="outline"
          disabled={pending}
          className="h-10 rounded-lg"
        >
          Decline
        </Button>
        {pending ? (
          <span role="status" className="text-sm text-fg-muted">
            Saving…
          </span>
        ) : null}
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
    </form>
  );
}

/**
 * A change the employee asked for from the worker app (slice 1.10). It changes nothing by
 * itself: HR edits the record, then marks it done, or declines it with a note.
 */
export function ChangeRequestCard({
  request,
  canResolve,
}: {
  request: ChangeRequestView;
  canResolve: boolean;
}) {
  const open = request.status === "open";
  return (
    <article
      aria-label={`${CHANGE_TOPIC_LABELS[request.topic]} change request`}
      data-testid="change-request"
      data-status={request.status}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-line p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold">{CHANGE_TOPIC_LABELS[request.topic]}</span>
          <span className="text-xs text-fg-muted">
            Sent {formatDateTime(request.createdAt)} from the worker app
          </span>
        </div>
        {open ? (
          <Status tone={canResolve ? "action" : "pending"}>
            {canResolve ? "Needs your action" : "Open"}
          </Status>
        ) : (
          <span className="text-sm text-fg-muted">
            {request.status === "done" ? "Done" : "Declined"}
            {request.resolvedAt ? ` on ${formatDateTime(request.resolvedAt)}` : ""}
          </span>
        )}
      </div>
      <p className="m-0 text-[15px] break-words whitespace-pre-line">{request.details}</p>
      {request.resolutionNote ? (
        <p className="m-0 text-sm text-fg-muted">Note: {request.resolutionNote}</p>
      ) : null}
      {open && canResolve ? <ResolveForm request={request} /> : null}
    </article>
  );
}
