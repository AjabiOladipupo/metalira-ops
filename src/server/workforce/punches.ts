import "server-only";

import { z } from "zod";

import {
  codeFromSqlState,
  type RecordPunchResult,
  type UploadSelfieResult,
} from "@/lib/punches/codes";
import { PUNCH_QUEUE_KINDS, punchPayloadSchema } from "@/lib/punches/clock";
import { SELFIE_MIME, selfiePath, selfieProblem, sniffSelfie } from "@/lib/punches/image-bytes";
import type { OwnContext } from "@/server/people/own-requests";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * Clock-in and clock-out from the worker app (slice 3.5).
 *
 * - `runRecordPunch` sends one queued punch to public.record_punch with the worker's own session.
 *   The database takes the worker and company from the session; the queue's owner (the ids the
 *   phone's queue was opened with) is only compared, here and again in SQL, so a punch saved by
 *   one worker is never recorded under another login (`wrong_session`, retried later).
 * - `runUploadSelfie` takes a punch's selfie: it checks the bytes (type from the magic bytes,
 *   200 KB at most), checks with the worker's own session that the punch is theirs and wants a
 *   selfie, checks Shifts is on and the login's hourly cap (begin_punch_selfie_upload), uploads it with the secret key to the punch's own path and records it through
 *   public.attach_punch_selfie (secret key only), which checks all of it again.
 *
 * Every failure comes back as a fixed code (src/lib/punches/codes.ts): never a database message,
 * a name or a place. Logs carry codes and error names only, never coordinates, paths or bytes.
 */

const PUNCH_PHOTOS_BUCKET = "punch-photos";

/** A plausible phone clock: 2020 to 2100, in ms. Anything else is refused as invalid. */
const epochMs = z
  .number()
  .int()
  .min(Date.UTC(2020, 0, 1))
  .max(Date.UTC(2100, 0, 1));

export const queueOwnerSchema = z.object({
  organisationId: z.uuid(),
  workerId: z.uuid(),
});

export const recordPunchSchema = z.object({
  owner: queueOwnerSchema,
  client_event_id: z.uuid(),
  kind: z.enum(["clock_in", "clock_out"]),
  payload: punchPayloadSchema,
  device_time: epochMs,
  timing: z.object({
    sent_device_time: epochMs.nullable(),
    elapsed_since_event_ms: z.number().int().min(-1e12).max(1e12).nullable(),
  }),
});

export type RecordPunchInput = z.input<typeof recordPunchSchema>;

type Ctx = Pick<OwnContext, "supabase" | "organisationId" | "workerId" | "userId">;

function sameOwner(ctx: Ctx, owner: z.output<typeof queueOwnerSchema>): boolean {
  return owner.organisationId === ctx.organisationId && owner.workerId === ctx.workerId;
}

const recordedSchema = z.object({
  id: z.uuid(),
  duplicate: z.boolean(),
  geofence_result: z.enum(["inside", "near", "outside", "unknown"]),
  flags: z.array(z.string()),
  selfie_wanted: z.boolean(),
});

export async function runRecordPunch(ctx: Ctx, input: unknown): Promise<RecordPunchResult> {
  const parsed = recordPunchSchema.safeParse(input);
  if (!parsed.success) {
    // The owner is checked first even on a bad payload, so a stranger's item is never refused
    // for good on this login.
    const owner = queueOwnerSchema.safeParse((input as { owner?: unknown } | null)?.owner);
    if (owner.success && !sameOwner(ctx, owner.data)) return { ok: false, code: "wrong_session" };
    return { ok: false, code: "invalid" };
  }
  const data = parsed.data;
  if (!sameOwner(ctx, data.owner)) return { ok: false, code: "wrong_session" };
  const payload = data.payload;
  const note = payload.outside_note?.trim() || null;

  const { data: row, error } = await ctx.supabase.rpc("record_punch", {
    p_expected_organisation_id: data.owner.organisationId,
    p_expected_worker_id: data.owner.workerId,
    p_client_event_id: data.client_event_id,
    p_kind: PUNCH_QUEUE_KINDS[data.kind],
    p_device_time: new Date(data.device_time).toISOString(),
    p_sent_device_time:
      data.timing.sent_device_time === null
        ? (null as unknown as string)
        : new Date(data.timing.sent_device_time).toISOString(),
    p_elapsed_ms: data.timing.elapsed_since_event_ms as number,
    p_site_id: payload.site_id as string,
    p_latitude: payload.latitude as number,
    p_longitude: payload.longitude as number,
    p_accuracy_m: payload.accuracy_m as number,
    p_outside_reason: payload.outside_reason as string,
    p_outside_note: note as string,
    p_has_selfie: data.kind === "clock_in" && payload.has_selfie,
  });
  if (error) {
    const code = codeFromSqlState(error.code);
    if (code === "failed") console.error("workforce.punch_failed:", error.code ?? "unknown");
    return { ok: false, code };
  }
  const recorded = recordedSchema.safeParse(row);
  if (!recorded.success) {
    console.error("workforce.punch_failed: unexpected answer");
    return { ok: false, code: "failed" };
  }
  return {
    ok: true,
    punchId: recorded.data.id,
    duplicate: recorded.data.duplicate,
    selfieWanted: recorded.data.selfie_wanted,
    geofence: recorded.data.geofence_result,
    flags: recorded.data.flags,
  };
}

