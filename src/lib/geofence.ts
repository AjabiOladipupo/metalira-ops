/**
 * Geofence maths for sites (slice 2.2), shared by the server's Zod schemas and the geofence editor.
 * Pure: no database, no map library. The database repeats every rule
 * (private.sites_before_write in 20261119120000_sites_geofence.sql); these give a clear message
 * first and let the editor show the area before saving.
 *
 * Points are { lat, lng } in degrees (WGS 84). Distances and areas are metres and square metres,
 * worked out on a local flat projection around the shape: well within a metre for shapes of a
 * few kilometres, which is all a site allows.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** A circle of `RADIUS_DEFAULT_M` around the pin unless the person chooses otherwise. */
export const RADIUS_MIN_M = 25;
export const RADIUS_MAX_M = 2000;
export const RADIUS_DEFAULT_M = 100;

export const OUTLINE_MAX_POINTS = 200;
export const OUTLINE_MAX_AREA_M2 = 4_000_000;

/** Nigeria's bounding box with a little margin, as in private.inside_nigeria. */
export const NIGERIA_BOUNDS = { minLat: 4.0, maxLat: 14.0, minLng: 2.5, maxLng: 14.8 } as const;

/** Lagos Island, where the map opens when a site has no pin yet. */
export const DEFAULT_MAP_CENTRE: LatLng = { lat: 6.4541, lng: 3.3947 };

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function insideNigeria(p: LatLng): boolean {
  return (
    p.lat >= NIGERIA_BOUNDS.minLat &&
    p.lat <= NIGERIA_BOUNDS.maxLat &&
    p.lng >= NIGERIA_BOUNDS.minLng &&
    p.lng <= NIGERIA_BOUNDS.maxLng
  );
}

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rounds a coordinate to 6 decimal places (about 11 cm), the precision stored. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Drops the closing point when the ring repeats its first point, and repeated neighbours. */
export function openRing(points: readonly LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || prev.lat !== p.lat || prev.lng !== p.lng) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && first.lat === last.lat && first.lng === last.lng) {
    out.pop();
  }
  return out;
}

/** Points in metres on a flat projection centred on the shape. */
function project(points: readonly LatLng[]): { x: number; y: number }[] {
  const lat0 = points.reduce((sum, p) => sum + p.lat, 0) / Math.max(points.length, 1);
  const lng0 = points.reduce((sum, p) => sum + p.lng, 0) / Math.max(points.length, 1);
  const kx = EARTH_RADIUS_M * Math.cos(toRad(lat0));
  return points.map((p) => ({
    x: toRad(p.lng - lng0) * kx,
    y: toRad(p.lat - lat0) * EARTH_RADIUS_M,
  }));
}

