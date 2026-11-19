import "server-only";

import { notFound, redirect } from "next/navigation";

import { lagosToday } from "@/lib/dates";
import type { HeadcountLine } from "@/lib/headcount";
import { toRateLineInput } from "@/lib/rate-cards";
import { loadContract, type ContractDetail } from "@/server/business/contracts-data";
import { loadHeadcount, pricingFor } from "@/server/business/headcount-data";

import { clientsPageContext } from "../../../../_components/context";

export interface HeadcountEditor {
  contract: ContractDetail;
  lines: HeadcountLine[];
  back: string;
  today: string;
}

/**
 * What the add and edit headcount pages need. Headcount changes only on a draft, by its editors;
 * anyone else (or a live contract) goes back to the Headcount tab. The actions check again.
 */
export async function loadHeadcountEditor(
  clientId: string,
  contractId: string,
): Promise<HeadcountEditor> {
  const ctx = await clientsPageContext();
  const [contract, lines] = await Promise.all([
    loadContract(ctx.supabase, ctx.organisationId, clientId, contractId),
    loadHeadcount(ctx.supabase, ctx.organisationId, contractId),
  ]);
  if (!contract) notFound();
  const back = `/app/clients/${clientId}/contracts/${contract.id}?tab=headcount`;
  if (!ctx.canEditContracts || contract.status !== "draft" || contract.sites.length === 0) {
    redirect(back);
  }
  return { contract, lines, back, today: lagosToday() };
}

/** The form's props from the editor data: rates as typed text, so no bigint reaches the browser. */
export function headcountEditorProps(editor: HeadcountEditor) {
  const pricing = pricingFor(editor.contract, editor.today);
  return {
    clientId: editor.contract.clientId,
    contractId: editor.contract.id,
    contractType: editor.contract.type,
    sites: editor.contract.sites,
    lines: editor.lines,
    rateLines: pricing.version ? pricing.version.lines.map(toRateLineInput) : null,
    ratesLabel: pricing.label,
  };
}
