import { z } from "zod";

import { NIGERIAN_STATES } from "@/lib/company";
import {
  RADIUS_DEFAULT_M,
  insideNigeria,
  outlineProblem,
  parseDegrees,
  parseOutline,
  radiusProblem,
  type LatLng,
} from "@/lib/geofence";
import { address, optional, text } from "@/server/business/schemas";

/**
 * Input for sites, geofences and checkpoints (slice 2.2). Flat objects keyed by the form's field
 * names, so `mutate()` puts each message under its field. The database repeats every check
 * (migration 20261119120000_sites_geofence); these give a clear message first.
 */

export const SITE_STATUSES = ["active", "archived"] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export const GEOFENCE_MODES = ["circle", "outline"] as const;
export type GeofenceMode = (typeof GEOFENCE_MODES)[number];

const id = (what: string) => z.uuid(`Choose a ${what}`);

export const siteNameSchema = text("Site name", 200);

const siteFields = {
  name: siteNameSchema,
  address: optional(address),
  state: optional(z.enum(NIGERIAN_STATES, "Choose a state")),
  landmark: optional(text("Landmark", 200)),
};

export const createSiteSchema = z.object({ clientId: id("client"), ...siteFields });
/** One of the company's own offices (slice 6.11): no client. */
export const createOfficeSchema = z.object({
  ...siteFields,
  name: text("Office name", 200),
});
export const updateSiteSchema = z.object({ siteId: id("site"), ...siteFields });

export const setSiteStatusSchema = z.object({
  siteId: id("site"),
  status: z.enum(SITE_STATUSES, "Choose active or archived"),
});

function degrees(label: string, max: number) {
  return z.string().transform((value, ctx) => {
    const parsed = parseDegrees(value);
    if (parsed === null || Math.abs(parsed) > max) {
      ctx.addIssue({
        code: "custom",
        message: `Enter the ${label}, like ${label === "latitude" ? "6.5244" : "3.3792"}`,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

const radius = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") return RADIUS_DEFAULT_M;
    const parsed = /^\d{1,5}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
    const problem = Number.isNaN(parsed)
      ? "Enter the radius in whole metres"
      : radiusProblem(parsed);
    if (problem) {
      ctx.addIssue({ code: "custom", message: problem });
      return z.NEVER;
    }
    return parsed;
  });

export type GeofenceShape =
  | { kind: "circle"; centre: LatLng; radiusM: number }
  | { kind: "outline"; points: LatLng[]; radiusM: number };

/**
 * A geofence: a pin and a radius (circle), or a drawn outline typed or clicked one corner per
 * line. The radius is kept with an outline, so switching back to a circle keeps it.
 */
export const setGeofenceSchema = z
  .object({
    siteId: id("site"),
    mode: z.enum(GEOFENCE_MODES, "Choose a circle or an outline"),
    lat: z.string().optional(),
    lng: z.string().optional(),
    radiusM: radius,
    outline: z.string().max(20_000, "That outline is too long").optional(),
  })
  .transform((value, ctx): { siteId: string; shape: GeofenceShape } => {
    if (value.mode === "circle") {
      const lat = degrees("latitude", 90).safeParse(value.lat ?? "");
      const lng = degrees("longitude", 180).safeParse(value.lng ?? "");
      if (!lat.success) {
        ctx.addIssue({ code: "custom", path: ["lat"], message: lat.error.issues[0]!.message });
      }
      if (!lng.success) {
        ctx.addIssue({ code: "custom", path: ["lng"], message: lng.error.issues[0]!.message });
      }
      if (!lat.success || !lng.success) return z.NEVER;
      const centre = { lat: lat.data, lng: lng.data };
      if (!insideNigeria(centre)) {
        ctx.addIssue({ code: "custom", path: ["lat"], message: "The pin must be in Nigeria" });
        return z.NEVER;
      }
      return { siteId: value.siteId, shape: { kind: "circle", centre, radiusM: value.radiusM } };
    }
    const parsed = parseOutline(value.outline ?? "");
    const problem = "error" in parsed ? parsed.error : outlineProblem(parsed.points);
    if (problem || "error" in parsed) {
      ctx.addIssue({ code: "custom", path: ["outline"], message: problem ?? "Check the outline" });
      return z.NEVER;
    }
    return {
      siteId: value.siteId,
      shape: { kind: "outline", points: parsed.points, radiusM: value.radiusM },
    };
  });

export const checkpointNameSchema = text("Checkpoint name", 100);

export const addCheckpointSchema = z.object({
  siteId: id("site"),
  name: checkpointNameSchema,
});

export const renameCheckpointSchema = z.object({
  checkpointId: id("checkpoint"),
  name: checkpointNameSchema,
});

/** Moves a checkpoint one place earlier or later in the round. */
export const moveCheckpointSchema = z.object({
  checkpointId: id("checkpoint"),
  direction: z.enum(["up", "down"], "Choose up or down"),
});

export const checkpointIdSchema = z.object({ checkpointId: id("checkpoint") });

export type CreateSiteInput = z.output<typeof createSiteSchema>;
export type CreateOfficeInput = z.output<typeof createOfficeSchema>;
export type UpdateSiteInput = z.output<typeof updateSiteSchema>;
export type SetGeofenceInput = z.output<typeof setGeofenceSchema>;
