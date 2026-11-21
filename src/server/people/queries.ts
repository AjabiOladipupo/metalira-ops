import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  MAX_FOLLOW_UPS,
  MAX_WORKER_REPLIES,
  QUERY_KINDS,
  QUERY_LIMITS,
  isQueryOpen,
  isQueryOverdue,
  queryText,
  type QueryKind,
  type QueryStatus,
} from "@/lib/queries";
import type { ManagerRole } from "@/lib/roles";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { OwnContext } from "@/server/people/own-requests";
import type { Database } from "@/types/db";

/**
 * Queries and the HR file (slice 4.6, owner decision 10). Managers raise, follow up, close and
 * withdraw through `mutate()` (module people); the worker replies from the worker app with their
 * own session. Every write is one SQL function (public.raise_staff_query and the rest), which
 * checks the caller's role and session again, keeps replies insert-only and audits each status
 * move. Reads go through RLS: owner, admin and hr read every query, a line manager their current
 * reportees' and the ones they raised, the worker their own.
 */

type Client = SupabaseClient<Database>;

/** Who may raise, follow up and close queries (the database narrows line managers to reportees). */
export const QUERY_RAISERS = [
  "owner",
  "admin",
  "hr",
  "line_manager",
] as const satisfies readonly ManagerRole[];

/** Who sees the HR file section on the person page (line managers: their reportees only). */
export const HR_FILE_READERS = QUERY_RAISERS;

export interface QueryReplyView {
  id: string;
  authorRole: "worker" | "manager";
  authorName: string;
  body: string;
  createdAt: string;
}

export interface QueryView {
  id: string;
  workerId: string;
  kind: QueryKind;
  subject: string;
  body: string;
  replyBy: string;
  status: QueryStatus;
  raisedAt: string;
  raisedBy: string;
  raisedByName: string;
  firstRepliedAt: string | null;
  closedAt: string | null;
  outcomeNote: string | null;
  replies: QueryReplyView[];
}

const QUERY_COLUMNS =
  "id, worker_id, kind, subject, body, reply_by, status, raised_at, raised_by, raised_by_name, first_replied_at, closed_at, outcome_note, staff_query_replies ( id, author_role, author_name, body, created_at )";

type QueryRow = Database["public"]["Tables"]["staff_queries"]["Row"] & {
  staff_query_replies: Pick<
    Database["public"]["Tables"]["staff_query_replies"]["Row"],
    "id" | "author_role" | "author_name" | "body" | "created_at"
  >[];
};

