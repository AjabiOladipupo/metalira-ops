import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import type { ActivationCode } from "@/lib/activation";
import { formatDate } from "@/lib/dates";
import { loadActivationPlan } from "@/server/business/activation-data";

import { RouteGate } from "../../../../../_shell/slots";
import { ActivateContractForm } from "../../../../_components/activation-forms";
import { clientsPageContext } from "../../../../_components/context";

export const metadata: Metadata = { title: "Activate contract" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Where each checklist item is fixed. */
function fixLink(
  code: ActivationCode,
  clientId: string,
  base: string,
): { href: string; label: string } | null {
  switch (code) {
    case "MLCT2":
      return { href: `/app/clients/${clientId}?tab=contacts`, label: "Add a billing contact" };
    case "MLCT3":
    case "MLCT8":
      return { href: `/app/clients/${clientId}?tab=sites`, label: "Open the sites" };
    case "MLCT4":
    case "MLCT5":
    case "MLCT9":
      return { href: `${base}?tab=rates`, label: "Open the rate card" };
    case "MLCT6":
      return { href: `${base}?tab=headcount`, label: "Open the headcount" };
    case "MLCT7":
      return { href: `${base}/edit`, label: "Change the dates" };
    default:
      return null;
  }
}

async function ActivatePage({
  params,
  searchParams,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/activate">["params"];
  searchParams: PageProps<"/app/clients/[clientId]/contracts/[contractId]/activate">["searchParams"];
}) {
  const [{ clientId, contractId }, query] = await Promise.all([params, searchParams]);
  const ctx = await clientsPageContext();
  const raw = Array.isArray(query.goLive) ? query.goLive[0] : query.goLive;
  const goLiveDate = raw && ISO_DATE.test(raw) ? raw : null;
  const loaded = await loadActivationPlan(ctx.supabase, ctx.organisationId, contractId, {
    today: ctx.today,
    goLiveDate,
  });
  if (!loaded || loaded.context.contract.clientId !== clientId) notFound();
  const { context, plan } = loaded;
  const base = `/app/clients/${clientId}/contracts/${contractId}`;
  if (!ctx.canEditContracts || context.contract.status !== "draft") redirect(base);

  return (
    <>
      <PageHeader
        back={{ href: base, label: context.contract.name }}
        eyebrow={`${context.clientName} · ${context.contract.reference}`}
        title="Activate contract"
        description="Activation turns the headcount into posts and dated roster requirements. Rosters, attendance and invoices work from them."
      />
      <section aria-labelledby="checklist" className="flex flex-col gap-3">
        <h2 id="checklist" className="m-0 type-h3">
          Checklist
        </h2>
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="activation-checklist">
          {plan.checks.map((check) => {
            const fix = check.ok ? null : fixLink(check.code, clientId, base);
            return (
              <li
                key={check.code}
                aria-label={check.label}
                className="flex flex-col gap-1 rounded-xl border border-line p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{check.label}</span>
                  <Status tone={check.ok ? "done" : "action"}>
                    {check.ok ? "Ready" : "Missing"}
                  </Status>
                </div>
                {check.messages.map((m) => (
                  <p key={m} className="m-0 text-sm">
                    {m}
                  </p>
                ))}
                {fix ? (
                  <Link href={fix.href} className="text-sm">
                    {fix.label}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Go-live date">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Go-live date
          <input
            type="date"
            name="goLive"
            defaultValue={plan.goLiveDate}
            min={ctx.today > context.contract.startDate ? ctx.today : context.contract.startDate}
            max={context.contract.endDate ?? undefined}
            className="h-11 rounded-xl border border-line bg-background px-3 text-[15px]"
          />
        </label>
        <Button type="submit" variant="outline" className="h-11 px-4">
          Check this date
        </Button>
      </form>

      {plan.posts.length > 0 ? (
        <section aria-labelledby="posts-preview" className="flex flex-col gap-3">
          <h2 id="posts-preview" className="m-0 type-h3">
            Posts from {formatDate(plan.goLiveDate)}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {plan.posts.map((post) => (
              <li
                key={post.headcountId}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line py-2 text-sm last:border-0"
              >
                <span className="font-medium">
                  {post.name} <span className="font-normal text-fg-muted">at {post.siteName}</span>
                </span>
                <span className="text-fg-muted tabular-nums">
                  {post.days} · {post.hours} · {post.requiredCount} required
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ActivateContractForm
        key={plan.goLiveDate}
        clientId={clientId}
        contractId={contractId}
        goLiveDate={plan.goLiveDate}
        ready={plan.ready}
        summary={plan.summary}
      />
    </>
  );
}

export default function Page({
  params,
  searchParams,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/activate">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/activate">
      <ActivatePage params={params} searchParams={searchParams} />
    </RouteGate>
  );
}