export const uploadSelfieSchema = z.object({
  owner: queueOwnerSchema,
  punchId: z.uuid(),
});

/** Takes a punch's selfie. `photo` is the file from the form, read here once. */
export async function runUploadSelfie(
  ctx: Ctx,
  input: unknown,
  photo: Blob | null,
): Promise<UploadSelfieResult> {
  const parsed = uploadSelfieSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  if (!sameOwner(ctx, parsed.data.owner)) return { ok: false, code: "wrong_session" };
  if (!photo || photo.size === 0 || photo.size > 200 * 1024) {
    return { ok: false, code: "photo_invalid" };
  }
  const bytes = new Uint8Array(await photo.arrayBuffer());
  const ext = sniffSelfie(bytes);
  if (selfieProblem(bytes) !== null || ext === null) return { ok: false, code: "photo_invalid" };

  // The worker's own punch, read under RLS with their session.
  const { data: punch, error } = await ctx.supabase
    .from("punches")
    .select(
      "id, organisation_id, worker_id, kind, selfie_expected, selfie_path, selfie_deleted_at, created_at",
    )
    .eq("id", parsed.data.punchId)
    .eq("worker_id", ctx.workerId)
    .eq("organisation_id", ctx.organisationId)
    .maybeSingle();
  if (error) {
    console.error("workforce.selfie_failed:", error.code ?? "unknown");
    return { ok: false, code: "photo_failed" };
  }
  if (!punch) return { ok: false, code: "photo_refused" };
  if (punch.selfie_path) return { ok: true };
  if (punch.kind !== "in" || !punch.selfie_expected || punch.selfie_deleted_at) {
    return { ok: false, code: "photo_refused" };
  }

  const path = selfiePath({
    organisationId: punch.organisation_id,
    punchId: punch.id,
    createdAt: punch.created_at,
    ext,
  });
  const admin = createAdminSupabase({ channel: "worker_app" });
  // Shifts on for the punch's company, and at most 30 uploads an hour per login (review L3).
  const begun = await admin.rpc("begin_punch_selfie_upload", {
    p_punch_id: punch.id,
    p_actor: ctx.userId,
  });
  if (begun.error) {
    if (begun.error.code === "MLPS3") return { ok: false, code: "rate_limited" };
    if (begun.error.code === "MLPU4") return { ok: false, code: "shifts_off" };
    if (begun.error.code === "MLPS1") return { ok: false, code: "photo_refused" };
    console.error("workforce.selfie_failed:", begun.error.code ?? "unknown");
    return { ok: false, code: "photo_failed" };
  }
  const upload = await admin.storage.from(PUNCH_PHOTOS_BUCKET).upload(path, bytes, {
    contentType: SELFIE_MIME[ext],
    upsert: false,
  });
  // An earlier try may have uploaded it and failed to record it: the object checks below hold.
  if (upload.error && !/exist|duplicate/i.test(upload.error.message)) {
    console.error("workforce.selfie_failed: upload", upload.error.name);
    return { ok: false, code: "photo_failed" };
  }

  const attached = await admin.rpc("attach_punch_selfie", {
    p_punch_id: punch.id,
    p_actor: ctx.userId,
    p_path: path,
  });
  if (attached.error) {
    const refused = attached.error.code === "MLPS1" || attached.error.code === "MLPS2";
    if (refused) {
      await admin.storage.from(PUNCH_PHOTOS_BUCKET).remove([path]);
      return {
        ok: false,
        code: attached.error.code === "MLPS2" ? "photo_invalid" : "photo_refused",
      };
    }
    console.error("workforce.selfie_failed:", attached.error.code ?? "unknown");
    return { ok: false, code: "photo_failed" };
  }
  return { ok: true };
}

export { PUNCH_PHOTOS_BUCKET };
