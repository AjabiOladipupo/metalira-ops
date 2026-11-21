"use client";

import { useActionState, useId } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import { workerMessages } from "@/lib/messages/worker";
import { QUERY_LIMITS } from "@/lib/queries";
import { replyToQueryAction } from "@/server/people/query-actions";

const copy = workerMessages.queries;

/** "Your reply" and "Send reply" under an open query (WkProfile board's Queries tab). */
export function ReplyForm({ queryId, again }: { queryId: string; again: boolean }) {
  const [state, action] = useActionState(replyToQueryAction, null);
  const id = useId();
  if (state?.ok) {
    return (
      <p
        role="status"
        data-testid="query-reply-sent"
        className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px] font-semibold"
      >
        {state.message}
      </p>
    );
  }
  const error = state && !state.ok ? state.message : undefined;
  return (
    <form action={action} noValidate className="flex flex-col gap-3" aria-label={copy.yourReply}>
      <input type="hidden" name="queryId" value={queryId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {again ? copy.addReply : copy.yourReply}
        </label>
        <textarea
          id={id}
          name="body"
          rows={5}
          required
          maxLength={QUERY_LIMITS.reply.max}
          aria-describedby={`${id}-hint`}
          className="min-h-32 w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
        <p id={`${id}-hint`} className="m-0 text-xs text-fg-muted">
          {copy.replyHint}
        </p>
      </div>
      <FormAlert message={error} />
      <SubmitButton size="lg" pendingLabel={copy.sending} className="h-14 font-display text-lg font-bold">
        {copy.send}
      </SubmitButton>
      <p className="m-0 text-[13px] text-fg-muted">{copy.note}</p>
    </form>
  );
}
