import type { Metadata } from "next";
import { redirect } from "next/navigation";

import type { Board } from "@/lib/attendance-board";
import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";
import { getPageSession } from "@/server/identity/session";
import { BoardForbiddenError, loadAttendanceBoard } from "@/server/workforce/attendance-board";
import { canEditRoster } from "@/server/workforce/roster";

import { RouteGate } from "../_shell/slots";
import { LiveBoard } from "./_components/live-board";

export const metadata: Metadata = { title: "Live attendance" };

/**
 * Live attendance (slice 3.7): the first board is read on the server, then the screen asks again
 * every 30 seconds (attendanceBoardAction). Everything is worked out by public.attendance_board.
 */
async function AttendancePage() {
  const session = await getPageSession();
  if (!session?.active) redirect(NO_ACCESS_PATH);
  const { organisationId, role } = session.active;
  const supabase = await createServerSupabase();
  let board: Board;
  try {
    board = await loadAttendanceBoard(supabase, organisationId);
  } catch (error) {
    if (error instanceof BoardForbiddenError) redirect(NO_ACCESS_PATH);
    throw error;
  }
  return (
    <LiveBoard initial={board} organisationId={organisationId} canReplace={canEditRoster(role)} />
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/attendance">
      <AttendancePage />
    </RouteGate>
  );
}
