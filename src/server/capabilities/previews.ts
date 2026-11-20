import "server-only";

import { formatDate } from "@/lib/dates";
import { diffRateLines, formatLineRate, formatRateKey, previewRateChange } from "@/lib/rate-cards";
import {
  CONTRACT_TYPE_LABELS,
  type createContractSchema,
  type saveRateCardSchema,
  type updateContractSchema,
} from "@/server/business/contract-schemas";
import { loadRateCardVersions, organisationToday } from "@/server/business/contracts-data";
import {
  CONTACT_ROLE_LABELS,
  DEDUCTS_WHT_LABELS,
  type clientTaxSchema,
  type addContactSchema,
  type createClientSchema,
  type quickAddClientSchema,
} from "@/server/business/schemas";
import type { moveCheckpointSchema } from "@/server/sites/schemas";

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

/** Names the two checkpoints that swap places in the site's round, or says nothing moves. */
export const previewMoveCheckpoint: PreviewFn<typeof moveCheckpointSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const { data: target, error } = await supabase
    .from("site_checkpoints")
    .select("site_id")
    .eq("organisation_id", organisationId)
    .eq("id", data.checkpointId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`Could not read checkpoints: ${error.message}`);
  if (!target) return { summary: "That checkpoint wasn't found.", changes: [] };
  const { data: rows, error: listError } = await supabase
    .from("site_checkpoints")
    .select("id, name")
    .eq("organisation_id", organisationId)
    .eq("site_id", target.site_id)
    .eq("status", "active")
    .order("sort_order")
    .order("created_at")
    .order("id");
  if (listError) throw new Error(`Could not read checkpoints: ${listError.message}`);
  const list = rows ?? [];
  const at = list.findIndex((c) => c.id === data.checkpointId);
  const to = data.direction === "up" ? at - 1 : at + 1;
  const moving = list[at];
  const other = list[to];
  if (!moving || !other) {
    return { summary: "Nothing moves: the checkpoint is already at that end.", changes: [] };
  }
  return {
    summary: `Moves ${moving.name} to place ${to + 1} and ${other.name} to place ${at + 1}.`,
    changes: [
      { label: moving.name, before: `Place ${at + 1}`, after: `Place ${to + 1}` },
      { label: other.name, before: `Place ${to + 1}`, after: `Place ${at + 1}` },
    ],
  };
};

// ---------------------------------------------------------------------------
// Contracts, rate cards and WHT (slice 2.4)
// ---------------------------------------------------------------------------

/** A draft contract and the sites it covers. */
export const previewCreateContract: PreviewFn<typeof createContractSchema> = ({ data }) => {
  const changes: CapabilityPreview["changes"] = [
    {
      label: "Contract",
      after: `${data.name} (${CONTRACT_TYPE_LABELS[data.type]}, draft) from ${formatDate(data.startDate)}${
        data.endDate ? ` to ${formatDate(data.endDate)}` : ", rolling"
      }`,
    },
  ];
  changes.push({ label: "VAT", after: data.vatApplies ? "Charged (7.5%)" : "Not charged" });
  return {
    summary: `Adds draft contract ${data.name} covering ${plural(data.siteIds.length, "site", "sites")}.`,
    changes,
  };
};

/** A draft's terms and the sites it gains or loses. */
export const previewUpdateContract: PreviewFn<typeof updateContractSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const { data: current, error } = await supabase
    .from("contract_sites")
    .select("site_id")
    .eq("organisation_id", organisationId)
    .eq("contract_id", data.contractId);
  if (error) throw new Error(`Could not read contract sites: ${error.message}`);
  const before = new Set((current ?? []).map((row) => row.site_id));
  const added = data.siteIds.filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !data.siteIds.includes(id)).length;
  return {
    summary: `Saves ${data.name}: ${plural(added, "site", "sites")} added, ${plural(removed, "site", "sites")} taken off.`,
    changes: [{ label: "Contract", after: `${data.name} (${CONTRACT_TYPE_LABELS[data.type]})` }],
  };
};

async function rateContext(
  ctx: Parameters<PreviewFn<typeof saveRateCardSchema>>[0],
): Promise<Awaited<ReturnType<typeof loadRateCardVersions>> & { today: string }> {
  const loaded = await loadRateCardVersions(ctx.supabase, ctx.organisationId, ctx.data.contractId);
  return { ...loaded, today: await organisationToday(ctx.supabase, ctx.organisationId) };
}

/** "Change rates from": what closes, what starts, which lines change. */
export const previewAddRateCardVersion: PreviewFn<typeof saveRateCardSchema> = async (ctx) => {
  const { contract, versions, today } = await rateContext(ctx);
  if (!contract) return { summary: "That contract wasn't found.", changes: [] };
  const preview = previewRateChange(
    versions,
    ctx.data.effectiveFrom,
    today,
    contract,
    ctx.data.lines,
  );
  return { summary: preview.summary, changes: preview.changes };
};

/** The draft card as it will be saved, against what is there now. */
export const previewSaveDraftRateCard: PreviewFn<typeof saveRateCardSchema> = async (ctx) => {
  const { contract, versions } = await rateContext(ctx);
  if (!contract) return { summary: "That contract wasn't found.", changes: [] };
  const current = versions[0] ?? null;
  const diff = diffRateLines(current?.lines ?? null, ctx.data.lines);
  return {
    summary: `${current ? "Replaces" : "Adds"} the rate card from ${formatDate(ctx.data.effectiveFrom)}: ${plural(
      diff.changes.length,
      "line changes",
      "lines change",
    )}, ${plural(diff.unchanged, "line stays", "lines stay")} the same.`,
    changes: diff.changes.map((change) => ({
      label: formatRateKey(change.key),
      ...(change.before ? { before: formatLineRate(change.before) } : {}),
      after: change.after ? formatLineRate(change.after) : "Removed",
    })),
  };
};

/** A client's tax settings, before and after. */
export const previewSetClientTax: PreviewFn<typeof clientTaxSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const { data: rows, error } = await supabase.rpc("client_billing", {
    p_organisation_id: organisationId,
    p_client_id: data.clientId,
  });
  if (error) throw new Error(`Could not read the client: ${error.message}`);
  const current = rows?.[0];
  if (!current) return { summary: "That client wasn't found.", changes: [] };
  const vat = (on: boolean) =>
    on ? "Pays VAT to the tax authority" : "Pays VAT with each payment";
  return {
    summary: `Sets ${DEDUCTS_WHT_LABELS[data.deductsWht].toLowerCase()} and ${vat(data.withholdsVat).toLowerCase()}.`,
    changes: [
      {
        label: "WHT",
        before: DEDUCTS_WHT_LABELS[current.deducts_wht as keyof typeof DEDUCTS_WHT_LABELS],
        after: DEDUCTS_WHT_LABELS[data.deductsWht],
      },
      { label: "VAT", before: vat(current.withholds_vat), after: vat(data.withholdsVat) },
    ],
  };
};
