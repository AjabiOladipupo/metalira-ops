import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/db";

import type { ClientStatus, ContactRole } from "./schemas";

/**
 * Reads for the Clients screens (slice 2.1). Every query runs with the signed-in user's own
 * client and is scoped to the active organisation, so RLS decides what each role sees. Client
 * contacts are read by owner, admin, finance and ops_manager only; for anyone else RLS returns
 * none, and the screens say so rather than "no contacts".
 */

type Client = SupabaseClient<Database>;

/** A client's details are complete enough to invoice: a billing address and a billing contact. */
export function clientNeedsDetails(client: {
  billingAddress: string | null;
  hasBillingContact: boolean;
}): boolean {
  return !client.billingAddress || !client.hasBillingContact;
}

export interface ClientRow {
  id: string;
  name: string;
  legalName: string | null;
  status: ClientStatus;
  siteCount: number;
  /** Active contracts arrive in slice 2.4; 0 until then. */
  activeContractCount: number;
  primaryBillingEmail: string | null;
  needsDetails: boolean;
}

/** Plain text a person typed, folded for a forgiving "contains" match. */
function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

const LIST_LIMIT = 2000;

/**
 * Every client of the organisation (archived last), with its site count and primary billing
 * email, filtered by `query` on the name or registered name.
 */
export async function listClients(
  supabase: Client,
  organisationId: string,
  options: { query?: string } = {},
): Promise<ClientRow[]> {
  const { data, error } = await supabase
    .from("clients")
    .select(
      "id, name, legal_name, status, billing_address, sites(count), client_contacts(email, role, is_primary, status)",
    )
    .eq("organisation_id", organisationId)
    .order("name")
    .limit(LIST_LIMIT);
  if (error) throw new Error(`Could not read clients: ${error.message}`);

  const rows = (data ?? []).map((row): ClientRow => {
    const billing = (row.client_contacts ?? []).filter(
      (c) => c.status === "active" && c.role === "billing",
    );
    const primary = billing.find((c) => c.is_primary) ?? billing[0];
    return {
      id: row.id,
      name: row.name,
      legalName: row.legal_name,
      status: row.status as ClientStatus,
      siteCount: row.sites?.[0]?.count ?? 0,
      activeContractCount: 0,
      primaryBillingEmail: primary?.email ?? null,
      needsDetails: clientNeedsDetails({
        billingAddress: row.billing_address,
        hasBillingContact: billing.length > 0,
      }),
    };
  });
  // Active first, then archived; each by name.
  rows.sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived"));
  return filterClients(rows, options.query);
}

/** The rows whose name or registered name contains `query`, ignoring case and accents. */
export function filterClients(rows: readonly ClientRow[], query = ""): ClientRow[] {
  const needle = fold(query.trim());
  if (!needle) return [...rows];
  return rows.filter(
    (r) => fold(r.name).includes(needle) || fold(r.legalName ?? "").includes(needle),
  );
}

/**
 * The compact summary of an organisation's clients, for the list header, dashboards and later
 * the ops agent (docs/LIRA.md). Counts only: no names, emails or other details.
 */
export interface ClientsSummary {
  total: number;
  active: number;
  archived: number;
  /** Active clients with no billing address or no billing contact yet. */
  needsDetails: number;
  /** Sites across active clients. */
  sites: number;
}

export function summariseClients(rows: readonly ClientRow[]): ClientsSummary {
  const active = rows.filter((r) => r.status === "active");
  return {
    total: rows.length,
    active: active.length,
    archived: rows.length - active.length,
    needsDetails: active.filter((r) => r.needsDetails).length,
    sites: active.reduce((sum, r) => sum + r.siteCount, 0),
  };
}

export async function loadClientsSummary(
  supabase: Client,
  organisationId: string,
): Promise<ClientsSummary> {
  return summariseClients(await listClients(supabase, organisationId));
}

export interface ClientContact {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: ContactRole;
  isPrimary: boolean;
}

export interface ClientSite {
  id: string;
  name: string;
}

export interface ClientDetail {
  id: string;
  name: string;
  legalName: string | null;
  rcNumber: string | null;
  tin: string | null;
  billingAddress: string | null;
  state: string | null;
  billingTermsDays: number | null;
  status: ClientStatus;
  notes: string | null;
  createdAt: string;
  /** Active contacts, primary first within each role. Empty when RLS hides contacts. */
  contacts: ClientContact[];
  sites: ClientSite[];
  needsDetails: boolean;
}

const ROLE_ORDER: Record<ContactRole, number> = { billing: 0, approver: 1, ops: 2 };

/** One client with its active contacts and sites, or null when it isn't there (or RLS hides it). */
export async function loadClient(
  supabase: Client,
  organisationId: string,
  clientId: string,
): Promise<ClientDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  const [client, contacts, sites] = await Promise.all([
    supabase
      .from("clients")
      .select(
        "id, name, legal_name, rc_number, tin, billing_address, state, billing_terms_days, status, notes, created_at",
      )
      .eq("organisation_id", organisationId)
      .eq("id", clientId)
      .maybeSingle(),
    supabase
      .from("client_contacts")
      .select("id, name, email, phone, role, is_primary")
      .eq("organisation_id", organisationId)
      .eq("client_id", clientId)
      .eq("status", "active")
      .order("created_at"),
    supabase
      .from("sites")
      .select("id, name")
      .eq("organisation_id", organisationId)
      .eq("client_id", clientId)
      .order("name"),
  ]);
  if (client.error) throw new Error(`Could not read the client: ${client.error.message}`);
  if (contacts.error) throw new Error(`Could not read contacts: ${contacts.error.message}`);
  if (sites.error) throw new Error(`Could not read sites: ${sites.error.message}`);
  const row = client.data;
  if (!row) return null;

  const contactRows = (contacts.data ?? [])
    .map((c): ClientContact => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role as ContactRole,
      isPrimary: c.is_primary,
    }))
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || Number(b.isPrimary) - Number(a.isPrimary),
    );

  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    rcNumber: row.rc_number,
    tin: row.tin,
    billingAddress: row.billing_address,
    state: row.state,
    billingTermsDays: row.billing_terms_days,
    status: row.status as ClientStatus,
    notes: row.notes,
    createdAt: row.created_at,
    contacts: contactRows,
    sites: (sites.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    needsDetails: clientNeedsDetails({
      billingAddress: row.billing_address,
      hasBillingContact: contactRows.some((c) => c.role === "billing"),
    }),
  };
}

/** Setup step 4's table: each client with its primary billing email and first site. */
export interface SetupClientRow {
  id: string;
  name: string;
  billingEmail: string | null;
  siteNames: string[];
}

export async function listSetupClients(
  supabase: Client,
  organisationId: string,
): Promise<SetupClientRow[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, created_at, sites(name), client_contacts(email, role, is_primary, status)")
    .eq("organisation_id", organisationId)
    .eq("status", "active")
    .order("created_at")
    .limit(200);
  if (error) throw new Error(`Could not read clients: ${error.message}`);
  return (data ?? []).map((row) => {
    const billing = (row.client_contacts ?? []).filter(
      (c) => c.status === "active" && c.role === "billing",
    );
    const primary = billing.find((c) => c.is_primary) ?? billing[0];
    return {
      id: row.id,
      name: row.name,
      billingEmail: primary?.email ?? null,
      siteNames: (row.sites ?? []).map((s) => s.name).sort(),
    };
  });
}
