"use server";

import type { RecordCheckpointScanResult } from "@/lib/punches/codes";
import { MutationError } from "@/server/identity/mutate";
import { ownContext, type OwnContext } from "@/server/people/own-requests";

import { runRecordCheckpointScan } from "./checkpoint-scans";
import { loadClockContext } from "./clock-data";

/**
 * Server Actions behind patrol checkpoint scans (slice 3.8). The scan page (/m/checkpoint) asks
 * for the signed-in worker's context, then saves the scan in the offline queue, whose sender
 * calls `recordCheckpointScanAction` with the queue's owner. The token never travels in a URL
 * the server sees: only in this action's body. Answers are fixed codes only.
 *
 * Not `mutate()` specs: a scan is the worker's own (no manager role), like a clock-in. Shifts
 * (the module) is enforced by the database (`MLPU4`) and checked here for the screen.
 */

type OwnResult = { ok: true; ctx: OwnContext } | { ok: false; code: "signed_out" | "not_worker" };

async function own(): Promise<OwnResult> {
  try {
    return { ok: true, ctx: await ownContext() };
  } catch (error) {
    if (error instanceof MutationError && error.code === "unauthenticated") {
      return { ok: false, code: "signed_out" };
    }
    if (error instanceof MutationError) return { ok: false, code: "not_worker" };
    console.error("workforce.scan_session_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "signed_out" };
  }
}

/** What the scan page needs before it reads the location: whose queue, and whether it may. */
export type CheckpointScanContext =
  | {
      ok: true;
      organisationId: string;
      workerId: string;
      userId: string;
      shiftsEnabled: boolean;
      left: boolean;
      locationConsent: boolean;
    }
  | { ok: false; code: "signed_out" | "not_worker" | "failed" };

/** The signed-in worker, from the verified session (never from the page). */
export async function checkpointScanContextAction(): Promise<CheckpointScanContext> {
  const session = await own();
  if (!session.ok) return { ok: false, code: session.code };
  const { ctx } = session;
  try {
    const clock = await loadClockContext(ctx.supabase, ctx.organisationId);
    return {
      ok: true,
      organisationId: ctx.organisationId,
      workerId: ctx.workerId,
      userId: ctx.userId,
      shiftsEnabled: clock.shiftsEnabled,
      left: clock.left,
      locationConsent: clock.locationConsent,
    };
  } catch (error) {
    console.error("workforce.scan_context_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "failed" };
  }
}

/** Records one queued checkpoint scan. */
export async function recordCheckpointScanAction(
  input: unknown,
): Promise<RecordCheckpointScanResult> {
  const session = await own();
  if (!session.ok) return { ok: false, code: session.code };
  try {
    return await runRecordCheckpointScan(session.ctx, input);
  } catch (error) {
    console.error("workforce.scan_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "failed" };
  }
}
