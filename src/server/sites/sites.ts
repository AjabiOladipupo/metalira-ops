import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import { pointEwkt, polygonEwkt } from "@/lib/geofence";
import { CLIENT_EDITORS } from "@/server/business/clients";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";

import {
  addCheckpointSchema,
  checkpointIdSchema,
  createSiteSchema,
  moveCheckpointSchema,
  renameCheckpointSchema,
  setGeofenceSchema,
  setSiteStatusSchema,
  updateSiteSchema,
} from "./schemas";

/**
 * Sites, geofences and QR checkpoints (slice 2.2), as `mutate()` specs. Every write uses the
 * signed-in user's own client, so RLS and the column grants apply again, and the row audit
 * triggers on `sites` and `site_checkpoints` log the before and after (never the QR token) in the
 * same transaction. The database keeps the geofence from the pin, radius or outline
 * (private.sites_before_write) and refuses bad shapes. Nothing here deletes: sites are archived and
 * checkpoints retired.
 */

/** Owner, admin and ops_manager write sites and checkpoints, as they write clients. */
export const SITE_EDITORS = CLIENT_EDITORS;

const DUPLICATE_SITE = "This client already has a site with this name.";
const DUPLICATE_CHECKPOINT = "This site already has a checkpoint with this name.";

const DB_REFUSALS: Record<string, { message: string; field?: string }> = {
  MLST1: {
    message: "The outline crosses itself. Draw it again around the site.",
    field: "outline",
  },
  MLST2: { message: "An outline can have 200 corners or fewer.", field: "outline" },
  MLST3: { message: "An outline can cover 4 square kilometres or less.", field: "outline" },
  MLST4: { message: "The geofence must be in Nigeria.", field: "lat" },
  MLST5: { message: "A site can't move to another client." },
  MLCP1: { message: "A retired checkpoint can't be changed. Add a new one." },
  MLCP2: { message: "This site is archived. Restore it to add checkpoints." },
  MLCP3: { message: "A checkpoint can't move to another site." },
  MLCP4: { message: "The checkpoint must be in Nigeria." },
};

/** Database refusals in plain English, under the field they belong to. */
export function fromSiteDbError(error: PostgrestError): never {
  const text = `${error.message} ${error.details ?? ""}`;
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", "That checkpoint wasn't found.");
  }
  const known = DB_REFUSALS[error.code];
  if (known) {
    throw new MutationError(
      "invalid",
      known.message,
      known.field ? { [known.field]: known.message } : {},
    );
  }
  if (error.code === "23505" && text.includes("sites_client_name_key")) {
    throw new MutationError("invalid", DUPLICATE_SITE, { name: DUPLICATE_SITE });
  }
  if (error.code === "23505" && text.includes("site_checkpoints_active_name_idx")) {
    throw new MutationError("invalid", DUPLICATE_CHECKPOINT, { name: DUPLICATE_CHECKPOINT });
  }
  if (error.code === "23514") {
    throw new MutationError("invalid", "Check the highlighted fields.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

const SITE_NOT_FOUND = "That site wasn't found.";
const CHECKPOINT_NOT_FOUND = "That checkpoint wasn't found.";

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const createSiteSpec: MutationSpec<
  typeof createSiteSchema,
  { id: string; clientId: string }
> = {
  schema: createSiteSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("sites")
      .insert({
        organisation_id: organisationId,
        client_id: data.clientId,
        name: data.name,
        address: data.address,
        state: data.state,
        landmark: data.landmark,
      })
      .select("id, client_id")
      .single();
    if (error) {
      if (error.code === "23503") throw new MutationError("invalid", "That client wasn't found.");
      fromSiteDbError(error);
    }
    return { id: row.id, clientId: row.client_id };
  },
};

export function createSite(input: unknown) {
  return mutate(createSiteSpec, input);
}

export const updateSiteSpec: MutationSpec<
  typeof updateSiteSchema,
  { id: string; clientId: string }
> = {
  schema: updateSiteSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("sites")
      .update({
        name: data.name,
        address: data.address,
        state: data.state,
        landmark: data.landmark,
      })
      .eq("id", data.siteId)
      .eq("organisation_id", organisationId)
      .select("id, client_id")
      .maybeSingle();
    if (error) fromSiteDbError(error);
    if (!row) throw new MutationError("invalid", SITE_NOT_FOUND);
    return { id: row.id, clientId: row.client_id };
  },
};

export function updateSite(input: unknown) {
  return mutate(updateSiteSpec, input);
}

/**
 * Sets the geofence: a pin with a radius, or a drawn outline (the database takes the pin from
 * inside the outline). Coordinates go to the database as EWKT built from validated numbers.
 */
