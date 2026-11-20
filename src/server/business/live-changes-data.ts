import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { formatDate } from "@/lib/dates";
import type { LiveContract, LivePost, PostSite } from "@/lib/live-changes";
import type { RateCardVersion } from "@/lib/rate-cards";
import type { Database } from "@/types/db";

import { toRequirement, type PostRequirement } from "./activation-data";
import { loadRateCardVersions } from "./contracts-data";

/**
 * Reads for changes to a live contract (slice 2.8), with the signed-in user's own client and
 * scoped to the active organisation, so RLS decides: posts and requirements for every manager
 * role, contracts and the change log (`contract_changes`, with reasons) for owner, admin,
 * finance and ops_manager only.
 */

type Client = SupabaseClient<Database>;

const UUID = /^[0-9a-f-]{36}$/i;

export interface LiveContractRow extends LiveContract {
  id: string;
  clientId: string;
  clientName: string;
  clientArchived: boolean;
  name: string;
  reference: string;
}

export type ChangeKind = "requirement_changed" | "post_added" | "post_closed" | "site_added";

export interface ChangeEntry {
  id: string;
  kind: ChangeKind;
  postId: string | null;
  siteId: string | null;
  effectiveOn: string;
  reason: string | null;
  createdAt: string;
  /** "Raised to 2 people from 7 Dec 2026". */
  label: string;
}

export interface PostDetail {
  contract: LiveContractRow;
  post: LivePost & {
    contractId: string;
    siteId: string;
    siteName: string;
    role: string;
    band: string;
    unit: string;
  };
  /** Oldest first: every version, including closed ones. */
  versions: PostRequirement[];
  /** Newest first; empty for roles that can't read contracts. */
  changes: ChangeEntry[];
}

const CHANGE_LABEL: Record<ChangeKind, string> = {
  requirement_changed: "Headcount changed",
  post_added: "Post added",
  post_closed: "Post closed",
  site_added: "Site added",
};

function count(detail: unknown, side: "before" | "after"): number | null {
  if (typeof detail !== "object" || detail === null) return null;
  const part = (detail as Record<string, unknown>)[side];
  if (typeof part !== "object" || part === null) return null;
  const value = (part as Record<string, unknown>).count;
  return typeof value === "number" ? value : null;
}

/** One change log row as the history shows it. */
function toChange(row: {
  id: string;
  kind: string;
  post_id: string | null;
  site_id: string | null;
  effective_on: string;
  reason: string | null;
  created_at: string;
  detail: unknown;
}): ChangeEntry {
  const kind = row.kind as ChangeKind;
  let label = `${CHANGE_LABEL[kind]} from ${formatDate(row.effective_on)}`;
  if (kind === "post_closed") label = `Post closed after ${formatDate(row.effective_on)}`;
  if (kind === "requirement_changed") {
    const before = count(row.detail, "before");
    const after = count(row.detail, "after");
    if (before !== null && after !== null && before !== after) {
      label = `${before} → ${after} people from ${formatDate(row.effective_on)}`;
    } else {
      label = `Days or hours changed from ${formatDate(row.effective_on)}`;
    }
  }
  return {
    id: row.id,
    kind,
    postId: row.post_id,
    siteId: row.site_id,
    effectiveOn: row.effective_on,
    reason: row.reason,
    createdAt: row.created_at,
    label,
  };
}

