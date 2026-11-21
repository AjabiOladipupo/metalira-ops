"use server";

import { runAttendanceBoard, type BoardResult } from "./attendance-board";

/**
 * The live attendance board's poll (slice 3.7), every 30 seconds from /app/attendance. Reads
 * only; the database function decides who sees what.
 */
export async function attendanceBoardAction(input: unknown): Promise<BoardResult> {
  return runAttendanceBoard(input);
}
