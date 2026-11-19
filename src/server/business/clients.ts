import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import type { ManagerRole } from "@/lib/roles";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";

import {
  addContactSchema,
  clientTaxSchema,
  contactIdSchema,
  createClientSchema,
  quickAddClientSchema,
  setClientStatusSchema,
  updateClientSchema,
  updateContactSchema,
} from "./schemas";

/**
 * Clients and contacts (slice 2.1), as `mutate()` specs. Every write uses the signed-in user's
 * own client, so RLS and the column grants apply again, and the row audit triggers on `clients`,
 * `client_contacts` and `sites` log the before and after in the same transaction. A client with
 * its first contact and site is one SQL function (`public.create_client`), so it saves whole or
 * not at all. Nothing here deletes: clients are archived and contacts are marked removed.
 */

/** Add and change clients (and their sites from 2.2). hr may only insert, through the import. */
export const CLIENT_EDITORS = [
  "owner",
  "admin",
  "ops_manager",
] as const satisfies readonly ManagerRole[];

/** Read and write client contacts. */
export const CONTACT_EDITORS = [
  "owner",
  "admin",
  "finance",
  "ops_manager",
] as const satisfies readonly ManagerRole[];

/** Who opens /app/clients (the nav item's roles). */
export const CLIENT_READERS = CONTACT_EDITORS;

/** A client's tax settings (deducts WHT, withholds VAT): owner, admin, finance. */
export const CLIENT_TAX_EDITORS = [
  "owner",
  "admin",
  "finance",
] as const satisfies readonly ManagerRole[];

export function canEditClientTax(role: ManagerRole): boolean {
  return (CLIENT_TAX_EDITORS as readonly ManagerRole[]).includes(role);
}

export function canEditClients(role: ManagerRole): boolean {
  return (CLIENT_EDITORS as readonly ManagerRole[]).includes(role);
}

export function canEditContacts(role: ManagerRole): boolean {
  return (CONTACT_EDITORS as readonly ManagerRole[]).includes(role);
}

const DUPLICATE_CLIENT = "A client with this name already exists.";
const DUPLICATE_CONTACT = "This client already has an active contact with this email and role.";
const DUPLICATE_SITE = "This client already has a site with this name.";

/** Database refusals in plain English, under the field they belong to. */
function fromDbError(error: PostgrestError, fields: { name?: string; email?: string } = {}): never {
  const text = `${error.message} ${error.details ?? ""}`;
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
  if (error.code === "23505" && text.includes("clients_organisation_name_key")) {
    throw new MutationError("invalid", DUPLICATE_CLIENT, {
      [fields.name ?? "name"]: DUPLICATE_CLIENT,
    });
  }
  if (error.code === "23505" && text.includes("client_contacts_active_email_idx")) {
    throw new MutationError("invalid", DUPLICATE_CONTACT, {
      [fields.email ?? "email"]: DUPLICATE_CONTACT,
    });
  }
  if (error.code === "23505" && text.includes("sites_client_name_key")) {
    throw new MutationError("invalid", DUPLICATE_SITE, { siteName: DUPLICATE_SITE });
  }
  if (error.code === "MLCC3") {
    throw new MutationError("invalid", "A removed contact can't be changed. Add it again.");
  }
  if (error.code === "23514") {
    throw new MutationError("invalid", "Check the highlighted fields.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const createClientSpec: MutationSpec<typeof createClientSchema, { id: string }> = {
  schema: createClientSchema,
  roles: CLIENT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("create_client", {
      p_organisation_id: organisationId,
      p_name: data.name,
      p_legal_name: data.legalName ?? undefined,
      p_rc_number: data.rcNumber ?? undefined,
      p_tin: data.tin ?? undefined,
      p_billing_address: data.billingAddress ?? undefined,
      p_state: data.state ?? undefined,
      p_billing_terms_days: data.billingTermsDays ?? undefined,
      p_notes: data.notes ?? undefined,
      p_contact_name: data.contactName ?? undefined,
      p_contact_email: data.contactEmail ?? undefined,
      p_contact_phone: data.contactPhone ?? undefined,
    });
    if (error) fromDbError(error, { email: "contactEmail" });
    return { id };
  },
};

export function createClient(input: unknown): Promise<{ id: string }> {
  return mutate(createClientSpec, input);
}

export const updateClientSpec: MutationSpec<typeof updateClientSchema, { id: string }> = {
  schema: updateClientSchema,
  roles: CLIENT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("clients")
      .update({
        name: data.name,
        legal_name: data.legalName,
        rc_number: data.rcNumber,
        tin: data.tin,
        billing_address: data.billingAddress,
        state: data.state,
        billing_terms_days: data.billingTermsDays,
        notes: data.notes,
      })
      .eq("id", data.clientId)
      .eq("organisation_id", organisationId)
      .select("id")
      .maybeSingle();
    if (error) fromDbError(error);
    if (!row) throw new MutationError("invalid", "That client wasn't found.");
    return { id: row.id };
  },
};

