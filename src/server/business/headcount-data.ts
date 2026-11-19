import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  headcountRequired,
  pricingDate,
  ratesLabel,
  toHourMinute,
  weeklyHeadcount,
  type HeadcountLine,
  type HeadcountUnit,
  type WeeklyHeadcount,
} from "@/lib/headcount";
import { rateCardInForce, type RateCardVersion } from "@/lib/rate-cards";
import type { Database } from "@/types/db";

import type { ContractStatus, ContractType } from "./contract-schemas";
import { listContracts, loadRateCardVersions } from "./contracts-data";

/**
 * Reads for headcount (slice 2.5). Every query runs with the signed-in user's own client and is
 * scoped to the active organisation, so RLS decides who sees it (owner, admin, finance and
 * ops_manager). Weekly totals are computed in `src/lib/headcount.ts`, never stored.
 */

type Client = SupabaseClient<Database>;

const ROW_SELECT =
  "id, contract_id, site_id, post_name, role, band, unit, days_of_week, start_time, end_time, required_count, notes, created_at" as const;

interface HeadcountDbRow {
  id: string;
  contract_id: string;
  site_id: string;
  post_name: string | null;
  role: string;
  band: string;
  unit: string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  required_count: number;
  notes: string | null;
  created_at: string;
}

export function toHeadcountLine(row: HeadcountDbRow): HeadcountLine {
  return {
    id: row.id,
    siteId: row.site_id,
    postName: row.post_name,
    role: row.role,
    band: row.band,
    unit: row.unit as HeadcountUnit,
    daysOfWeek: [...row.days_of_week].sort((a, b) => a - b),
    startTime: toHourMinute(row.start_time),
    endTime: toHourMinute(row.end_time),
    requiredCount: row.required_count,
    notes: row.notes,
  };
}

function byCreated(a: HeadcountDbRow, b: HeadcountDbRow): number {
  return a.created_at === b.created_at
    ? a.id < b.id
      ? -1
      : 1
    : a.created_at < b.created_at
      ? -1
      : 1;
}

