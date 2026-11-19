import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { loadClient } from "@/server/business/clients-data";

import { RouteGate } from "../../../../_shell/slots";
import { clientsPageContext } from "../../../_components/context";
import { SiteDetailsForm } from "../../../_components/site-forms";

export const metadata: Metadata = { title: "Add site" };

async function NewSite({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/sites/new">["params"];
}) {
  const { clientId } = await params;
  const ctx = await clientsPageContext();
  const client = await loadClient(ctx.supabase, ctx.organisationId, clientId);
  if (!client || client.status !== "active") notFound();
  return (
    <>
      <PageHeader
        back={{ href: `/app/clients/${client.id}?tab=sites`, label: client.name }}
        eyebrow={client.name}
        title="Add site"
        description="Name the place and where it is. Set its geofence and checkpoints on the next page."
      />
      <SiteDetailsForm mode="create" clientId={client.id} />
    </>
  );
}

export default function Page({ params }: PageProps<"/app/clients/[clientId]/sites/new">) {
  return (
    <RouteGate href="/app/clients/[id]/sites/new">
      <NewSite params={params} />
    </RouteGate>
  );
}
