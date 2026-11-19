import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { loadClient } from "@/server/business/clients-data";
import { getActiveCompany } from "@/server/identity/company-data";

import { RouteGate } from "../../../_shell/slots";
import { ClientForm } from "../../_components/client-form";
import { clientsPageContext } from "../../_components/context";

export const metadata: Metadata = { title: "Edit client" };

async function EditClient({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/edit">["params"];
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
        back={{ href: `/app/clients/${client.id}`, label: client.name }}
        eyebrow="Clients"
        title={`Edit ${client.name}`}
        description="Changes apply to invoices raised from now on. Posted invoices keep what they were issued with."
      />
      <ClientForm mode="edit" client={client} companyTermsDays={company?.paymentTermsDays ?? 30} />
    </>
  );
}

export default function Page({ params }: PageProps<"/app/clients/[clientId]/edit">) {
  return (
    <RouteGate href="/app/clients/[id]/edit">
      <EditClient params={params} />
    </RouteGate>
  );
}