/** Area of the outline in square metres (open or closed ring). */
export function polygonAreaM2(points: readonly LatLng[]): number {
  const ring = project(openRing(points));
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

export function circleAreaM2(radiusM: number): number {
  return Math.PI * radiusM * radiusM;
}

type XY = { x: number; y: number };

function orientation(a: XY, b: XY, c: XY): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(a: XY, b: XY, c: XY): boolean {
  return (
    Math.min(a.x, c.x) - 1e-9 <= b.x &&
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    Math.min(a.y, c.y) - 1e-9 <= b.y &&
    b.y <= Math.max(a.y, c.y) + 1e-9
  );
}

function segmentsCross(p1: XY, q1: XY, p2: XY, q2: XY): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

/** True when two edges of the ring that don't share a corner touch or cross. */
export function selfIntersects(points: readonly LatLng[]): boolean {
  const ring = project(openRing(points));
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a1 = ring[i]!;
    const a2 = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j += 1) {
      // The first and last edges share the first corner.
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a1, a2, ring[j]!, ring[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

/** Why a radius can't be used, or null. */
export function radiusProblem(radiusM: number): string | null {
  if (!Number.isInteger(radiusM)) return "Enter the radius in whole metres";
  if (radiusM < RADIUS_MIN_M || radiusM > RADIUS_MAX_M) {
    return `The radius must be between ${RADIUS_MIN_M} and ${RADIUS_MAX_M.toLocaleString("en-NG")} metres`;
  }
  return null;
}

/** Why an outline can't be used, or null. The ring may be open or closed. */
export function outlineProblem(points: readonly LatLng[]): string | null {
  const ring = openRing(points);
  if (ring.length < 3) return "An outline needs at least 3 corners";
  if (ring.length > OUTLINE_MAX_POINTS) {
    return `An outline can have ${OUTLINE_MAX_POINTS} corners or fewer`;
  }
  if (!ring.every(insideNigeria)) return "The outline must be in Nigeria";
  if (selfIntersects(ring)) return "The outline crosses itself. Draw it again around the site";
  const area = polygonAreaM2(ring);
  if (area < 1) return "The outline has no area. Spread the corners around the site";
  if (area > OUTLINE_MAX_AREA_M2) return "An outline can cover 4 square kilometres or less";
  return null;
}

/** One number in degrees, as typed: "6.5244" or "-0.5". */
export function parseDegrees(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d{1,3}(\.\d{1,10})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** "6.5244, 3.3792" or "6.5244 3.3792" (latitude first, as maps copy them), or null. */
export function parseLatLng(text: string): LatLng | null {
  const parts = text.trim().split(/\s*[,;\s]\s*/);
  if (parts.length !== 2) return null;
  const lat = parseDegrees(parts[0]!);
  const lng = parseDegrees(parts[1]!);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** An outline typed one corner per line ("6.5244, 3.3792"). Blank lines are skipped. */
export function parseOutline(text: string): { points: LatLng[] } | { error: string } {
  const points: LatLng[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const p = parseLatLng(line);
    if (!p) return { error: `Line ${i + 1} isn't a latitude and longitude, like 6.5244, 3.3792` };
    points.push(p);
  }
  return { points: openRing(points) };
}

/** The outline as text for the editor, one corner per line. */
export function formatOutline(points: readonly LatLng[]): string {
  return openRing(points)
    .map((p) => `${roundCoordinate(p.lat)}, ${roundCoordinate(p.lng)}`)
    .join("\n");
}

const fixed = (value: number) =>
  roundCoordinate(value)
    .toFixed(6)
    .replace(/\.?0+$/, "");

/** EWKT for a geography(Point) column: longitude first. */
export function pointEwkt(p: LatLng): string {
  return `SRID=4326;POINT(${fixed(p.lng)} ${fixed(p.lat)})`;
}

/** EWKT for a geography(Polygon) column: one closed ring, longitude first. */
export function polygonEwkt(points: readonly LatLng[]): string {
  const ring = openRing(points);
  const first = ring[0];
  const closed = first ? [...ring, first] : ring;
  return `SRID=4326;POLYGON((${closed.map((p) => `${fixed(p.lng)} ${fixed(p.lat)}`).join(",")}))`;
}

/** "6.5244, 3.3792" */
export function formatLatLng(p: LatLng): string {
  return `${fixed(p.lat)}, ${fixed(p.lng)}`;
}

/** "3,142 m²" under a hectare, else "3.2 ha" (one decimal), else "1.25 km²". */
export function formatArea(m2: number): string {
  if (m2 < 10_000) return `${Math.round(m2).toLocaleString("en-NG")} m²`;
  if (m2 < 1_000_000)
    return `${(m2 / 10_000).toLocaleString("en-NG", { maximumFractionDigits: 1 })} ha`;
  return `${(m2 / 1_000_000).toLocaleString("en-NG", { maximumFractionDigits: 2 })} km²`;
}

/** Corners of a GeoJSON Polygon's outer ring, as stored in sites.boundary. */
export function pointsFromGeoJson(value: unknown): LatLng[] | null {
  if (!value || typeof value !== "object") return null;
  const geo = value as { type?: unknown; coordinates?: unknown };
  if (geo.type !== "Polygon" || !Array.isArray(geo.coordinates)) return null;
  const ring = geo.coordinates[0];
  if (!Array.isArray(ring)) return null;
  const points: LatLng[] = [];
  for (const pair of ring) {
    if (!Array.isArray(pair) || typeof pair[0] !== "number" || typeof pair[1] !== "number") {
      return null;
    }
    points.push({ lat: pair[1], lng: pair[0] });
  }
  return openRing(points);
}
