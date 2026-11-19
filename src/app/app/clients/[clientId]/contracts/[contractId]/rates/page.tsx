import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { addDays, lagosToday } from "@/lib/dates";
import { toRateLineInput } from "@/lib/rate-cards";
import { loadContract } from "@/server/business/contracts-data";

import { RouteGate } from "../../../../../_shell/slots";
import { clientsPageContext } from "../../../../_components/context";
import { RateCardEditor, type EditorVersion } from "../../../../_components/rate-card-editor";

export const metadata: Metadata = { title: "Rate card" };

async function RateCardPage({
  params,
  searchParams,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/rates">["params"];
  searchParams: PageProps<"/app/clients/[clientId]/contracts/[contractId]/rates">["searchParams"];
}) {
  const [{ clientId, contractId }, query] = await Promise.all([params, searchParams]);
  const ctx = await clientsPageContext();
  const contract = await loadContract(ctx.supabase, ctx.organisationId, clientId, contractId);
  if (!contract) notFound();
  const back = `/app/clients/${clientId}/contracts/${contract.id}?tab=rates`;
  if (contract.status === "ended") redirect(back);

  const today = lagosToday();
  const latest = contract.versions[contract.versions.length - 1] ?? null;
  // A draft with one card (or none) edits it whole; anything else is a dated change.
  const mode: "draft" | "change" =
    query.mode !== "change" && contract.status === "draft" && contract.versions.length <= 1
      ? "draft"
      : "change";
  if (mode === "change" && !latest) redirect(back);

  const versions: EditorVersion[] = contract.versions.map((v) => ({
    id: v.id,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
    note: v.note,
    lines: v.lines.map(toRateLineInput),
  }));
  const firstAllowed =
    mode === "draft"
      ? contract.startDate
      : contract.status === "draft"
        ? addDays(latest!.effectiveFrom, 1)
        : [today, addDays(latest!.effectiveFrom, 1)].sort().at(-1)!;
  const defaultFrom =
    mode === "draft" ? (latest?.effectiveFrom ?? contract.startDate) : firstAllowed;

  return (
    <>
      <PageHeader
        back={{ href: back, label: contract.name }}
        eyebrow={`${contract.clientName} · ${contract.reference}`}
        title={mode === "draft" ? "Rate card" : "Change rates from"}
        description={
          mode === "draft"
            ? "What the client pays, without VAT. You can change it freely until the contract is activated."
            : "Adds a new version from a date. The current rates stay on record and end the day before."
        }
      />
      {/* Keyed on what it edits: a route kept alive by the router (cacheComponents) must not
          carry the last visit's typed lines into a different card or mode. */}
      <RateCardEditor
        key={`${mode}:${contract.versions.map((v) => v.id).join(",")}`}
        mode={mode}
        clientId={clientId}
        contractId={contract.id}
        contract={{
          status: contract.status,
          startDate: contract.startDate,
          endDate: contract.endDate,
        }}
        versions={versions}
        initialLines={latest ? latest.lines.map(toRateLineInput) : []}
        defaultFrom={defaultFrom}
        minFrom={firstAllowed}
        today={today}
      />
    </>
  );
}

export default function Page({
  params,
  searchParams,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/rates">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/rates">
      <RateCardPage params={params} searchParams={searchParams} />
    </RouteGate>
  );
}
