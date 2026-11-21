import type { Metadata } from "next";
import { Suspense } from "react";

import { Illustration } from "@/components/illustration";
import { formatDate, formatDateTime, lagosToday } from "@/lib/dates";
import { workerMessages } from "@/lib/messages/worker";
import { QUERY_KIND_LABELS, isQueryOpen, isQueryOverdue } from "@/lib/queries";
import { formatShortDay } from "@/lib/roster";
import { cn } from "@/lib/utils";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadMyQueries, type QueryView } from "@/server/people/queries";

import { WorkerTopBar } from "../../_components/worker-top-bar";
import { ReplyForm } from "./reply-form";

export const metadata: Metadata = { title: "Queries" };

const copy = workerMessages.queries;

/** The Lagos calendar day of a moment. */
const dayOf = (at: string) => lagosToday(new Date(at));

function QueryCard({ query, today }: { query: QueryView; today: string }) {
  const open = isQueryOpen(query.status);
  const overdue = isQueryOverdue(query, today);
  const answered = query.replies.some((r) => r.authorRole === "worker");
  return (
    <article
      data-testid="my-query"
      data-status={query.status}
      aria-labelledby={`q-${query.id}`}
      className={cn(
        "flex flex-col gap-3 rounded-xl p-4",
        open ? "border-[1.5px] border-foreground" : "border border-line",
      )}
    >
      {/* The reply-by date first (docs/PHASE_4.md 4.6). */}
      {open ? (
        <span className="text-[15px] font-semibold" data-testid="my-query-reply-by">
          {overdue ? copy.overdue(formatShortDay(query.replyBy)) : copy.replyBy(formatShortDay(query.replyBy))}
        </span>
      ) : null}
      <span className="type-label text-fg-muted">
        {copy.from(query.raisedByName, formatDate(dayOf(query.raisedAt)))}
        {workerMessages.separator}
        {QUERY_KIND_LABELS[query.kind]}
      </span>
      <h2 id={`q-${query.id}`} className="m-0 font-display text-xl font-bold break-words">
        {query.subject}
      </h2>
      <p className="m-0 text-[15px] leading-normal break-words whitespace-pre-line">{query.body}</p>

      {query.replies.length > 0 ? (
        <section aria-label={copy.replies} className="flex flex-col gap-2 border-t border-line pt-3">
          {query.replies.map((reply) => (
            <div key={reply.id} className="flex flex-col gap-0.5" data-testid="my-query-reply">
              <span className="text-xs text-fg-muted">
                {reply.authorRole === "worker" ? copy.you : reply.authorName}
                {workerMessages.separator}
                {formatDateTime(reply.createdAt)}
              </span>
              <p className="m-0 text-[15px] break-words whitespace-pre-line">{reply.body}</p>
            </div>
          ))}
        </section>
      ) : null}

      {query.status === "closed" ? (
        <div className="flex flex-col gap-0.5 rounded-lg bg-surface px-3 py-2.5">
          <span className="text-sm font-semibold">
            {copy.closed(formatDate(dayOf(query.closedAt ?? query.raisedAt)))}
          </span>
          {query.outcomeNote ? (
            <p className="m-0 text-sm break-words whitespace-pre-line">
              {copy.outcome}: {query.outcomeNote}
            </p>
          ) : null}
        </div>
      ) : null}
      {query.status === "withdrawn" ? (
        <span className="text-sm text-fg-muted">
          {copy.withdrawn(formatDate(dayOf(query.closedAt ?? query.raisedAt)))}
        </span>
      ) : null}

      {open ? <ReplyForm queryId={query.id} again={answered} /> : null}
    </article>
  );
}

async function Queries() {
  const session = await requireWorkerPageSession();
  const queries = await loadMyQueries({
    supabase: await createServerSupabase(),
    organisationId: session.organisationId,
    workerId: session.workerId,
  });
  if (queries.length === 0) {
    return (
      <section
        data-testid="queries-empty"
        className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3"
      >
        <p className="m-0 min-w-0 flex-1 text-[15px] text-fg-muted">{copy.empty}</p>
        <Illustration name="worker-profile" size="worker" decorative />
      </section>
    );
  }
  const today = lagosToday();
  return (
    <div className="flex flex-col gap-3.5">
      {queries.map((query) => (
        <QueryCard key={query.id} query={query} today={today} />
      ))}
    </div>
  );
}

/**
 * The worker's queries (slice 4.6), from the WkProfile board's Queries tab: open ones first with
 * the reply-by date on top, the query, any replies, and "Send reply". Closed and withdrawn ones
 * stay listed with their outcome.
 */
export default function QueriesPage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }} inbox>
          <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
        </WorkerTopBar>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Suspense fallback={<span aria-hidden className="block h-64 w-full rounded bg-surface" />}>
          <Queries />
        </Suspense>
      </div>
    </main>
  );
}