export const setGeofenceSpec: MutationSpec<
  typeof setGeofenceSchema,
  { id: string; clientId: string }
> = {
  schema: setGeofenceSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { shape } = data;
    const patch =
      shape.kind === "circle"
        ? { centre: pointEwkt(shape.centre), radius_m: shape.radiusM, boundary: null }
        : { centre: null, radius_m: shape.radiusM, boundary: polygonEwkt(shape.points) };
    const { data: row, error } = await supabase
      .from("sites")
      .update(patch)
      .eq("id", data.siteId)
      .eq("organisation_id", organisationId)
      .select("id, client_id")
      .maybeSingle();
    if (error) fromSiteDbError(error);
    if (!row) throw new MutationError("invalid", SITE_NOT_FOUND);
    return { id: row.id, clientId: row.client_id };
  },
};

export function setGeofence(input: unknown) {
  return mutate(setGeofenceSpec, input);
}

/** Archive or restore. Archived sites keep their checkpoints, assignments and history. */
export const setSiteStatusSpec: MutationSpec<
  typeof setSiteStatusSchema,
  { id: string; clientId: string }
> = {
  schema: setSiteStatusSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("sites")
      .update({ status: data.status })
      .eq("id", data.siteId)
      .eq("organisation_id", organisationId)
      .select("id, client_id")
      .maybeSingle();
    if (error) fromSiteDbError(error);
    if (!row) throw new MutationError("invalid", SITE_NOT_FOUND);
    return { id: row.id, clientId: row.client_id };
  },
};

export function setSiteStatus(input: unknown) {
  return mutate(setSiteStatusSpec, input);
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/** Adds a checkpoint last in the site's round. The database makes its QR token. */
export const addCheckpointSpec: MutationSpec<typeof addCheckpointSchema, { id: string }> = {
  schema: addCheckpointSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("site_checkpoints")
      .insert({ organisation_id: organisationId, site_id: data.siteId, name: data.name })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23503") throw new MutationError("invalid", SITE_NOT_FOUND);
      fromSiteDbError(error);
    }
    return { id: row.id };
  },
};

export function addCheckpoint(input: unknown) {
  return mutate(addCheckpointSpec, input);
}

export const renameCheckpointSpec: MutationSpec<typeof renameCheckpointSchema, { id: string }> = {
  schema: renameCheckpointSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("site_checkpoints")
      .update({ name: data.name })
      .eq("id", data.checkpointId)
      .eq("organisation_id", organisationId)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (error) fromSiteDbError(error);
    if (!row) throw new MutationError("invalid", CHECKPOINT_NOT_FOUND);
    return { id: row.id };
  },
};

export function renameCheckpoint(input: unknown) {
  return mutate(renameCheckpointSpec, input);
}

/** Moves a checkpoint one place in the round; the site's round is renumbered in one go. */
export const moveCheckpointSpec: MutationSpec<typeof moveCheckpointSchema, { moved: number }> = {
  schema: moveCheckpointSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: moved, error } = await supabase.rpc("move_site_checkpoint", {
      p_organisation_id: organisationId,
      p_checkpoint_id: data.checkpointId,
      p_direction: data.direction,
    });
    if (error) fromSiteDbError(error);
    return { moved: moved ?? 0 };
  },
};

export function moveCheckpoint(input: unknown) {
  return mutate(moveCheckpointSpec, input);
}

/** Retires a checkpoint for good: its code stops counting, and its history stays. */
export const retireCheckpointSpec: MutationSpec<typeof checkpointIdSchema, { id: string }> = {
  schema: checkpointIdSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("site_checkpoints")
      .update({ status: "retired" })
      .eq("id", data.checkpointId)
      .eq("organisation_id", organisationId)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (error) fromSiteDbError(error);
    if (!row) throw new MutationError("invalid", CHECKPOINT_NOT_FOUND);
    return { id: row.id };
  },
};

export function retireCheckpoint(input: unknown) {
  return mutate(retireCheckpointSpec, input);
}

/**
 * Gives a checkpoint a new QR code, so a printout that leaked or went missing stops working.
 * The database makes the token and logs `checkpoint.qr_rotated` without it; nothing returns it.
 */
export const rotateCheckpointQrSpec: MutationSpec<typeof checkpointIdSchema, { id: string }> = {
  schema: checkpointIdSchema,
  roles: SITE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("rotate_checkpoint_qr", {
      p_organisation_id: organisationId,
      p_checkpoint_id: data.checkpointId,
    });
    if (error) fromSiteDbError(error);
    return { id: data.checkpointId };
  },
};

export function rotateCheckpointQr(input: unknown) {
  return mutate(rotateCheckpointQrSpec, input);
}
