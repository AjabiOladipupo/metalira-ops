import "server-only";

import { z } from "zod";

import { checkpointScanPayloadSchema } from "@/lib/punches/checkpoint";
import { codeFromSqlState, type RecordCheckpointScanResult } from "@/lib/punches/codes";
import type { OwnContext } from "@/server/people/own-requests";

import { queueOwnerSchema } from "./punches";

/**
 * Patrol checkpoint scans from the worker app (slice 3.8).
 *
 * `runRecordCheckpointScan` sends one queued scan to public.record_checkpoint_scan with the
 * worker's own session. The database takes the worker and company from the session, resolves
 * the token among the session company's active checkpoints only, checks the worker is on a
 * shift at that site at the time of the scan, and works out the time, geofence and flags. The
 * queue's owner is only compared, here and again in SQL (`wrong_session`, retried later).
 *
 * Every failure comes back as a fixed code (src/lib/punches/codes.ts). Never log the token, the
 * location or the payload: logs carry codes and error names only.
 */

/** A plausible phone clock: 2020 to 2100, in ms. */
const epochMs = z
  .number()
  .int()
  .min(Date.UTC(2020, 0, 1))
  .max(Date.UTC(2100, 0, 1));

export const recordCheckpointScanSchema = z.object({
  owner: queueOwnerSchema,
  client_event_id: z.uuid(),
  payload: checkpointScanPayloadSchema,
  device_time: epochMs,
  timing: z.object({
    sent_device_time: epochMs.nullable(),
    elapsed_since_event_ms: z.number().int().min(-1e12).max(1e12).nullable(),
  }),
});

export type RecordCheckpointScanInput = z.input<typeof recordCheckpointScanSchema>;

type Ctx = Pick<OwnContext, "supabase" | "organisationId" | "workerId">;

const scannedSchema = z.object({
  id: z.uuid(),
  duplicate: z.boolean(),
  recorded_at: z.string(),
  geofence_result: z.enum(["inside", "near", "outside", "unknown"]),
  flags: z.array(z.string()),
  checkpoint_name: z.string().nullable(),
  site_name: z.string().nullable(),
});

export async function runRecordCheckpointScan(
  ctx: Ctx,
  input: unknown,
): Promise<RecordCheckpointScanResult> {
  const sameOwner = (owner: z.output<typeof queueOwnerSchema>) =>
    owner.organisationId === ctx.organisationId && owner.workerId === ctx.workerId;
  const parsed = recordCheckpointScanSchema.safeParse(input);
  if (!parsed.success) {
    // The owner first even on a bad payload, so a stranger's scan is never refused for good here.
    const owner = queueOwnerSchema.safeParse((input as { owner?: unknown } | null)?.owner);
    if (owner.success && !sameOwner(owner.data)) return { ok: false, code: "wrong_session" };
    return { ok: false, code: "invalid" };
  }
  const data = parsed.data;
  if (!sameOwner(data.owner)) return { ok: false, code: "wrong_session" };

  const { data: row, error } = await ctx.supabase.rpc("record_checkpoint_scan", {
    p_expected_organisation_id: data.owner.organisationId,
    p_expected_worker_id: data.owner.workerId,
    p_client_event_id: data.client_event_id,
    p_token: data.payload.token,
    p_device_time: new Date(data.device_time).toISOString(),
    p_sent_device_time:
      data.timing.sent_device_time === null
        ? (null as unknown as string)
        : new Date(data.timing.sent_device_time).toISOString(),
    p_elapsed_ms: data.timing.elapsed_since_event_ms as number,
    p_latitude: data.payload.latitude as number,
    p_longitude: data.payload.longitude as number,
    p_accuracy_m: data.payload.accuracy_m as number,
  });
  if (error) {
    const code = codeFromSqlState(error.code);
    if (code === "failed") console.error("workforce.scan_failed:", error.code ?? "unknown");
    return { ok: false, code };
  }
  const scanned = scannedSchema.safeParse(row);
  if (!scanned.success) {
    console.error("workforce.scan_failed: unexpected answer");
    return { ok: false, code: "failed" };
  }
  return {
    ok: true,
    punchId: scanned.data.id,
    duplicate: scanned.data.duplicate,
    recordedAt: scanned.data.recorded_at,
    geofence: scanned.data.geofence_result,
    flags: scanned.data.flags,
    checkpointName: scanned.data.checkpoint_name,
    siteName: scanned.data.site_name,
  };
}