export function updateClient(input: unknown): Promise<{ id: string }> {
  return mutate(updateClientSpec, input);
}

/** Archive or restore. Archived clients stay on record (sites, contracts, invoices point at them). */
export const setClientStatusSpec: MutationSpec<typeof setClientStatusSchema, { id: string }> = {
  schema: setClientStatusSchema,
  roles: CLIENT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("clients")
      .update({ status: data.status })
      .eq("id", data.clientId)
      .eq("organisation_id", organisationId)
      .select("id")
      .maybeSingle();
    if (error) fromDbError(error);
    if (!row) throw new MutationError("invalid", "That client wasn't found.");
    return { id: row.id };
  },
};

export function setClientStatus(input: unknown): Promise<{ id: string }> {
  return mutate(setClientStatusSpec, input);
}

/** Setup step 4: a client, its billing email as the primary billing contact, and a first site. */
export const quickAddClientSpec: MutationSpec<typeof quickAddClientSchema, { id: string }> = {
  schema: quickAddClientSchema,
  roles: CLIENT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("create_client", {
      p_organisation_id: organisationId,
      p_name: data.name,
      p_contact_email: data.billingEmail ?? undefined,
      p_site_name: data.siteName ?? undefined,
    });
    if (error) fromDbError(error, { email: "billingEmail" });
    return { id };
  },
};

export function quickAddClient(input: unknown): Promise<{ id: string }> {
  return mutate(quickAddClientSpec, input);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Adds a contact. The first active contact of a role becomes its primary on its own, and a new
 * primary demotes the old one (both in the database trigger).
 */
export const addContactSpec: MutationSpec<typeof addContactSchema, { id: string }> = {
  schema: addContactSchema,
  roles: CONTACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("client_contacts")
      .insert({
        organisation_id: organisationId,
        client_id: data.clientId,
        name: data.name,
        email: data.email,
        phone: data.phone,
        role: data.role,
        is_primary: data.isPrimary,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23503") throw new MutationError("invalid", "That client wasn't found.");
      fromDbError(error);
    }
    return { id: row.id };
  },
};

export function addContact(input: unknown): Promise<{ id: string }> {
  return mutate(addContactSpec, input);
}

/** Changes a contact's name, email or phone, or makes it the primary for its role. */
export const updateContactSpec: MutationSpec<typeof updateContactSchema, { id: string }> = {
  schema: updateContactSchema,
  roles: CONTACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const patch: { name: string; email: string; phone: string | null; is_primary?: boolean } = {
      name: data.name,
      email: data.email,
      phone: data.phone,
    };
    // Unticking never leaves a role without a primary: another contact is made primary instead.
    if (data.isPrimary) patch.is_primary = true;
    const { data: row, error } = await supabase
      .from("client_contacts")
      .update(patch)
      .eq("id", data.contactId)
      .eq("organisation_id", organisationId)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (error) fromDbError(error);
    if (!row) throw new MutationError("invalid", "That contact wasn't found.");
    return { id: row.id };
  },
};

export function updateContact(input: unknown): Promise<{ id: string }> {
  return mutate(updateContactSpec, input);
}

/** Marks a contact removed. Its rows in the audit log, and anything sent to it, stay. */
export const removeContactSpec: MutationSpec<typeof contactIdSchema, { id: string }> = {
  schema: contactIdSchema,
  roles: CONTACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: row, error } = await supabase
      .from("client_contacts")
      .update({ status: "removed", is_primary: false })
      .eq("id", data.contactId)
      .eq("organisation_id", organisationId)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (error) fromDbError(error);
    if (!row) throw new MutationError("invalid", "That contact wasn't found.");
    return { id: row.id };
  },
};

export function removeContact(input: unknown): Promise<{ id: string }> {
  return mutate(removeContactSpec, input);
}

// ---------------------------------------------------------------------------
// Tax settings (owner's accountant, 19 Nov 2026)
// ---------------------------------------------------------------------------

/**
 * Whether the client is expected to deduct WHT, and whether it pays the VAT to the tax authority
 * itself (government MDAs, VAT withholding agents). `public.set_client_tax_settings` checks the
 * role again, and audits the row change and the reason.
 */
export const setClientTaxSpec: MutationSpec<typeof clientTaxSchema, { id: string }> = {
  schema: clientTaxSchema,
  roles: CLIENT_TAX_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("set_client_tax_settings", {
      p_organisation_id: organisationId,
      p_client_id: data.clientId,
      p_deducts_wht: data.deductsWht,
      p_withholds_vat: data.withholdsVat,
      ...(data.reason ? { p_reason: data.reason } : {}),
    });
    if (error) {
      if (error.code === "P0002") throw new MutationError("invalid", "That client wasn't found.");
      fromDbError(error);
    }
    return { id: data.clientId };
  },
};

export function setClientTax(input: unknown): Promise<{ id: string }> {
  return mutate(setClientTaxSpec, input);
}
