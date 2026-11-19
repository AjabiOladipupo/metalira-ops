import "server-only";

import {
  CONTACT_ROLE_LABELS,
  type addContactSchema,
  type createClientSchema,
  type quickAddClientSchema,
} from "@/server/business/schemas";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * Previews for writes that change more than one row (./types.ts "Preview, then confirm"). Each
 * says what the write will do, without doing it. Reads use the caller's own client, so a preview
 * never shows what the caller couldn't see.
 */

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const previewCreateClient: PreviewFn<typeof createClientSchema> = ({ data }) => {
  const changes: CapabilityPreview["changes"] = [{ label: "Client", after: data.name }];
  if (data.contactEmail) {
    changes.push({
      label: "Primary billing contact",
      after: data.contactName ? `${data.contactName} (${data.contactEmail})` : data.contactEmail,
    });
  }
  const contacts = data.contactEmail ? 1 : 0;
  return {
    summary: `Adds ${data.name} with ${plural(contacts, "contact", "contacts")}.`,
    changes,
  };
};

export const previewQuickAddClient: PreviewFn<typeof quickAddClientSchema> = ({ data }) => {
  const changes: CapabilityPreview["changes"] = [{ label: "Client", after: data.name }];
  if (data.billingEmail)
    changes.push({ label: "Primary billing contact", after: data.billingEmail });
  if (data.siteName) changes.push({ label: "Site", after: data.siteName });
  const contacts = data.billingEmail ? 1 : 0;
  const sites = data.siteName ? 1 : 0;
  return {
    summary: `Adds ${data.name} with ${plural(contacts, "contact", "contacts")} and ${plural(sites, "site", "sites")}.`,
    changes,
  };
};

/** Names the primary a new contact replaces, when it would replace one. */
export const previewAddContact: PreviewFn<typeof addContactSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const role = CONTACT_ROLE_LABELS[data.role].toLowerCase();
  const { data: current, error } = await supabase
    .from("client_contacts")
    .select("name, email")
    .eq("organisation_id", organisationId)
    .eq("client_id", data.clientId)
    .eq("role", data.role)
    .eq("status", "active")
    .eq("is_primary", true)
    .maybeSingle();
  if (error) throw new Error(`Could not read contacts: ${error.message}`);
  const becomesPrimary = data.isPrimary || !current;
  const changes: CapabilityPreview["changes"] = [
    {
      label: `${CONTACT_ROLE_LABELS[data.role]} contact`,
      after: `${data.name} (${data.email})${becomesPrimary ? ", primary" : ""}`,
    },
  ];
  if (becomesPrimary && current) {
    changes.push({
      label: `Primary ${role} contact`,
      before: current.name,
      after: data.name,
    });
  }
  return {
    summary: becomesPrimary
      ? `Adds ${data.name} as the primary ${role} contact.`
      : `Adds ${data.name} as a ${role} contact.`,
    changes,
  };
};