function toView(row: QueryRow): QueryView {
  return {
    id: row.id,
    workerId: row.worker_id,
    kind: row.kind as QueryKind,
    subject: row.subject,
    body: row.body,
    replyBy: row.reply_by,
    status: row.status as QueryStatus,
    raisedAt: row.raised_at,
    raisedBy: row.raised_by,
    raisedByName: row.raised_by_name,
    firstRepliedAt: row.first_replied_at,
    closedAt: row.closed_at,
    outcomeNote: row.outcome_note,
    replies: [...(row.staff_query_replies ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((r) => ({
        id: r.id,
        authorRole: r.author_role === "worker" ? "worker" : "manager",
        authorName: r.author_name,
        body: r.body,
        createdAt: r.created_at,
      })),
  };
}

/** Open queries first (oldest reply-by first), then the rest, newest first. */
export function sortQueries(queries: readonly QueryView[]): QueryView[] {
  const open = queries
    .filter((q) => isQueryOpen(q.status))
    .sort((a, b) => a.replyBy.localeCompare(b.replyBy) || b.raisedAt.localeCompare(a.raisedAt));
  const done = queries
    .filter((q) => !isQueryOpen(q.status))
    .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  return [...open, ...done];
}

/**
 * One worker's queries with their replies, as the caller may read them (RLS): every query for
 * owner, admin and hr; for a line manager only while the worker reports to them, plus any they
 * raised; nothing for other roles.
 */
export async function loadWorkerQueries(
  supabase: Client,
  organisationId: string,
  workerId: string,
  limit = 50,
): Promise<QueryView[]> {
  const { data, error } = await supabase
    .from("staff_queries")
    .select(QUERY_COLUMNS)
    .eq("organisation_id", organisationId)
    .eq("worker_id", workerId)
    .order("raised_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read queries (${error.code})`);
  return sortQueries(((data ?? []) as QueryRow[]).map(toView));
}

/**
 * The queries a line manager may read about their team (My team, slice 4.7): RLS returns their
 * current reportees' queries and the ones they raised. Open first, then the rest.
 */
export async function loadTeamQueries(
  supabase: Client,
  organisationId: string,
  limit = 100,
): Promise<QueryView[]> {
  const { data, error } = await supabase
    .from("staff_queries")
    .select(QUERY_COLUMNS)
    .eq("organisation_id", organisationId)
    .order("raised_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read queries (${error.code})`);
  return sortQueries(((data ?? []) as QueryRow[]).map(toView));
}

/** The signed-in worker's own queries (worker app). */
export async function loadMyQueries(
  ctx: Pick<OwnContext, "supabase" | "organisationId" | "workerId">,
): Promise<QueryView[]> {
  return loadWorkerQueries(ctx.supabase, ctx.organisationId, ctx.workerId);
}

export interface QueriesSummary {
  /** Awaiting a reply or replied, not closed yet. */
  open: number;
  /** Still awaiting a reply after the reply-by date. */
  overdue: number;
  /** Replied and waiting for a manager to close. */
  replied: number;
  /** Raised in the last 30 days. */
  raisedLast30Days: number;
}

/** Counts of the queries the caller may read: numbers only, no names or text (for Lira). */
export async function loadQueriesSummary(
  supabase: Client,
  organisationId: string,
  today: string,
): Promise<QueriesSummary> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("staff_queries")
    .select("status, reply_by, raised_at")
    .eq("organisation_id", organisationId)
    .order("raised_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`Could not count queries (${error.code})`);
  const rows = (data ?? []).map((r) => ({
    status: r.status as QueryStatus,
    replyBy: r.reply_by,
    raisedAt: r.raised_at,
  }));
  return {
    open: rows.filter((r) => isQueryOpen(r.status)).length,
    overdue: rows.filter((r) => isQueryOverdue(r, today)).length,
    replied: rows.filter((r) => r.status === "replied").length,
    raisedLast30Days: rows.filter((r) => r.raisedAt >= since).length,
  };
}

// ---------------------------------------------------------------------------
// Refusals: the database's fixed codes in plain English
// ---------------------------------------------------------------------------

function fromDbError(error: PostgrestError, field?: string): never {
  const fieldErrors = (message: string) => (field ? { [field]: message } : {});
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", "Your role can't do this. Sign in again if it should.");
    case "P0002":
      throw new MutationError("invalid", "That employee or query wasn't found.");
    case "MLQY1": {
      const message = "Use plain text, without web addresses or long numbers.";
      throw new MutationError("invalid", message, fieldErrors(message));
    }
    case "MLQY2":
      throw new MutationError(
        "forbidden",
        "You can do this only for people who report to you, or for queries you raised.",
      );
    case "MLQY3":
      throw new MutationError("invalid", "This employee has left the company.");
    case "MLQY4":
      throw new MutationError("forbidden", "You can't raise or close a query about yourself.");
    case "MLQY5": {
      const message = "Choose a reply-by date from today to 60 days ahead.";
      throw new MutationError("invalid", message, { replyBy: message });
    }
    case "MLQY6":
      throw new MutationError("invalid", "This query is closed. It takes no more replies.");
    case "MLQY7":
      throw new MutationError(
        "invalid",
        `This query has reached its limit of ${MAX_WORKER_REPLIES} replies from the employee or ${MAX_FOLLOW_UPS} follow-ups. Close it and raise a new one if needed.`,
      );
  }
  throw new Error(`Database refused the query change (${error.code})`);
}

// ---------------------------------------------------------------------------
// Manager writes (mutate, module people)
// ---------------------------------------------------------------------------

export const raiseQuerySchema = z.object({
  workerId: z.uuid("Choose an employee"),
  kind: z.enum(QUERY_KINDS, "Choose the type of query"),
  subject: queryText("subject", QUERY_LIMITS.subject, false),
  body: queryText("query", QUERY_LIMITS.body, true),
  replyBy: z.iso.date("Choose a reply-by date"),
});

export interface RaisedQuery {
  id: string;
  /** The verified session's company, for the worker's notice. */
  organisationId: string;
  workerId: string;
  subject: string;
  replyBy: string;
}

export const raiseQuerySpec: MutationSpec<typeof raiseQuerySchema, RaisedQuery> = {
  module: "people",
  schema: raiseQuerySchema,
  roles: QUERY_RAISERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("raise_staff_query", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_kind: data.kind,
      p_subject: data.subject,
      p_body: data.body,
      p_reply_by: data.replyBy,
    });
    if (error) fromDbError(error, "body");
    return {
      id: id!,
      organisationId,
      workerId: data.workerId,
      subject: data.subject,
      replyBy: data.replyBy,
    };
  },
};

const queryIdField = z.uuid("Choose a query");

export const followUpQuerySchema = z.object({
  queryId: queryIdField,
  body: queryText("follow-up", QUERY_LIMITS.reply, true),
});

export interface QueryReplyResult {
  replyId: string;
  organisationId: string;
  queryId: string;
  workerId: string;
  subject: string;
  authorRole: "worker" | "manager";
}

const replyResult = z.object({
  reply_id: z.uuid(),
  query_id: z.uuid(),
  worker_id: z.uuid(),
  author_role: z.enum(["worker", "manager"]),
  subject: z.string(),
});

function toReplyResult(organisationId: string, raw: unknown): QueryReplyResult {
  const r = replyResult.parse(raw);
  return {
    replyId: r.reply_id,
    organisationId,
    queryId: r.query_id,
    workerId: r.worker_id,
    subject: r.subject,
    authorRole: r.author_role,
  };
}

export const followUpQuerySpec: MutationSpec<typeof followUpQuerySchema, QueryReplyResult> = {
  module: "people",
  schema: followUpQuerySchema,
  roles: QUERY_RAISERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("reply_to_staff_query", {
      p_organisation_id: organisationId,
      p_query_id: data.queryId,
      p_body: data.body,
    });
    if (error) fromDbError(error, "body");
    return toReplyResult(organisationId, result);
  },
};

