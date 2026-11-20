import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { addDays } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";
import { loadAddPostContext } from "@/server/business/live-changes-data";

import { RouteGate } from "../../../../../../_shell/slots";
import { clientsPageContext } from "../../../../../_components/context";
import { AddPostForm } from "../../../../../_components/live-change-forms";

export const metadata: Metadata = { title: "Add post" };

async function AddPostPage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/new">["params"];
}) {
  const { clientId, contractId } = await params;
  const ctx = await clientsPageContext();
  const context = await loadAddPostContext(ctx.supabase, ctx.organisationId, contractId);
  if (!context || context.contract.clientId !== clientId) notFound();
  const { contract } = context;
  const back = `/app/clients/${clientId}/contracts/${contractId}?tab=posts`;
  if (
    !ctx.canEditContracts ||
    contract.status !== "active" ||
    (contract.endDate !== null && contract.endDate < ctx.today)
  ) {
    redirect(back);
  }
  // Next Monday by default (or the go-live date if later), inside the contract's dates.
  const monday = addDays(ctx.today, 8 - isoWeekday(ctx.today));
  const goLive = contract.goLiveDate ?? ctx.today;
  let initialFrom = goLive > monday ? goLive : monday;
  if (contract.endDate !== null && initialFrom > contract.endDate) {
    initialFrom = goLive > ctx.today ? goLive : ctx.today;
  }
  // Rate keys only: no amounts cross to the browser.
  const rates = context.rates.map((v) => ({
    id: v.id,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
    lines: v.lines.map((l) => ({ role: l.role, band: l.band, unit: l.unit })),
  }));
  return (
    <>
      <PageHeader
        back={{ href: back, label: contract.name }}
        eyebrow={`${contract.clientName} · ${contract.reference}`}
        title="Add post"
        description="A new place to staff on this live contract, from a date. Its role and band need a line on the rate card."
      />
      <AddPostForm
        key={context.sites.map((s) => `${s.id}${s.onContract ? "+" : ""}`).join(",")}
        clientId={clientId}
        contract={contract}
        today={ctx.today}
        sites={context.sites}
        openPostNames={context.openPostNames}
        rates={rates}
        initialFrom={initialFrom}
        back={back}
      />
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/new">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/posts/new">
      <AddPostPage params={params} />
    </RouteGate>
  );
}
