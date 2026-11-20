import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { workerMessages } from "@/lib/messages/worker";
import { MutationError } from "@/server/identity/mutate";
import type { OwnContext } from "@/server/people/own-requests";
import type { Database } from "@/types/db";

/**
 * The worker inbox (slice 3.1), read and marked read with the worker's own session. The worker
 * can only set read_at on their own items (a column grant); the database stamps the time.
 */

type Client = SupabaseClient<Database>;

const copy = workerMessages.inbox;

/** Items shown on /m/inbox, newest first. Older ones stay in the table. */
export const INBOX_PAGE_SIZE = 50;

export interface InboxItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  linkPath: string | null;
  createdAt: string;
  readAt: string | null;
}

export async function loadMyInbox(supabase: Client, workerId: string): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from("inbox_items")
    .select("id, kind, title, body, link_path, created_at, read_at")
    .eq("worker_id", workerId)
    .order("created_at", { ascending: false })
    .limit(INBOX_PAGE_SIZE);
  if (error) throw new Error(`Could not load the inbox (${error.code})`);
  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    linkPath: row.link_path,
    createdAt: row.created_at,
    readAt: row.read_at,
  }));
}

/** How many unread items the worker has (for the dot on the header). */
export async function countMyUnread(supabase: Client, workerId: string): Promise<number> {
  const { count, error } = await supabase
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("worker_id", workerId)
    .is("read_at", null);
  if (error) throw new Error(`Could not count the inbox (${error.code})`);
  return count ?? 0;
}

export const markReadSchema = z.object({
  /** One item's id, or "all" for every unread item. */
  id: z.union([z.uuid(), z.literal("all")], { error: copy.failed }),
});

export async function runMarkRead(ctx: OwnContext, input: unknown): Promise<number> {
  const parsed = markReadSchema.safeParse(input);
  if (!parsed.success) throw new MutationError("invalid", copy.failed);
  let query = ctx.supabase
    .from("inbox_items")
    // The database replaces this with its own now().
    .update({ read_at: new Date().toISOString() })
    .eq("worker_id", ctx.workerId)
    .is("read_at", null);
  if (parsed.data.id !== "all") query = query.eq("id", parsed.data.id);
  const { data, error } = await query.select("id");
  if (error) {
    if (error.code === "42501") throw new MutationError("forbidden", copy.failed);
    throw new Error(`Could not mark read (${error.code})`);
  }
  return data?.length ?? 0;
}
