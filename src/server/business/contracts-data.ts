import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Currency } from "@/lib/money";
import {
  rateCardInForce,
  type RateCardVersion,
  type RateLine,
  type RateUnit,
} from "@/lib/rate-cards";
import { koboFromText } from "@/server/people/pay-rates";
import type { Database } from "@/types/db";

import type { BillingFrequency, ContractStatus, ContractType, Sla } from "./contract-schemas";

/**
 * Reads for contracts, rate cards and WHT rates (slice 2.4). Every query runs with the
 * signed-in user's own client and is scoped to the active organisation, so RLS decides who sees
 * them (owner, admin, finance and ops_manager). Kobo columns are selected cast to text and read
 * with `koboFromText`, never as the raw number the generated types suggest.
 */

type Client = SupabaseClient<Database>;

const LINE_SELECT =
  "role, band, unit, rate_kobo::text, currency, ot_rate_kobo::text, ot_multiplier_bps, sort_order" as const;

const VERSION_SELECT =
  `id, effective_from, effective_to, note, rate_card_lines(${LINE_SELECT})` as const;

interface LineTextRow {
  role: string;
  band: string;
  unit: string;
  rate_kobo: string;
  currency: string;
  ot_rate_kobo: string | null;
  ot_multiplier_bps: number | null;
  sort_order: number;
}

interface VersionTextRow {
  id: string;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  rate_card_lines: LineTextRow[] | null;
}

export function toRateLine(row: LineTextRow): RateLine {
  if (row.currency !== "NGN") throw new Error(`Unexpected rate currency ${row.currency}`);
  const rate = koboFromText(row.rate_kobo);
  if (rate === null) throw new Error("A rate line has no rate");
  return {
    role: row.role,
    band: row.band,
    unit: row.unit as RateUnit,
    rateKobo: rate,
    currency: row.currency as Currency,
    otRateKobo: koboFromText(row.ot_rate_kobo),
    otMultiplierBps: row.ot_multiplier_bps,
  };
}