export const closeQuerySchema = z.object({
  queryId: queryIdField,
  outcome: queryText("outcome", QUERY_LIMITS.outcome, true),
});

export interface ClosedQuery {
  queryId: string;
  organisationId: string;
  workerId: string;
  /** The query's subject, for the worker's notice (read back under RLS). */
  subject: string | null;
}

async function subjectOf(supabase: Client, organisationId: string, queryId: string) {
  const { data } = await supabase
    .from("staff_queries")
    .select("subject")
    .eq("organisation_id", organisationId)
    .eq("id", queryId)
    .maybeSingle();
  return data?.subject ?? null;
}

export const closeQuerySpec: MutationSpec<typeof closeQuerySchema, ClosedQuery> = {
  module: "people",
  schema: closeQuerySchema,
  roles: QUERY_RAISERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: workerId, error } = await supabase.rpc("close_staff_query", {
      p_organisation_id: organisationId,
      p_query_id: data.queryId,
      p_outcome: data.outcome,
    });
    if (error) fromDbError(error, "outcome");
    return {
      queryId: data.queryId,
      organisationId,
      workerId: workerId!,
      subject: await subjectOf(supabase, organisationId, data.queryId),
    };
  },
};

export const withdrawQuerySchema = z.object({
  queryId: queryIdField,
  reason: queryText("reason", QUERY_LIMITS.outcome, true),
});

export const withdrawQuerySpec: MutationSpec<typeof withdrawQuerySchema, ClosedQuery> = {
  module: "people",
  schema: withdrawQuerySchema,
  roles: QUERY_RAISERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: workerId, error } = await supabase.rpc("withdraw_staff_query", {
      p_organisation_id: organisationId,
      p_query_id: data.queryId,
      p_reason: data.reason,
    });
    if (error) fromDbError(error, "reason");
    return { queryId: data.queryId, organisationId, workerId: workerId!, subject: null };
  },
};

export const raiseQuery = (input: unknown) => mutate(raiseQuerySpec, input);
export const followUpQuery = (input: unknown) => mutate(followUpQuerySpec, input);
export const closeQuery = (input: unknown) => mutate(closeQuerySpec, input);
export const withdrawQuery = (input: unknown) => mutate(withdrawQuerySpec, input);

// ---------------------------------------------------------------------------
// The worker's reply (worker app, channel worker_app)
// ---------------------------------------------------------------------------

export const replyToQuerySchema = z.object({
  queryId: queryIdField,
  body: queryText("reply", QUERY_LIMITS.reply, true),
});

/**
 * The worker replies to their own query, with their own session (OwnContext: the organisation
 * comes from the verified session, never the form). The database checks the query is theirs.
 */
export async function runReplyToQuery(ctx: OwnContext, input: unknown): Promise<QueryReplyResult> {
  const parsed = replyToQuerySchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Check your reply.";
    throw new MutationError("invalid", message, { body: message });
  }
  const { data, error } = await ctx.supabase.rpc("reply_to_staff_query", {
    p_organisation_id: ctx.organisationId,
    p_query_id: parsed.data.queryId,
    p_body: parsed.data.body,
  });
  if (error) fromDbError(error, "body");
  return toReplyResult(ctx.organisationId, data);
}
