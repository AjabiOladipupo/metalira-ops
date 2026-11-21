import "server-only";

import { z } from "zod";

import {
  codeFromSqlState,
  type RecordCrewPunchResult,
  type UploadSelfieResult,
} from "@/lib/punches/codes";
import { CREW_QUEUE_KINDS, crewPayloadSchema } from "@/lib/punches/crew";
import { SELFIE_MIME, selfiePath, selfieProblem, sniffSelfie } from "@/lib/punches/image-bytes";
import {
  MutationError,
  assertModuleOn,
  runMutation,
  type MutationSpec,
} from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";

import type { CrewSession } from "./crew-session";
import { PUNCH_PHOTOS_BUCKET } from "./punches";

/**
 * Crew clock-in by a supervisor (slice 3.6).
 *
 * - `runRecordCrewPunch` sends one queued crew punch to public.record_crew_punch with the
 *   supervisor's own session, through `recordCrewPunchSpec` (MutationSpec, module "shifts"). The
 *   database takes the company and the supervisor from the session and checks that each worker
 *   is in their crew and on a shift at the site now; the queue's owner is only compared, here
 *   and again in SQL (`wrong_session`, the item stays queued).
 * - `runUploadCrewPhoto` takes the batch's group photo under 3.5's selfie rules: the bytes are
 *   checked (type from the magic bytes, 200 KB at most), the batch is read with the supervisor's
 *   session, the file is uploaded with the secret key to the batch's own path and recorded
 *   through public.attach_crew_photo (secret key only), which checks it all again.
 *
 * Every failure is a fixed code (src/lib/punches/codes.ts). Logs carry codes and error names
 * only, never names, coordinates, paths or bytes.
 */

/** A plausible phone clock: 2020 to 2100, in ms. */
const epochMs = z
  .number()
  .int()
  .min(Date.UTC(2020, 0, 1))
  .max(Date.UTC(2100, 0, 1));

/** The queue's owner: the company and the supervisor's actor id (worker record or membership). */
export const crewOwnerSchema = z.object({
  organisationId: z.uuid(),
  workerId: z.uuid(),
});

export const recordCrewPunchSchema = z.object({
  owner: crewOwnerSchema,
  client_batch_id: z.uuid(),
  kind: z.enum(["crew_in", "crew_out"]),
  payload: crewPayloadSchema,
  device_time: epochMs,
  timing: z.object({
    sent_device_time: epochMs.nullable(),
    elapsed_since_event_ms: z.number().int().min(-1e12).max(1e12).nullable(),
  }),
});

export const uploadCrewPhotoSchema = z.object({
  owner: crewOwnerSchema,
  batchId: z.uuid(),
});

type Owner = z.output<typeof crewOwnerSchema>;

function sameOwner(session: CrewSession, owner: Owner): boolean {
  return (
    owner.organisationId.toLowerCase() === session.organisationId.toLowerCase() &&
    owner.workerId.toLowerCase() === session.actorId.toLowerCase()
  );
}

const recordedSchema = z.object({
  batch_id: z.uuid(),
  duplicate: z.boolean(),
  count: z.number().int(),
  photo_wanted: z.boolean(),
  geofence_result: z.enum(["inside", "near", "outside", "unknown"]),
});

/**
 * The change itself. `roles` is the line manager's: a worker-supervisor is the line manager of
 * their crew (workers.line_manager_worker_id), and record_crew_punch decides whom each caller
 * supervises. The database writes the punches' and the batch's audit rows and the named
 * `crew.clocked_in` / `crew.clocked_out` event in the same transaction, so there is no `event`.
 */
export const recordCrewPunchSpec: MutationSpec<
  typeof recordCrewPunchSchema,
  RecordCrewPunchResult
> = {
  schema: recordCrewPunchSchema,
  roles: ["line_manager"],
  channel: "worker_app",
  module: "shifts",
  async run({ supabase, data }) {
    const payload = data.payload;
    const { data: row, error } = await supabase.rpc("record_crew_punch", {
      p_expected_organisation_id: data.owner.organisationId,
      p_expected_actor_id: data.owner.workerId,
      p_client_batch_id: data.client_batch_id,
      p_kind: CREW_QUEUE_KINDS[data.kind],
      p_site_id: payload.site_id,
      p_device_time: new Date(data.device_time).toISOString(),
      p_sent_device_time:
        data.timing.sent_device_time === null
          ? (null as unknown as string)
          : new Date(data.timing.sent_device_time).toISOString(),
      p_elapsed_ms: data.timing.elapsed_since_event_ms as number,
      p_worker_ids: payload.entries.map((e) => e.worker_id),
      p_client_event_ids: payload.entries.map((e) => e.client_event_id),
      p_latitude: payload.latitude as number,
      p_longitude: payload.longitude as number,
      p_accuracy_m: payload.accuracy_m as number,
      p_has_photo: data.kind === "crew_in" && payload.has_photo,
    });
    if (error) {
      const code = codeFromSqlState(error.code);
      if (code === "failed") console.error("workforce.crew_punch_failed:", error.code ?? "unknown");
      return { ok: false, code };
    }
    const recorded = recordedSchema.safeParse(row);
    if (!recorded.success) {
      console.error("workforce.crew_punch_failed: unexpected answer");
      return { ok: false, code: "failed" };
    }
    return {
      ok: true,
      batchId: recorded.data.batch_id,
      duplicate: recorded.data.duplicate,
      count: recorded.data.count,
      photoWanted: recorded.data.photo_wanted,
      geofence: recorded.data.geofence_result,
    };
  },
};

