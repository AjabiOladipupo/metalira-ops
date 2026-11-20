import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { loadActivationContext, loadPosts } from "@/server/business/activation-data";

import { RouteGate } from "../../../../../_shell/slots";
import { EndContractForm } from "../../../../_components/activation-forms";
import { clientsPageContext } from "../../../../_components/context";

export const metadata: Metadata = { title: "End contract" };

async function EndPage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/end">["params"];
}) {
  const { clientId, contractId } = await params;
  const ctx = await clientsPageContext();
  const [context, posts] = await Promise.all([
    loadActivationContext(ctx.supabase, ctx.organisationId, contractId),
    loadPosts(ctx.supabase, ctx.organisationId, contractId, ctx.today),
  ]);
  if (!context || context.contract.clientId !== clientId) notFound();
  const base = `/app/clients/${clientId}/contracts/${contractId}`;
  if (
    !ctx.canEditContracts ||
    context.contract.status !== "active" ||
    context.contract.endReason !== null
  ) {
    redirect(`${base}?tab=posts`);
  }
  return (
    <>
      <PageHeader
        back={{ href: `${base}?tab=posts`, label: context.contract.name }}
        eyebrow={`${context.clientName} · ${context.contract.reference}`}
        title="End contract"
        description="Choose the last day you provide the service. Posts, roster requirements and rates close on that day; nothing is deleted."
      />
      <EndContractForm
        clientId={clientId}
        contractId={contractId}
        today={ctx.today}
        goLiveDate={context.contract.goLiveDate}
        endDate={context.contract.endDate}
        openPosts={posts.filter((p) => p.status === "open").length}
      />
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/end">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/end">
      <EndPage params={params} />
    </RouteGate>
  );
}
