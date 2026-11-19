import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { loadClient } from "@/server/business/clients-data";
import { getActiveCompany } from "@/server/identity/company-data";

import { RouteGate } from "../../../../_shell/slots";
import { ContractForm } from "../../../_components/contract-form";
import {
  BILLING_FREQUENCY_OPTIONS,
  CONTRACT_TYPE_OPTIONS,
  TERMS_OPTIONS,
  inheritedTermsLabel,
} from "../../../_components/contract-options";
import { clientsPageContext } from "../../../_components/context";

export const metadata: Metadata = { title: "Add contract" };

async function NewContract({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/new">["params"];
}) {
  const { clientId } = await params;
  const ctx = await clientsPageContext();
  const [client, company] = await Promise.all([
    loadClient(ctx.supabase, ctx.organisationId, clientId),
    getActiveCompany(),
  ]);
  if (!client) notFound();
  return (
    <>
      <PageHeader
        back={{ href: `/app/clients/${client.id}?tab=contracts`, label: client.name }}
        eyebrow={client.name}
        title="Add contract"
        description="Saved as a draft. Add the rate card next; nothing is billed until the contract is activated."
      />
      <ContractForm
        mode="create"
        clientId={client.id}
        sites={client.sites}
        types={CONTRACT_TYPE_OPTIONS}
        frequencies={BILLING_FREQUENCY_OPTIONS}
        terms={TERMS_OPTIONS}
        companyTermsLabel={inheritedTermsLabel(
          client.billingTermsDays,
          company?.paymentTermsDays ?? 30,
        )}
        defaultVat={company?.vatRegistered ?? false}
        defaultStart={ctx.today}
      />
    </>
  );
}

export default function Page({ params }: PageProps<"/app/clients/[clientId]/contracts/new">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/new">
      <NewContract params={params} />
    </RouteGate>
  );
}
