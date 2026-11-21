import { z } from "zod";

import { distanceM, type LatLng } from "@/lib/geofence";
import { hasPersonalNumberRun } from "@/lib/inbox";

import type { GeofenceResult, PunchKind } from "./flags";

/**
 * Clock-in and clock-out in the worker app (slice 3.5): the outside reasons, the worker's note,
 * the site preview and the queue's punch payloads. Isomorphic, no React.
 */

/** The reason chips on the outside-site screen (WkClock board), in order. */
export const OUTSIDE_REASONS = ["gate_locked", "errand", "location_wrong", "other"] as const;
export type OutsideReason = (typeof OUTSIDE_REASONS)[number];

export const OUTSIDE_REASON_LABELS: Record<OutsideReason, string> = {
  gate_locked: "Gate locked, waiting outside",
  errand: "Sent on an errand by supervisor",
  location_wrong: "Phone location is wrong",
  other: "Other",
};

export const NOTE_MAX = 280;

/** Why a worker's note can't be sent, or null. The database checks the same (punch_note_ok). */
export function noteProblem(note: string): string | null {
  const text = note.trim();
  if (text.length === 0) return null;
  if (text.length > NOTE_MAX) return `Keep it to ${NOTE_MAX} characters.`;
  // The database refuses the same characters (punch_note_ok); line breaks are not allowed.
  if (/[\u0001-\u001f\u007f-\u009f<>]/.test(text)) return "Use plain words only.";
  if (/(:\/\/|www\.)/i.test(text)) return "Leave out web addresses.";
  if (hasPersonalNumberRun(text)) return "Leave out phone and ID numbers.";
  return null;
}

/** One punch as the phone queues it (`clock_in` / `clock_out` in the offline queue). */
export const punchPayloadSchema = z.object({
  site_id: z.uuid().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  accuracy_m: z.number().min(0).max(1_000_000).nullable(),
  outside_reason: z.enum(OUTSIDE_REASONS).nullable(),
  outside_note: z
    .string()
    .max(NOTE_MAX * 2)
    .nullable()
    .refine((note) => note === null || noteProblem(note) === null),
  has_selfie: z.boolean(),
});

export type PunchPayload = z.output<typeof punchPayloadSchema>;

declare module "@/lib/offline/types" {
  interface QueuePayloads {
    clock_in: PunchPayload;
    clock_out: PunchPayload;
  }
}

export const PUNCH_QUEUE_KINDS = { clock_in: "in", clock_out: "out" } as const satisfies Record<
  string,
  PunchKind
>;
export type PunchQueueKind = keyof typeof PUNCH_QUEUE_KINDS;

export function isPunchQueueKind(kind: string): kind is PunchQueueKind {
  return kind === "clock_in" || kind === "clock_out";
}

/** A site the worker may clock in at, as the clock screen reads it (my_clock_context). */
export interface ClockSite {
  id: string;
  name: string;
  centre: LatLng | null;
  radiusM: number;
  /** Outline corners, when the site has one drawn. */
  boundary: LatLng[] | null;
  hasGeofence: boolean;
}

/** Ray casting on lat/lng: good enough for a site-sized outline, for the preview only. */
export function insidePolygon(point: LatLng, ring: readonly LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export interface SitePreview {
  /** Metres from the site's centre (or its nearest corner with no centre), or null. */
  distanceM: number | null;
  /** The phone's guess. The server decides; this only picks the screen to show. */
  result: GeofenceResult;
}

/**
 * Where the phone is against a site, for the screen only: inside the circle or outline, near
 * (within the reported accuracy of it), or outside. The server's private.site_geofence_check
 * decides what is recorded.
 */
export function previewSite(site: ClockSite, point: LatLng, accuracyM: number): SitePreview {
  const fromCentre = site.centre ? distanceM(site.centre, point) : null;
  const fromCorners = site.boundary?.length
    ? Math.min(...site.boundary.map((corner) => distanceM(corner, point)))
    : null;
  const distance = fromCentre ?? fromCorners;
  if (!site.hasGeofence || distance === null) return { distanceM: null, result: "unknown" };
  const inside = site.boundary?.length
    ? insidePolygon(point, site.boundary)
    : fromCentre !== null && fromCentre <= site.radiusM;
  if (inside) return { distanceM: Math.round(distance), result: "inside" };
  const edge = site.boundary?.length
    ? (fromCorners ?? Infinity)
    : Math.max(0, (fromCentre ?? Infinity) - site.radiusM);
  return {
    distanceM: Math.round(distance),
    result: edge <= Math.min(Math.max(accuracyM, 0), 5000) ? "near" : "outside",
  };
}

/** The site to check against: the shift's, else the nearest one the worker can use. */
export function pickSite(
  sites: readonly ClockSite[],
  preferredId: string | null,
  point: LatLng | null,
): ClockSite | null {
  const preferred = preferredId ? sites.find((site) => site.id === preferredId) : undefined;
  if (preferred) return preferred;
  if (!point) return sites[0] ?? null;
  let best: ClockSite | null = null;
  let bestDistance = Infinity;
  for (const site of sites) {
    const anchor = site.centre ?? site.boundary?.[0] ?? null;
    const d = anchor ? distanceM(anchor, point) : Infinity;
    if (d < bestDistance || best === null) {
      best = site;
      bestDistance = d;
    }
  }
  return best;
}

/** "40 m" or "1.2 km". */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
