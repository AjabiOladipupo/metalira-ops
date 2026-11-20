import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { planActivation, type ActivationPlan, type ActivationSite } from "@/lib/activation";
import { addDays, LAGOS_TIME_ZONE, todayIn } from "@/lib/dates";
import { formatDays, formatHours, toHourMinute } from "@/lib/headcount";
import type { Database } from "@/types/db";

import type { ContractStatus, ContractType } from "./contract-schemas";
import { loadRateCardVersions } from "./contracts-data";
import { loadHeadcount } from "./headcount-data";

/**
 * Reads for activation, posts and required shifts (slice 2.7). Every query runs with the
 * signed-in user's own client and is scoped to the active organisation, so RLS decides who sees
 * what: contracts and contacts for owner, admin, finance and ops_manager; posts, requirements
 * and required shifts for every manager role.
 */

type Client = SupabaseClient<Database>;

const UUID = /^[0-9a-f-]{36}$/i;

/** The company's calendar day in its own time zone, as `private.org_today` gives it. */
export async function companyToday(supabase: Client, organisationId: string): Promise<string> {
  const { data } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", organisationId)
    .maybeSingle();
  return todayIn(data?.timezone ?? LAGOS_TIME_ZONE);
}

export interface ActivationContext {
  contract: {
    id: string;
    clientId: string;
    name: string;
    reference: string;
    status: ContractStatus;
    type: ContractType;
    startDate: string;
    endDate: string | null;
    goLiveDate: string | null;
    endReason: string | null;
  };
  clientName: string;
  clientArchived: boolean;
  hasBillingContact: boolean;
  sites: ActivationSite[];
}