export function toRateCardVersion(row: VersionTextRow): RateCardVersion {
  const lines = [...(row.rate_card_lines ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
    lines: lines.map(toRateLine),
  };
}

function sortVersions(versions: RateCardVersion[]): RateCardVersion[] {
  return versions.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

export interface WhtRateVersion {
  id: string;
  rateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ContractRow {
  id: string;
  clientId: string;
  reference: string;
  name: string;
  type: ContractType;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  siteCount: number;
  /** Oldest first. */
  versions: RateCardVersion[];
}

const LIST_LIMIT = 2000;

/** Contracts of the organisation (or of one client), newest first, with their rate cards. */
export async function listContracts(
  supabase: Client,
  organisationId: string,
  options: { clientId?: string } = {},
): Promise<ContractRow[]> {
  let query = supabase
    .from("contracts")
    .select(
      `id, client_id, reference, name, type, status, start_date, end_date, created_at, contract_sites(count), rate_cards(${VERSION_SELECT})`,
    )
    .eq("organisation_id", organisationId)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (options.clientId) query = query.eq("client_id", options.clientId);
  const { data, error } = await query;
  if (error) throw new Error(`Could not read contracts: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    clientId: row.client_id,
    reference: row.reference,
    name: row.name,
    type: row.type as ContractType,
    status: row.status as ContractStatus,
    startDate: row.start_date,
    endDate: row.end_date,
    siteCount: row.contract_sites?.[0]?.count ?? 0,
    versions: sortVersions((row.rate_cards ?? []).map(toRateCardVersion)),
  }));
}

/**
 * The rates to show for a contract on `today`: the version in force, else the next one to start,
 * else the last one. Null when the contract has no rate card.
 */
export function currentOrNextVersion(
  versions: readonly RateCardVersion[],
  today: string,
): RateCardVersion | null {
  return (
    rateCardInForce(versions, today) ??
    versions.find((v) => v.effectiveFrom > today) ??
    versions[versions.length - 1] ??
    null
  );
}

/**
 * The compact summary of an organisation's contracts, for dashboards and later the ops agent
 * (docs/LIRA.md). Counts only: no names, rates or client details.
 */
export interface ContractsSummary {
  total: number;
  draft: number;
  active: number;
  ended: number;
  /** Draft and active contracts with no rate card at all. */
  noRateCard: number;
  /** Active contracts with no rate card in force today. */
  activeWithoutRatesToday: number;
  /** Draft and active contracts with a rate change that hasn't started yet. */
  scheduledRateChanges: number;
}

export function summariseContracts(rows: readonly ContractRow[], today: string): ContractsSummary {
  const open = rows.filter((r) => r.status !== "ended");
  return {
    total: rows.length,
    draft: rows.filter((r) => r.status === "draft").length,
    active: rows.filter((r) => r.status === "active").length,
    ended: rows.filter((r) => r.status === "ended").length,
    noRateCard: open.filter((r) => r.versions.length === 0).length,
    activeWithoutRatesToday: rows.filter(
      (r) => r.status === "active" && !rateCardInForce(r.versions, today),
    ).length,
    scheduledRateChanges: open.filter(
      (r) => r.versions.length > 1 && r.versions.some((v) => v.effectiveFrom > today),
    ).length,
  };
}

export async function loadContractsSummary(
  supabase: Client,
  organisationId: string,
  today: string,
): Promise<ContractsSummary> {
  return summariseContracts(await listContracts(supabase, organisationId), today);
}

export interface ContractSite {
  id: string;
  name: string;
}

export interface ContractDetail {
  id: string;
  clientId: string;
  clientName: string;
  reference: string;
  name: string;
  type: ContractType;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  goLiveDate: string | null;
  billingFrequency: BillingFrequency;
  billingTermsDays: number | null;
  vatApplies: boolean;
  sla: Sla;
  createdAt: string;
  sites: ContractSite[];
  /** Oldest first. */
  versions: RateCardVersion[];
  /** Oldest first. */
  whtRates: WhtRateVersion[];
}

/** One contract of a client, or null when it isn't there (or RLS hides it). */
export async function loadContract(
  supabase: Client,
  organisationId: string,
  clientId: string,
  contractId: string,
): Promise<ContractDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(contractId) || !/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  const { data: row, error } = await supabase
    .from("contracts")
    .select(
      `id, client_id, reference, name, type, status, start_date, end_date, go_live_date, billing_frequency, billing_terms_days, vat_applies, sla, created_at, clients(name), contract_sites(site_id, sites(id, name)), rate_cards(${VERSION_SELECT}), contract_wht_rates(id, rate_bps, effective_from, effective_to)`,
    )
    .eq("organisation_id", organisationId)
    .eq("client_id", clientId)
    .eq("id", contractId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the contract: ${error.message}`);
  if (!row) return null;
  const sites = (row.contract_sites ?? [])
    .map((cs) => cs.sites)
    .filter((s): s is { id: string; name: string } => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.clients?.name ?? "",
    reference: row.reference,
    name: row.name,
    type: row.type as ContractType,
    status: row.status as ContractStatus,
    startDate: row.start_date,
    endDate: row.end_date,
    goLiveDate: row.go_live_date,
    billingFrequency: row.billing_frequency as BillingFrequency,
    billingTermsDays: row.billing_terms_days,
    vatApplies: row.vat_applies,
    sla: (row.sla ?? {}) as Sla,
    createdAt: row.created_at,
    sites,
    versions: sortVersions((row.rate_cards ?? []).map(toRateCardVersion)),
    whtRates: (row.contract_wht_rates ?? [])
      .map((w) => ({
        id: w.id,
        rateBps: w.rate_bps,
        effectiveFrom: w.effective_from,
        effectiveTo: w.effective_to,
      }))
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1)),
  };
}

/** The rate card versions of one contract (for previews), oldest first. */
export async function loadRateCardVersions(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<{
  contract: { status: ContractStatus; startDate: string; endDate: string | null } | null;
  versions: RateCardVersion[];
}> {
  const { data, error } = await supabase
    .from("contracts")
    .select(`status, start_date, end_date, rate_cards(${VERSION_SELECT})`)
    .eq("organisation_id", organisationId)
    .eq("id", contractId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the rate card: ${error.message}`);
  if (!data) return { contract: null, versions: [] };
  return {
    contract: {
      status: data.status as ContractStatus,
      startDate: data.start_date,
      endDate: data.end_date,
    },
    versions: sortVersions((data.rate_cards ?? []).map(toRateCardVersion)),
  };
}