/** One contract's headcount, in the order it was added. */
export async function loadHeadcount(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<HeadcountLine[]> {
  if (!/^[0-9a-f-]{36}$/i.test(contractId)) return [];
  const { data, error } = await supabase
    .from("headcount_requirements")
    .select(ROW_SELECT)
    .eq("organisation_id", organisationId)
    .eq("contract_id", contractId)
    .limit(1000);
  if (error) throw new Error(`Could not read the headcount: ${error.message}`);
  return ((data ?? []) as HeadcountDbRow[]).sort(byCreated).map(toHeadcountLine);
}

export interface ContractPricing {
  status: ContractStatus;
  type: ContractType;
  startDate: string;
  endDate: string | null;
  versions: RateCardVersion[];
}

/** The day the weekly total is priced on, the version in force then, and how to say it. */
export function pricingFor(
  contract: Pick<ContractPricing, "startDate" | "endDate" | "versions">,
  today: string,
): { date: string; version: RateCardVersion | null; label: string } {
  const date = pricingDate(today, contract.startDate, contract.endDate);
  return {
    date,
    version: rateCardInForce(contract.versions, date),
    label: ratesLabel(date, today),
  };
}

/** One contract's plan priced for the Headcount tab and the previews. */
export function contractWeek(
  contract: ContractPricing,
  lines: readonly HeadcountLine[],
  today: string,
): WeeklyHeadcount & { ratesLabel: string; pricedOn: string } {
  const pricing = pricingFor(contract, today);
  return {
    ...weeklyHeadcount(lines, pricing.version, contract.type),
    ratesLabel: pricing.label,
    pricedOn: pricing.date,
  };
}

/** What a headcount preview needs: the contract's type, dates, rate cards, rows and site names. */
export async function loadHeadcountContext(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<{
  contract: ContractPricing | null;
  lines: HeadcountLine[];
  siteNames: Map<string, string>;
}> {
  const [rates, typeRow, lines, sites] = await Promise.all([
    loadRateCardVersions(supabase, organisationId, contractId),
    supabase
      .from("contracts")
      .select("type")
      .eq("organisation_id", organisationId)
      .eq("id", contractId)
      .maybeSingle(),
    loadHeadcount(supabase, organisationId, contractId),
    supabase
      .from("contract_sites")
      .select("site_id, sites(name)")
      .eq("organisation_id", organisationId)
      .eq("contract_id", contractId),
  ]);
  if (typeRow.error) throw new Error(`Could not read the contract: ${typeRow.error.message}`);
  if (sites.error) throw new Error(`Could not read contract sites: ${sites.error.message}`);
  const siteNames = new Map(
    (sites.data ?? []).map((s) => [s.site_id, s.sites?.name ?? "a site"] as const),
  );
  if (!rates.contract || !typeRow.data) return { contract: null, lines, siteNames };
  return {
    contract: {
      ...rates.contract,
      type: typeRow.data.type as ContractType,
      versions: rates.versions,
    },
    lines,
    siteNames,
  };
}

/**
 * The compact headcount summary of an organisation's open contracts, for dashboards and later
 * the ops agent (docs/LIRA.md). Counts only: no names, rates or amounts.
 */
export interface HeadcountSummary {
  /** Draft and active contracts with at least one headcount row. */
  contractsWithHeadcount: number;
  /** Headcount rows on draft and active contracts. */
  rows: number;
  /** Person-shifts and person-visits a week across those rows. */
  shiftsPerWeek: number;
  visitsPerWeek: number;
  /** Draft manned-post contracts with no headcount yet (activation needs it, 2.7). */
  mannedPostDraftsWithoutHeadcount: number;
  /** Draft and active contracts with a row whose rate key has no line on the card that applies. */
  contractsWithUnpricedRows: number;
  unpricedRows: number;
}

export function summariseHeadcount(
  contracts: readonly (ContractPricing & { id: string })[],
  linesByContract: ReadonlyMap<string, readonly HeadcountLine[]>,
  today: string,
): HeadcountSummary {
  const summary: HeadcountSummary = {
    contractsWithHeadcount: 0,
    rows: 0,
    shiftsPerWeek: 0,
    visitsPerWeek: 0,
    mannedPostDraftsWithoutHeadcount: 0,
    contractsWithUnpricedRows: 0,
    unpricedRows: 0,
  };
  for (const contract of contracts) {
    if (contract.status === "ended") continue;
    const lines = linesByContract.get(contract.id) ?? [];
    if (lines.length === 0) {
      if (contract.status === "draft" && headcountRequired(contract.type)) {
        summary.mannedPostDraftsWithoutHeadcount += 1;
      }
      continue;
    }
    const week = contractWeek(contract, lines, today);
    summary.contractsWithHeadcount += 1;
    summary.rows += week.posts;
    summary.shiftsPerWeek += week.shifts;
    summary.visitsPerWeek += week.visits;
    if (week.unpriced > 0) {
      summary.contractsWithUnpricedRows += 1;
      summary.unpricedRows += week.unpriced;
    }
  }
  return summary;
}

export async function loadHeadcountSummary(
  supabase: Client,
  organisationId: string,
  today: string,
): Promise<HeadcountSummary> {
  const [contracts, rows] = await Promise.all([
    listContracts(supabase, organisationId),
    supabase
      .from("headcount_requirements")
      .select(ROW_SELECT)
      .eq("organisation_id", organisationId)
      .limit(10_000),
  ]);
  if (rows.error) throw new Error(`Could not read the headcount: ${rows.error.message}`);
  const byContract = new Map<string, HeadcountLine[]>();
  for (const row of ((rows.data ?? []) as HeadcountDbRow[]).sort(byCreated)) {
    const list = byContract.get(row.contract_id) ?? [];
    list.push(toHeadcountLine(row));
    byContract.set(row.contract_id, list);
  }
  return summariseHeadcount(contracts, byContract, today);
}