export async function runRecordCrewPunch(
  session: CrewSession,
  input: unknown,
): Promise<RecordCrewPunchResult> {
  // The owner first, even on a bad payload, so another login's item is never refused for good.
  const owner = crewOwnerSchema.safeParse((input as { owner?: unknown } | null)?.owner);
  if (owner.success && !sameOwner(session, owner.data)) return { ok: false, code: "wrong_session" };
  if (!owner.success) return { ok: false, code: "invalid" };
  try {
    await assertModuleOn(session.supabase, session.organisationId, "shifts");
  } catch (error) {
    if (error instanceof MutationError && error.code === "forbidden") {
      return { ok: false, code: "shifts_off" };
    }
    throw error;
  }
  try {
    return await runMutation(
      {
        supabase: session.supabase,
        userId: session.userId,
        organisationId: session.organisationId,
        role: "line_manager",
      },
      recordCrewPunchSpec,
      input,
    );
  } catch (error) {
    if (error instanceof MutationError && error.code === "invalid") {
      return { ok: false, code: "invalid" };
    }
    throw error;
  }
}

/** Takes a batch's group photo. `photo` is the file from the form, read here once. */
export async function runUploadCrewPhoto(
  session: CrewSession,
  input: unknown,
  photo: Blob | null,
): Promise<UploadSelfieResult> {
  const parsed = uploadCrewPhotoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  if (!sameOwner(session, parsed.data.owner)) return { ok: false, code: "wrong_session" };
  if (!photo || photo.size === 0 || photo.size > 200 * 1024) {
    return { ok: false, code: "photo_invalid" };
  }
  const bytes = new Uint8Array(await photo.arrayBuffer());
  const ext = sniffSelfie(bytes);
  if (selfieProblem(bytes) !== null || ext === null) return { ok: false, code: "photo_invalid" };

  // The supervisor's own batch, read under RLS with their session.
  const { data: batch, error } = await session.supabase
    .from("crew_punch_batches")
    .select(
      "id, organisation_id, recorded_by_user, kind, photo_expected, photo_path, photo_deleted_at, created_at",
    )
    .eq("id", parsed.data.batchId)
    .eq("organisation_id", session.organisationId)
    .eq("recorded_by_user", session.userId)
    .maybeSingle();
  if (error) {
    console.error("workforce.crew_photo_failed:", error.code ?? "unknown");
    return { ok: false, code: "photo_failed" };
  }
  if (!batch) return { ok: false, code: "photo_refused" };
  if (batch.photo_path) return { ok: true };
  if (batch.kind !== "in" || !batch.photo_expected || batch.photo_deleted_at) {
    return { ok: false, code: "photo_refused" };
  }

  const path = selfiePath({
    organisationId: batch.organisation_id,
    punchId: batch.id,
    createdAt: batch.created_at,
    ext,
  });
  const admin = createAdminSupabase({ channel: "worker_app" });
  // 3.5's upload gate, with a punch of this batch: Shifts on for its company and at most 30
  // uploads an hour per login (selfies and group photos together).
  const first = await admin
    .from("punches")
    .select("id")
    .eq("organisation_id", batch.organisation_id)
    .eq("crew_batch_id", batch.id)
    .limit(1)
    .maybeSingle();
  if (first.error || !first.data) {
    if (first.error) console.error("workforce.crew_photo_failed:", first.error.code ?? "unknown");
    return { ok: false, code: first.error ? "photo_failed" : "photo_refused" };
  }
  const begun = await admin.rpc("begin_punch_selfie_upload", {
    p_punch_id: first.data.id,
    p_actor: session.userId,
  });
  if (begun.error) {
    if (begun.error.code === "MLPS3") return { ok: false, code: "rate_limited" };
    if (begun.error.code === "MLPU4") return { ok: false, code: "shifts_off" };
    if (begun.error.code === "MLPS1") return { ok: false, code: "photo_refused" };
    console.error("workforce.crew_photo_failed:", begun.error.code ?? "unknown");
    return { ok: false, code: "photo_failed" };
  }
  const upload = await admin.storage.from(PUNCH_PHOTOS_BUCKET).upload(path, bytes, {
    contentType: SELFIE_MIME[ext],
    upsert: false,
  });
  if (upload.error && !/exist|duplicate/i.test(upload.error.message)) {
    console.error("workforce.crew_photo_failed: upload", upload.error.name);
    return { ok: false, code: "photo_failed" };
  }

  const attached = await admin.rpc("attach_crew_photo", {
    p_batch_id: batch.id,
    p_actor: session.userId,
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
    console.error("workforce.crew_photo_failed:", attached.error.code ?? "unknown");
    return { ok: false, code: "photo_failed" };
  }
  return { ok: true };
}
