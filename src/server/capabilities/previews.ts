import "server-only";

import { formatDate, lagosToday } from "@/lib/dates";
import {
  diffRateLines,
  formatLineRate,
  formatPercentBps,
  formatRateKey,
  planNewVersion,
  previewRateChange,
} from "@/lib/rate-cards";
import {
  CONTRACT_TYPE_LABELS,
  type addWhtRateSchema,
  type createContractSchema,
  type saveRateCardSchema,
  type updateContractSchema,
} from "@/server/business/contract-schemas";
import { loadRateCardVersions } from "@/server/business/contracts-data";
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
  if (data.whtRate !== null) {
    changes.push({
      label: "WHT rate",
      after: `${formatPercentBps(data.whtRate)} from ${formatDate(data.startDate)}`,
    });
  }
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
  return { ...loaded, today: lagosToday() };
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

export const previewAddWhtRate: PreviewFn<typeof addWhtRateSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const { data: row, error } = await supabase
    .from("contracts")
    .select(
      "status, start_date, end_date, contract_wht_rates(id, rate_bps, effective_from, effective_to)",
    )
    .eq("organisation_id", organisationId)
    .eq("id", data.contractId)
    .maybeSingle();
  if (error) throw new Error(`Could not read WHT rates: ${error.message}`);
  if (!row) return { summary: "That contract wasn't found.", changes: [] };
  const versions = (row.contract_wht_rates ?? []).map((w) => ({
    id: w.id,
    effectiveFrom: w.effective_from,
    effectiveTo: w.effective_to,
    rateBps: w.rate_bps,
  }));
  const after = `${formatPercentBps(data.rate)} from ${formatDate(data.effectiveFrom)}`;
  if (versions.length === 0) {
    return { summary: `Sets WHT at ${after}.`, changes: [{ label: "WHT rate", after }] };
  }
  const plan = planNewVersion(versions, data.effectiveFrom, lagosToday(), {
    status: row.status as "draft" | "active" | "ended",
    startDate: row.start_date,
    endDate: row.end_date,
  });
  if (!plan.ok) {
    const reason = plan.reason
      .replace("A rate card from", "A WHT rate from")
      .replace("A rate change starts", "A WHT change starts")
      .replace("The new rates must start", "The WHT rate must start")
      .replace("its rates can't change", "its WHT rate can't change");
    return { summary: reason, changes: [] };
  }
  const closing = versions.find((v) => v.id === plan.closes.id);
  return {
    summary: `Changes WHT to ${after}; the current rate ends on ${formatDate(plan.closes.effectiveToAfter)}.`,
    changes: [
      {
        label: "WHT rate",
        before: closing ? formatPercentBps(closing.rateBps) : "None",
        after,
      },
    ],
  };
};