/** What the activation checklist needs, or null when the contract isn't there (or RLS hides it). */
export async function loadActivationContext(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<ActivationContext | null> {
  if (!UUID.test(contractId)) return null;
  const { data: row, error } = await supabase
    .from("contracts")
    .select(
      "id, client_id, name, reference, status, type, start_date, end_date, go_live_date, end_reason, clients(name, status), contract_sites(sites(id, name, status, geofence_set_at))",
    )
    .eq("organisation_id", organisationId)
    .eq("id", contractId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the contract: ${error.message}`);
  if (!row) return null;
  const { count, error: contactError } = await supabase
    .from("client_contacts")
    .select("id", { count: "exact", head: true })
    .eq("organisation_id", organisationId)
    .eq("client_id", row.client_id)
    .eq("role", "billing")
    .eq("status", "active");
  if (contactError) throw new Error(`Could not read contacts: ${contactError.message}`);
  const sites = (row.contract_sites ?? [])
    .map((cs) => cs.sites)
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => ({
      id: s.id,
      name: s.name,
      archived: s.status === "archived",
      hasGeofence: s.geofence_set_at !== null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    contract: {
      id: row.id,
      clientId: row.client_id,
      name: row.name,
      reference: row.reference,
      status: row.status as ContractStatus,
      type: row.type as ContractType,
      startDate: row.start_date,
      endDate: row.end_date,
      goLiveDate: row.go_live_date,
      endReason: row.end_reason,
    },
    clientName: row.clients?.name ?? "",
    clientArchived: row.clients?.status === "archived",
    hasBillingContact: (count ?? 0) > 0,
    sites,
  };
}

/** The checklist and preview for "Activate contract" (pure `planActivation` over live data). */
export async function loadActivationPlan(
  supabase: Client,
  organisationId: string,
  contractId: string,
  options: { today?: string; goLiveDate?: string | null } = {},
): Promise<{ context: ActivationContext; plan: ActivationPlan } | null> {
  const [context, rates, headcount, today] = await Promise.all([
    loadActivationContext(supabase, organisationId, contractId),
    loadRateCardVersions(supabase, organisationId, contractId),
    loadHeadcount(supabase, organisationId, contractId),
    options.today ? Promise.resolve(options.today) : companyToday(supabase, organisationId),
  ]);
  if (!context) return null;
  const plan = planActivation({
    contract: context.contract,
    today,
    goLiveDate: options.goLiveDate ?? null,
    clientArchived: context.clientArchived,
    hasBillingContact: context.hasBillingContact,
    sites: context.sites,
    versions: rates.versions,
    headcount,
  });
  return { context, plan };
}

export interface PostRequirement {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  requiredCount: number;
  /** "Every day", "Mon–Fri". */
  days: string;
  /** "18:00–06:00 (next day)". */
  hours: string;
}

export interface PostRow {
  id: string;
  name: string;
  siteId: string;
  siteName: string;
  role: string;
  band: string;
  unit: string;
  status: "open" | "closed";
  openedOn: string;
  closedOn: string | null;
  closedReason: string | null;
  /** The requirement in force today, else the next one to start, else the last one. */
  current: PostRequirement | null;
  /** Oldest first. */
  requirements: PostRequirement[];
}

interface RequirementDbRow {
  id: string;
  effective_from: string;
  effective_to: string | null;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  required_count: number;
}

function toRequirement(row: RequirementDbRow): PostRequirement {
  const startTime = toHourMinute(row.start_time);
  const endTime = toHourMinute(row.end_time);
  const daysOfWeek = [...row.days_of_week].sort((a, b) => a - b);
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    daysOfWeek,
    startTime,
    endTime,
    requiredCount: row.required_count,
    days: formatDays(daysOfWeek),
    hours: formatHours({ startTime, endTime }),
  };
}

/** One contract's posts with their requirements, by site then name. */
export async function loadPosts(
  supabase: Client,
  organisationId: string,
  contractId: string,
  today: string,
): Promise<PostRow[]> {
  if (!UUID.test(contractId)) return [];
  const { data, error } = await supabase
    .from("posts")
    .select(
      "id, name, site_id, role, band, unit, status, opened_on, closed_on, closed_reason, sites(name), roster_requirements(id, effective_from, effective_to, days_of_week, start_time, end_time, required_count)",
    )
    .eq("organisation_id", organisationId)
    .eq("contract_id", contractId)
    .limit(1000);
  if (error) throw new Error(`Could not read posts: ${error.message}`);
  return (data ?? [])
    .map((row) => {
      const requirements = [...(row.roster_requirements ?? [])]
        .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))
        .map(toRequirement);
      const current =
        requirements.find(
          (r) => r.effectiveFrom <= today && (r.effectiveTo === null || r.effectiveTo >= today),
        ) ??
        requirements.find((r) => r.effectiveFrom > today) ??
        requirements[requirements.length - 1] ??
        null;
      return {
        id: row.id,
        name: row.name,
        siteId: row.site_id,
        siteName: row.sites?.name ?? "",
        role: row.role,
        band: row.band,
        unit: row.unit,
        status: row.status as "open" | "closed",
        openedOn: row.opened_on,
        closedOn: row.closed_on,
        closedReason: row.closed_reason,
        current,
        requirements,
      };
    })
    .sort((a, b) => a.siteName.localeCompare(b.siteName) || a.name.localeCompare(b.name));
}

export interface RequiredShiftRow {
  requirementId: string;
  postId: string;
  siteId: string;
  contractId: string;
  postName: string;
  role: string;
  band: string;
  date: string;
  startsAt: string;
  endsAt: string;
  requiredCount: number;
}

/** `required_shifts` for the organisation from `from` to `to` (62 days at most). */
export async function loadRequiredShifts(
  supabase: Client,
  organisationId: string,
  from: string,
  to: string,
): Promise<RequiredShiftRow[]> {
  const { data, error } = await supabase.rpc("required_shifts", {
    p_organisation_id: organisationId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`Could not read required shifts: ${error.message}`);
  return (data ?? []).map((r) => ({
    requirementId: r.requirement_id,
    postId: r.post_id,
    siteId: r.site_id,
    contractId: r.contract_id,
    postName: r.post_name,
    role: r.role,
    band: r.band,
    date: r.shift_date,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    requiredCount: r.required_count,
  }));
}

/**
 * The compact summary of the next 7 days of required shifts, for dashboards and later the ops
 * agent (docs/LIRA.md). Counts only.
 */
export interface RequiredShiftsSummary {
  from: string;
  to: string;
  shifts: number;
  personShifts: number;
  posts: number;
  contracts: number;
}

export async function loadRequiredShiftsSummary(
  supabase: Client,
  organisationId: string,
  from?: string,
): Promise<RequiredShiftsSummary> {
  const start = from ?? (await companyToday(supabase, organisationId));
  const to = addDays(start, 6);
  const rows = await loadRequiredShifts(supabase, organisationId, start, to);
  return {
    from: start,
    to,
    shifts: rows.length,
    personShifts: rows.reduce((sum, r) => sum + r.requiredCount, 0),
    posts: new Set(rows.map((r) => r.postId)).size,
    contracts: new Set(rows.map((r) => r.contractId)).size,
  };
}
