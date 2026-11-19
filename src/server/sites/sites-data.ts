import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

import { pointsFromGeoJson, type LatLng } from "@/lib/geofence";
import type { Database } from "@/types/db";

import type { SiteStatus } from "./schemas";

/**
 * Reads for the site screens (slice 2.2). Every query runs with the signed-in user's own client
 * and is scoped to the active organisation, so RLS decides what each role sees. Geography columns
 * come back from PostgREST as hex, so the shape is read through `public.site_geofences` as
 * numbers and GeoJSON. QR tokens are read only through `public.site_checkpoint_tokens`, which
 * returns nothing to anyone but owner, admin and ops_manager.
 */

type Client = SupabaseClient<Database>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GeofenceKind = "circle" | "outline" | null;

/** A site is ready for clock-in once it has an address and a geofence. */
export function siteNeedsDetails(site: { address: string | null; hasGeofence: boolean }): boolean {
  return !site.address || !site.hasGeofence;
}

export interface SiteRow {
  id: string;
  clientId: string;
  name: string;
  address: string | null;
  state: string | null;
  status: SiteStatus;
  geofence: GeofenceKind;
  radiusM: number;
  checkpointCount: number;
  needsDetails: boolean;
}

interface RawSite {
  id: string;
  client_id: string;
  name: string;
  address: string | null;
  state: string | null;
  status: string;
  geofence_set_at: string | null;
  boundary: unknown;
  radius_m: number;
  site_checkpoints?: { status: string }[] | null;
}

function toRow(s: RawSite): SiteRow {
  const geofence: GeofenceKind = s.geofence_set_at ? (s.boundary ? "outline" : "circle") : null;
  return {
    id: s.id,
    clientId: s.client_id,
    name: s.name,
    address: s.address,
    state: s.state,
    status: s.status as SiteStatus,
    geofence,
    radiusM: s.radius_m,
    checkpointCount: (s.site_checkpoints ?? []).filter((c) => c.status === "active").length,
    needsDetails: siteNeedsDetails({ address: s.address, hasGeofence: geofence !== null }),
  };
}

const SITE_COLUMNS =
  "id, client_id, name, address, state, status, geofence_set_at, boundary, radius_m, site_checkpoints(status)";

/** A client's sites, active first, each by name. */
export async function listClientSites(
  supabase: Client,
  organisationId: string,
  clientId: string,
): Promise<SiteRow[]> {
  if (!UUID.test(clientId)) return [];
  const { data, error } = await supabase
    .from("sites")
    .select(SITE_COLUMNS)
    .eq("organisation_id", organisationId)
    .eq("client_id", clientId)
    .order("name");
  if (error) throw new Error(`Could not read sites: ${error.message}`);
  const rows = (data ?? []).map((s) => toRow(s as RawSite));
  rows.sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived"));
  return rows;
}

export interface CheckpointRow {
  id: string;
  name: string;
  /** 1-based place in the round. */
  position: number;
  qrRotatedAt: string | null;
}

export interface SiteDetail extends SiteRow {
  clientName: string;
  clientStatus: string;
  landmark: string | null;
  centre: LatLng | null;
  outline: LatLng[] | null;
  areaM2: number | null;
  geofenceSetAt: string | null;
  checkpoints: CheckpointRow[];
  retiredCheckpointCount: number;
}

/** One site of a client with its geofence and checkpoints, or null when it isn't there. */
export async function loadSite(
  supabase: Client,
  organisationId: string,
  clientId: string,
  siteId: string,
): Promise<SiteDetail | null> {
  if (!UUID.test(siteId) || !UUID.test(clientId)) return null;
  const [site, shape, checkpoints] = await Promise.all([
    supabase
      .from("sites")
      .select(`${SITE_COLUMNS}, landmark, clients(name, status)`)
      .eq("organisation_id", organisationId)
      .eq("client_id", clientId)
      .eq("id", siteId)
      .maybeSingle(),
    supabase.rpc("site_geofences", { p_organisation_id: organisationId, p_site_id: siteId }),
    supabase
      .from("site_checkpoints")
      .select("id, name, status, sort_order, qr_rotated_at, created_at")
      .eq("organisation_id", organisationId)
      .eq("site_id", siteId)
      .order("sort_order")
      .order("created_at")
      .order("id"),
  ]);
  if (site.error) throw new Error(`Could not read the site: ${site.error.message}`);
  if (shape.error) throw new Error(`Could not read the geofence: ${shape.error.message}`);
  if (checkpoints.error) {
    throw new Error(`Could not read checkpoints: ${checkpoints.error.message}`);
  }
  const raw = site.data;
  if (!raw) return null;
  const row = toRow(raw as unknown as RawSite);
  const geo = shape.data?.[0];
  const client = raw.clients as { name: string; status: string } | null;
  const active = (checkpoints.data ?? []).filter((c) => c.status === "active");
  return {
    ...row,
    clientName: client?.name ?? "",
    clientStatus: client?.status ?? "active",
    landmark: raw.landmark,
    centre: geo ? { lat: geo.centre_lat, lng: geo.centre_lng } : null,
    outline: geo ? pointsFromGeoJson(geo.boundary) : null,
    areaM2: geo?.area_m2 ?? null,
    geofenceSetAt: raw.geofence_set_at,
    checkpoints: active.map((c, i) => ({
      id: c.id,
      name: c.name,
      position: i + 1,
      qrRotatedAt: c.qr_rotated_at,
    })),
    retiredCheckpointCount: (checkpoints.data ?? []).length - active.length,
  };
}

