import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { loadClient } from "@/server/business/clients-data";
import { loadContract } from "@/server/business/contracts-data";
import { getActiveCompany } from "@/server/identity/company-data";

import { RouteGate } from "../../../../../_shell/slots";
import { ContractForm } from "../../../../_components/contract-form";
import {
  BILLING_FREQUENCY_OPTIONS,
  CONTRACT_TYPE_OPTIONS,
  TERMS_OPTIONS,
  inheritedTermsLabel,
} from "../../../../_components/contract-options";
import { clientsPageContext } from "../../../../_components/context";

export const metadata: Metadata = { title: "Edit contract" };

/** "98.5" from 9850 basis points, as typed in the form. */
function bpsToPercentText(bps: number | undefined): string {
  if (bps === undefined) return "";
  const rest = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${Math.trunc(bps / 100)}${rest ? `.${rest}` : ""}`;
}

async function EditContract({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/edit">["params"];
}) {
  const { clientId, contractId } = await params;
  const ctx = await clientsPageContext();
  const [contract, client, company] = await Promise.all([
    loadContract(ctx.supabase, ctx.organisationId, clientId, contractId),
    loadClient(ctx.supabase, ctx.organisationId, clientId),
    getActiveCompany(),
  ]);
  if (!contract || !client) notFound();
  const back = `/app/clients/${clientId}/contracts/${contract.id}`;
  // A live contract's terms never change; the database refuses it too.
  if (contract.status !== "draft") redirect(back);
  return (
    <>
      <PageHeader
        back={{ href: back, label: contract.name }}
        eyebrow={`${contract.clientName} · ${contract.reference}`}
        title={`Edit ${contract.name}`}
        description="A draft's terms and sites can change until it is activated."
      />
      <ContractForm
        mode="edit"
        clientId={clientId}
        contract={{
          id: contract.id,
          reference: contract.reference,
          name: contract.name,
          type: contract.type,
          startDate: contract.startDate,
          endDate: contract.endDate,
          billingFrequency: contract.billingFrequency,
          billingTermsDays: contract.billingTermsDays,
          vatApplies: contract.vatApplies,
          coverageTarget: bpsToPercentText(contract.sla.coverage_target_bps),
          responseMinutes: contract.sla.response_minutes ?? null,
          slaNotes: contract.sla.notes ?? "",
          siteIds: contract.sites.map((s) => s.id),
        }}
        sites={client.sites}
        types={CONTRACT_TYPE_OPTIONS}
        frequencies={BILLING_FREQUENCY_OPTIONS}
        terms={TERMS_OPTIONS}
        companyTermsLabel={inheritedTermsLabel(
          client.billingTermsDays,
          company?.paymentTermsDays ?? 30,
        )}
        defaultVat={contract.vatApplies}
        defaultStart={contract.startDate}
      />
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/edit">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/edit">
      <EditContract params={params} />
    </RouteGate>
  );
}
