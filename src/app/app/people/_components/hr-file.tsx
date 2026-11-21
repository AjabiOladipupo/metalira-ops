"use client";

import { useActionState, useId } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Status, type StatusTone } from "@/components/status";
import { formatDate, formatDateTime } from "@/lib/dates";
import {
  QUERY_KINDS,
  QUERY_KIND_LABELS,
  QUERY_LIMITS,
  isQueryOpen,
  isQueryOverdue,
  queryStatusLabel,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  closeQueryAction,
  followUpQueryAction,
  raiseQueryAction,
  withdrawQueryAction,
} from "@/server/people/query-actions";
import type { QueryView } from "@/server/people/queries";

type Action = (prev: CompanyFormState, formData: FormData) => Promise<CompanyFormState>;

function tone(query: QueryView, today: string): StatusTone | null {
  if (isQueryOverdue(query, today)) return "action";
  if (query.status === "awaiting_reply") return "pending";
  if (query.status === "replied") return "action";
  if (query.status === "closed") return "done";
  return null;
}

/** A multi-line text box laid out like Field. */
function TextArea({
  label,
  name,
  hint,
  error,
  max,
  rows = 4,
  defaultValue,
}: {
  label: string;
  name: string;
  hint?: string;
  error?: string;
  max: number;
  rows?: number;
  defaultValue?: string;
}) {
  const id = useId();
  const note = error ?? hint;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        maxLength={max}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        className="min-h-24 w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-[15px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-foreground"
      />
      {note ? (
        <p
          id={`${id}-note`}
          className={cn("m-0 text-xs", error ? "font-medium text-foreground" : "text-fg-muted")}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** One action on an open query, behind a summary line: follow up, close or withdraw. */
function QueryActionForm({
  queryId,
  action,
  summary,
  field,
  label,
  hint,
  submit,
}: {
  queryId: string;
  action: Action;
  summary: string;
  field: "body" | "outcome" | "reason";
  label: string;
  hint: string;
  submit: string;
}) {
  const [state, formAction] = useActionState(action, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  const typed = state && !state.ok ? state.values : undefined;
  return (
    <details className="group rounded-lg border border-line" open={Boolean(typed)}>
      <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      <form
        key={JSON.stringify(typed ?? null)}
        action={formAction}
        noValidate
        aria-label={summary}
        className="flex flex-col gap-3 border-t border-line p-3"
      >
        <input type="hidden" name="queryId" value={queryId} />
        <TextArea
          label={label}
          name={field}
          hint={hint}
          max={field === "body" ? QUERY_LIMITS.reply.max : QUERY_LIMITS.outcome.max}
          rows={3}
          defaultValue={typed?.[field] ?? ""}
          error={state && !state.ok ? state.fieldErrors?.[field] : undefined}
        />
        <FormAlert message={state && !state.ok ? state.formError : undefined} />
        <div>
          <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
            {submit}
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}

export function QueryCard({
  query,
  today,
  canAct,
  isRaiser,
}: {
  query: QueryView;
  today: string;
  canAct: boolean;
  isRaiser: boolean;
}) {
  const open = isQueryOpen(query.status);
  const statusTone = tone(query, today);
  const status = queryStatusLabel(query, today);
  return (
    <article
      data-testid="hr-query"
      data-status={query.status}
      aria-labelledby={`hr-q-${query.id}`}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-line px-4 py-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h3 id={`hr-q-${query.id}`} className="m-0 text-[15px] font-semibold break-words">
          {QUERY_KIND_LABELS[query.kind]} · {query.subject}
        </h3>
        {statusTone ? (
          <Status tone={statusTone}>{status}</Status>
        ) : (
          <span className="text-sm text-fg-muted">{status}</span>
        )}
      </div>
      <p className="m-0 text-sm break-words whitespace-pre-line">{query.body}</p>
      <p className="m-0 text-[13px] text-fg-muted">
        Raised by {query.raisedByName} on {formatDateTime(query.raisedAt)} · reply needed by{" "}
        {formatDate(query.replyBy)}
      </p>

      {query.replies.length > 0 ? (
        <ol className="m-0 flex list-none flex-col gap-2 border-t border-line p-0 pt-2">
          {query.replies.map((reply) => (
            <li key={reply.id} className="flex flex-col gap-0.5" data-testid="hr-query-reply">
              <span className="text-xs text-fg-muted">
                {reply.authorRole === "worker" ? "Employee's reply" : "Follow-up"} ·{" "}
                {reply.authorName} · {formatDateTime(reply.createdAt)}
              </span>
              <p className="m-0 text-sm break-words whitespace-pre-line">{reply.body}</p>
            </li>
          ))}
        </ol>
      ) : null}

      {!open && query.outcomeNote ? (
        <p className="m-0 rounded-lg bg-surface px-3 py-2 text-sm break-words whitespace-pre-line">
          <span className="font-semibold">
            {query.status === "closed" ? "Outcome" : "Withdrawn"}
            {query.closedAt ? ` on ${formatDateTime(query.closedAt)}` : ""}:
          </span>{" "}
          {query.outcomeNote}
        </p>
      ) : null}

      {open && canAct ? (
        <div className="flex flex-col gap-2 pt-1">
          <QueryActionForm
            queryId={query.id}
            action={followUpQueryAction}
            summary="Add follow-up"
            field="body"
            label="Follow-up"
            hint="The employee sees it with the query and can reply again."
            submit="Add follow-up"
          />
          <QueryActionForm
            queryId={query.id}
            action={closeQueryAction}
            summary="Close query"
            field="outcome"
            label="Outcome"
            hint="What was decided. The employee sees it, and it stays on the HR file."
            submit="Close query"
          />
          {isRaiser ? (
            <QueryActionForm
              queryId={query.id}
              action={withdrawQueryAction}
              summary="Withdraw query"
              field="reason"
              label="Reason"
              hint="Why it is withdrawn, for example raised in error. It stays on the HR file."
              submit="Withdraw query"
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * "New query" (Team board): type, subject, what happened, reply-by date. On the HR file the
 * employee is fixed; on My team (slice 4.7) `workers` gives the Employee choice.
 */
export function RaiseQueryForm({
  workerId,
  workerName,
  workers,
  minDate,
  maxDate,
  defaultDate,
}: {
  workerId: string;
  workerName: string;
  /** The employees to choose from (My team); the fixed employee when left out. */
  workers?: readonly { id: string; name: string }[];
  minDate: string;
  maxDate: string;
  defaultDate: string;
}) {
  const [state, action] = useActionState(raiseQueryAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;
  return (
    <section
      aria-labelledby="hr-new-query"
      className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 rounded-xl border border-line p-5"
    >
      <h3 id="hr-new-query" className="m-0 type-h3">
        New query
      </h3>
      {state?.ok ? (
        <p role="status" className="m-0 rounded-lg bg-surface px-3 py-2.5 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <form
        key={state?.ok ? "sent" : JSON.stringify(typed ?? null)}
        action={action}
        noValidate
        aria-label={workers ? "New query" : `New query for ${workerName}`}
        className="flex flex-col gap-3"
      >
        {workers ? (
          <SelectField
            label="Employee"
            name="workerId"
            options={workers.map((w) => ({ value: w.id, label: w.name }))}
            defaultValue={typed?.workerId ?? workerId}
            error={errors?.workerId}
          />
        ) : (
          <input type="hidden" name="workerId" value={workerId} />
        )}
        <SelectField
          label="Type"
          name="kind"
          options={QUERY_KINDS.map((k) => ({ value: k, label: QUERY_KIND_LABELS[k] }))}
          defaultValue={typed?.kind ?? "lateness"}
          error={errors?.kind}
        />
        <Field
          label="Subject"
          name="subject"
          placeholder="For example, Lateness on 23 October"
          maxLength={QUERY_LIMITS.subject.max}
          defaultValue={typed?.subject ?? ""}
          error={errors?.subject}
        />
        <TextArea
          label="What happened"
          name="body"
          hint="Dates, times and what you saw. Stick to facts."
          max={QUERY_LIMITS.body.max}
          defaultValue={typed?.body ?? ""}
          error={errors?.body}
        />
        <Field
          label="Reply needed by"
          name="replyBy"
          type="date"
          min={minDate}
          max={maxDate}
          defaultValue={typed?.replyBy ?? defaultDate}
          error={errors?.replyBy}
        />
        <p className="m-0 text-[13px] text-fg-muted">
          The employee gets it in their app and can reply there. The query and reply go on their HR
          file.
        </p>
        <FormAlert message={state && !state.ok ? state.formError : undefined} />
        <SubmitButton pendingLabel="Sending…">Send query</SubmitButton>
      </form>
    </section>
  );
}

/**
 * The HR file's queries (slice 4.6): the list (open first) with replies, follow-up, close and
 * withdraw, and New query beside it, as on the Team board. Wraps to one column at 390px.
 */
export function HrFileQueries({
  queries,
  today,
  viewerUserId,
  canRaise,
  canAct,
  workerId,
  workerName,
  replyBy,
}: {
  queries: QueryView[];
  today: string;
  viewerUserId: string;
  /** May raise a new query here (an active employee, not the viewer themselves). */
  canRaise: boolean;
  /** May follow up and close (not the viewer's own record). */
  canAct: boolean;
  workerId: string;
  workerName: string;
  replyBy: { min: string; max: string; default: string };
}) {
  return (
    <div className="flex flex-wrap items-start gap-5">
      <section
        aria-labelledby="hr-queries"
        className="flex min-w-0 flex-[999_1_420px] flex-col gap-3"
      >
        <h3 id="hr-queries" className="m-0 type-h3">
          Queries
        </h3>
        {queries.length === 0 ? (
          <p
            data-testid="hr-queries-empty"
            className="m-0 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-fg-muted"
          >
            No queries on file.
          </p>
        ) : (
          queries.map((query) => (
            <QueryCard
              key={query.id}
              query={query}
              today={today}
              canAct={canAct}
              isRaiser={query.raisedBy === viewerUserId}
            />
          ))
        )}
      </section>
      {canRaise ? (
        <RaiseQueryForm
          workerId={workerId}
          workerName={workerName}
          minDate={replyBy.min}
          maxDate={replyBy.max}
          defaultDate={replyBy.default}
        />
      ) : null}
    </div>
  );
}