/**
 * The compact summary of an organisation's sites, for dashboards and later the ops agent
 * (docs/LIRA.md). Counts only: no names or addresses.
 */
export interface SitesSummary {
  /** Active sites of active clients. */
  active: number;
  archived: number;
  /** Active sites with no geofence: clock-in can't be checked there yet. */
  withoutGeofence: number;
  /** Active sites with no address or no geofence. */
  needsDetails: number;
  /** Active checkpoints across active sites. */
  checkpoints: number;
}

export function summariseSites(rows: readonly SiteRow[]): SitesSummary {
  const active = rows.filter((r) => r.status === "active");
  return {
    active: active.length,
    archived: rows.length - active.length,
    withoutGeofence: active.filter((r) => r.geofence === null).length,
    needsDetails: active.filter((r) => r.needsDetails).length,
    checkpoints: active.reduce((sum, r) => sum + r.checkpointCount, 0),
  };
}

const LIST_LIMIT = 5000;

/** Every site of the organisation's active clients. */
async function listActiveClientSites(supabase: Client, organisationId: string) {
  const { data, error } = await supabase
    .from("sites")
    .select(`${SITE_COLUMNS}, clients!inner(name, status)`)
    .eq("organisation_id", organisationId)
    .eq("clients.status", "active")
    .order("name")
    .limit(LIST_LIMIT);
  if (error) throw new Error(`Could not read sites: ${error.message}`);
  return (data ?? []).map((s) => ({
    row: toRow(s as unknown as RawSite),
    clientName: (s.clients as { name: string } | null)?.name ?? "",
  }));
}

export async function loadSitesSummary(
  supabase: Client,
  organisationId: string,
): Promise<SitesSummary> {
  const sites = await listActiveClientSites(supabase, organisationId);
  return summariseSites(sites.map((s) => s.row));
}

export interface SiteWithoutGeofence {
  siteId: string;
  siteName: string;
  clientId: string;
  clientName: string;
  href: string;
}

/** Active sites of active clients that have no geofence yet, by client then site. */
export async function listSitesWithoutGeofence(
  supabase: Client,
  organisationId: string,
): Promise<SiteWithoutGeofence[]> {
  const sites = await listActiveClientSites(supabase, organisationId);
  return sites
    .filter((s) => s.row.status === "active" && s.row.geofence === null)
    .map((s) => ({
      siteId: s.row.id,
      siteName: s.row.name,
      clientId: s.row.clientId,
      clientName: s.clientName,
      href: `/app/clients/${s.row.clientId}/sites/${s.row.id}`,
    }))
    .sort(
      (a, b) => a.clientName.localeCompare(b.clientName) || a.siteName.localeCompare(b.siteName),
    );
}

/**
 * Where a checkpoint's QR code points. The token is in the fragment, which browsers never send to
 * a server, so scans don't write it into request logs, history or Referer headers; the Phase 3
 * scan page reads it in the browser and posts it with the signed-in worker's session.
 */
export function checkpointUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/m/checkpoint#${token}`;
}

export interface CheckpointCard {
  id: string;
  name: string;
  position: number;
  /** data: URL of the QR code's SVG. */
  qr: string;
}

/**
 * The print sheet: one QR code per active checkpoint, in round order. Empty for anyone but owner,
 * admin and ops_manager (the database returns no tokens to them). The link itself is not put on
 * the page: the code is the only copy, and rotating it makes a new one.
 */
export async function loadCheckpointSheet(
  supabase: Client,
  organisationId: string,
  siteId: string,
  origin: string,
): Promise<CheckpointCard[]> {
  if (!UUID.test(siteId)) return [];
  const { data, error } = await supabase.rpc("site_checkpoint_tokens", {
    p_organisation_id: organisationId,
    p_site_id: siteId,
  });
  if (error) throw new Error(`Could not read checkpoints: ${error.message}`);
  return Promise.all(
    (data ?? []).map(async (c, i) => {
      const svg = await QRCode.toString(checkpointUrl(origin, c.qr_token), {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
      });
      return {
        id: c.checkpoint_id,
        name: c.name,
        position: i + 1,
        qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      };
    }),
  );
}