/** The contract as the live-change planners need it, or null (missing, or hidden by RLS). */
export async function loadLiveContract(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<LiveContractRow | null> {
  if (!UUID.test(contractId)) return null;
  const { data, error } = await supabase
    .from("contracts")
    .select(
      "id, client_id, name, reference, status, type, go_live_date, end_date, end_reason, clients(name, status)",
    )
    .eq("organisation_id", organisationId)
    .eq("id", contractId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the contract: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    clientId: data.client_id,
    clientName: data.clients?.name ?? "",
    clientArchived: data.clients?.status === "archived",
    name: data.name,
    reference: data.reference,
    status: data.status as LiveContract["status"],
    type: data.type,
    goLiveDate: data.go_live_date,
    endDate: data.end_date,
    endReason: data.end_reason,
  };
}

/** One post with every requirement version and its change log. */
export async function loadPostDetail(
  supabase: Client,
  organisationId: string,
  postId: string,
): Promise<PostDetail | null> {
  if (!UUID.test(postId)) return null;
  const { data: row, error } = await supabase
    .from("posts")
    .select(
      "id, contract_id, site_id, name, role, band, unit, status, opened_on, closed_on, roster_requirements(id, effective_from, effective_to, days_of_week, start_time, end_time, required_count)",
    )
    .eq("organisation_id", organisationId)
    .eq("id", postId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the post: ${error.message}`);
  if (!row) return null;
  const [contract, changes, site] = await Promise.all([
    loadLiveContract(supabase, organisationId, row.contract_id),
    supabase
      .from("contract_changes")
      .select("id, kind, post_id, site_id, effective_on, reason, created_at, detail")
      .eq("organisation_id", organisationId)
      .eq("post_id", postId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("sites")
      .select("name")
      .eq("organisation_id", organisationId)
      .eq("id", row.site_id)
      .maybeSingle(),
  ]);
  if (!contract) return null;
  if (changes.error) throw new Error(`Could not read changes: ${changes.error.message}`);
  const versions = [...(row.roster_requirements ?? [])]
    .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))
    .map(toRequirement);
  return {
    contract,
    post: {
      id: row.id,
      contractId: row.contract_id,
      siteId: row.site_id,
      siteName: site.data?.name ?? "",
      name: row.name,
      role: row.role,
      band: row.band,
      unit: row.unit,
      status: row.status as LivePost["status"],
      openedOn: row.opened_on,
      closedOn: row.closed_on,
    },
    versions,
    changes: (changes.data ?? []).map(toChange),
  };
}

export interface AddPostContext {
  contract: LiveContractRow;
  sites: PostSite[];
  /** Open post names per site id. */
  openPostNames: Record<string, string[]>;
  rates: RateCardVersion[];
}

/**
 * What "Add post" needs: the contract's sites first, then the client's other sites in use (which
 * can be added with the post), the open post names per site, and the rate card versions.
 */
export async function loadAddPostContext(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<AddPostContext | null> {
  const contract = await loadLiveContract(supabase, organisationId, contractId);
  if (!contract) return null;
  const [linked, clientSites, posts, rates] = await Promise.all([
    supabase
      .from("contract_sites")
      .select("site_id")
      .eq("organisation_id", organisationId)
      .eq("contract_id", contractId),
    supabase
      .from("sites")
      .select("id, name, status, geofence_set_at")
      .eq("organisation_id", organisationId)
      .eq("client_id", contract.clientId)
      .limit(500),
    supabase
      .from("posts")
      .select("site_id, name")
      .eq("organisation_id", organisationId)
      .eq("contract_id", contractId)
      .eq("status", "open")
      .limit(1000),
    loadRateCardVersions(supabase, organisationId, contractId),
  ]);
  for (const result of [linked, clientSites, posts]) {
    if (result.error)
      throw new Error(`Could not read the contract's sites: ${result.error.message}`);
  }
  const on = new Set((linked.data ?? []).map((l) => l.site_id));
  const sites: PostSite[] = (clientSites.data ?? [])
    .map((s) => ({
      id: s.id,
      name: s.name,
      onContract: on.has(s.id),
      archived: s.status === "archived",
      hasGeofence: s.geofence_set_at !== null,
    }))
    // Archived sites only when already on the contract (so its posts still name them).
    .filter((s) => s.onContract || !s.archived)
    .sort((a, b) => Number(b.onContract) - Number(a.onContract) || a.name.localeCompare(b.name));
  const openPostNames: Record<string, string[]> = {};
  for (const p of posts.data ?? []) (openPostNames[p.site_id] ??= []).push(p.name);
  return { contract, sites, openPostNames, rates: rates.versions };
}

/** The live contract's change log, newest first (contract readers only; RLS hides it otherwise). */
export async function loadContractChanges(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<ChangeEntry[]> {
  if (!UUID.test(contractId)) return [];
  const { data, error } = await supabase
    .from("contract_changes")
    .select("id, kind, post_id, site_id, effective_on, reason, created_at, detail")
    .eq("organisation_id", organisationId)
    .eq("contract_id", contractId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not read changes: ${error.message}`);
  return (data ?? []).map(toChange);
}
