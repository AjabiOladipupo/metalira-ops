import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  ATTENDANCE_STATUSES,
  emptyBoard,
  orderedFlags,
  type Board,
  type BoardRow,
} from "@/lib/attendance-board";
import type { ManagerRole } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Database } from "@/types/db";

/**
 * The live attendance board (slice 3.7): one call to public.attendance_board with the signed-in
 * user's own client. The database is the gate (owner, admin, hr, ops_manager; a line manager for
 * their reportees; 42501 for anyone else, another company or an untrusted session), works every
 * status out on read and returns phones only to roles that read them on the people record.
 */

type Client = SupabaseClient<Database>;

/** Who may open the board: the slice 3 access table's punch readers. */
export const BOARD_READERS: readonly ManagerRole[] = [
  "owner",
  "admin",
  "hr",
  "ops_manager",
  "line_manager",
];

export const boardInputSchema = z.object({ organisationId: z.uuid() });

const rowSchema = z.object({
  assignment_id: z.uuid(),
  shift_date: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  site_id: z.uuid(),
  site_name: z.string(),
  post_id: z.uuid(),
  post_name: z.string(),
  worker_id: z.uuid(),
  worker_name: z.string(),
  staff_id: z.string().nullable(),
  phone: z.string().nullable(),
  phone_last4: z.string().nullable(),
  published: z.boolean(),
  first_in_at: z.string().nullable(),
  last_punch_kind: z.enum(["in", "out"]).nullable(),
  last_punch_at: z.string().nullable(),
  punch_flags: z.array(z.string()).nullable(),
  by_supervisor: z.boolean(),
  status: z.enum(ATTENDANCE_STATUSES),
  late_minutes: z.number().int().nullable(),
  site_last_sync_at: z.string().nullable(),
  site_late_syncs: z.number().int(),
  board_at: z.string(),
  late_grace_minutes: z.number().int(),
  no_show_after_minutes: z.number().int(),
  time_zone: z.string(),
});

export class BoardForbiddenError extends Error {
  constructor() {
    super("Your role can't see live attendance.");
    this.name = "BoardForbiddenError";
  }
}

/** The board now, for the company. Throws BoardForbiddenError on 42501. */
export async function loadAttendanceBoard(supabase: Client, organisationId: string): Promise<Board> {
  const { data, error } = await supabase.rpc("attendance_board", {
    p_organisation_id: organisationId,
  });
  if (error) {
    if (error.code === "42501") throw new BoardForbiddenError();
    throw new Error(`Could not load live attendance (${error.code})`);
  }
  const parsed = z.array(rowSchema).parse(data ?? []);
  const first = parsed[0];
  if (!first) return emptyBoard(new Date().toISOString());
  return {
    at: first.board_at,
    timeZone: first.time_zone,
    lateGraceMinutes: first.late_grace_minutes,
    noShowAfterMinutes: first.no_show_after_minutes,
    rows: parsed.map(
      (r): BoardRow => ({
        assignmentId: r.assignment_id,
        shiftDate: r.shift_date,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        siteId: r.site_id,
        siteName: r.site_name,
        postId: r.post_id,
        postName: r.post_name,
        workerId: r.worker_id,
        workerName: r.worker_name,
        staffId: r.staff_id,
        phone: r.phone,
        phoneLast4: r.phone_last4,
        published: r.published,
        firstInAt: r.first_in_at,
        lastPunchKind: r.last_punch_kind,
        lastPunchAt: r.last_punch_at,
        flags: orderedFlags(r.punch_flags ?? []),
        bySupervisor: r.by_supervisor,
        status: r.status,
        lateMinutes: r.late_minutes,
        siteLastSyncAt: r.site_last_sync_at,
        siteLateSyncs: r.site_late_syncs,
      }),
    ),
  };
}

export type BoardResult = { ok: true; board: Board } | { ok: false; reason: "forbidden" | "failed" };

/**
 * One poll (every 30 seconds from the screen). One database call: the session is not loaded
 * again, because the function itself reads the caller from the session and refuses anyone who
 * isn't allowed, in this organisation, in a trusted session.
 */
export async function runAttendanceBoard(input: unknown): Promise<BoardResult> {
  const parsed = boardInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "forbidden" };
  try {
    const supabase = await createServerSupabase();
    return { ok: true, board: await loadAttendanceBoard(supabase, parsed.data.organisationId) };
  } catch (error) {
    if (error instanceof BoardForbiddenError) return { ok: false, reason: "forbidden" };
    console.error("workforce.board_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "failed" };
  }
}
