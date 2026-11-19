import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { paymentTermsLabel } from "@/lib/company";
import { addDays, formatDate, lagosToday } from "@/lib/dates";
import {
  formatLineRate,
  formatOvertime,
  formatPercentBps,
  formatRateKey,
  formatRateSummary,
  versionState,
  type RateCardVersion,
} from "@/lib/rate-cards";
import { cn } from "@/lib/utils";
import { loadClient } from "@/server/business/clients-data";
import { BILLING_FREQUENCY_LABELS, CONTRACT_TYPE_LABELS } from "@/server/business/contract-schemas";
import { loadContract, type ContractDetail } from "@/server/business/contracts-data";
import { getActiveCompany } from "@/server/identity/company-data";

import { RouteGate } from "../../../../_shell/slots";
import { DetailList, Section } from "../../../../people/_components/display";
import { inheritedTermsLabel } from "../../../_components/contract-options";
import { clientsPageContext } from "../../../_components/context";
import { ContractStatusChip } from "../../../_components/contract-status";
import { CancelVersionButton, WhtRateForm } from "../../../_components/rate-forms";

export const metadata: Metadata = { title: "Contract" };

const TABS = [
  { id: "details", label: "Details" },
  { id: "rates", label: "Rate card" },
  { id: "headcount", label: "Headcount" },
  { id: "documents", label: "Documents" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function parseTab(value: string | string[] | undefined): TabId {
  const raw = Array.isArray(value) ? value[0] : value;
  return TABS.find((t) => t.id === raw)?.id ?? "details";
}

function TabLinks({ base, current }: { base: string; current: TabId }) {
  return (
    <nav aria-label="Contract sections" className="-mx-1 overflow-x-auto border-b border-line">
      <ul className="m-0 flex list-none gap-1 p-0 px-1">
        {TABS.map((tab) => {
          const active = tab.id === current;
          return (
            <li key={tab.id}>
              <Link
                href={tab.id === "details" ? base : `${base}?tab=${tab.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap no-underline",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-fg-muted hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function dateRange(from: string, to: string | null): string {
  return to ? `${formatDate(from)} to ${formatDate(to)}` : `From ${formatDate(from)}`;
}

const STATE_LABEL = { scheduled: "Scheduled", in_force: "In force", ended: "Ended" } as const;

/** One version: its dates, state and lines. */
function VersionCard({
  version,
  today,
  contract,
  canEdit,
}: {
  version: RateCardVersion;
  today: string;
  contract: ContractDetail;
  canEdit: boolean;
}) {
  const state = versionState(version, today);
  const isLatest = contract.versions[contract.versions.length - 1]?.id === version.id;
  const cancellable =
    canEdit &&
    isLatest &&
    contract.status !== "ended" &&
    (contract.status === "draft" ? contract.versions.length > 1 : state === "scheduled");
  return (
    <li
      className="flex flex-col gap-3 rounded-xl border border-line p-4"
      data-testid={`rate-version-${version.effectiveFrom}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {dateRange(version.effectiveFrom, version.effectiveTo)}
          </span>
          {version.note ? <span className="text-sm text-fg-muted">{version.note}</span> : null}
        </div>
        <div className="flex items-center gap-3">
          <Status
            tone={state === "in_force" ? "done" : state === "scheduled" ? "pending" : "partial"}
          >
            {contract.status === "draft" && state !== "scheduled" ? "Draft" : STATE_LABEL[state]}
          </Status>
          {cancellable ? (
            <CancelVersionButton
              kind="rate_card"
              id={version.id}
              clientId={contract.clientId}
              label={`Cancel the rates from ${formatDate(version.effectiveFrom)}`}
            />
          ) : null}
        </div>
      </div>
      <p className="m-0 text-sm text-fg-muted">{formatRateSummary(version.lines)}</p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Rates from {formatDate(version.effectiveFrom)}</caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="py-2 pr-3 font-semibold">
                Role · band
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">
                Rate
              </th>
              <th scope="col" className="py-2 text-right font-semibold">
                Overtime
              </th>
            </tr>
          </thead>
          <tbody>
            {version.lines.map((line) => (
              <tr key={formatRateKey(line)} className="border-b border-line last:border-0">
                <td className="py-2 pr-3">{formatRateKey(line)}</td>
                <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                  {formatLineRate(line)}
                </td>
                <td className="py-2 text-right whitespace-nowrap tabular-nums">
                  {formatOvertime(line)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </li>
  );
}

function RatesTab({
  contract,
  today,
  canEdit,
}: {
  contract: ContractDetail;
  today: string;
  canEdit: boolean;
}) {
  const base = `/app/clients/${contract.clientId}/contracts/${contract.id}/rates`;
  const editable = canEdit && contract.status !== "ended";
  const draftSingle = contract.status === "draft" && contract.versions.length <= 1;
  const actions = editable ? (
    <div className="flex flex-wrap gap-2">
      {draftSingle ? (
        <Button
          asChild
          variant={contract.versions.length === 0 ? "default" : "outline"}
          className="h-11 px-4"
        >
          <Link href={base}>
            {contract.versions.length === 0 ? "Add rate card" : "Edit rate card"}
          </Link>
        </Button>
      ) : null}
      {contract.versions.length > 0 ? (
        <Button asChild variant={draftSingle ? "outline" : "default"} className="h-11 px-4">
          <Link href={`${base}?mode=change`}>Change rates from</Link>
        </Button>
      ) : null}
    </div>
  ) : null;

  if (contract.versions.length === 0) {
    return (
      <EmptyState
        message="No rate card yet. Add what the client pays per shift, hour, visit, month or job."
        action={actions}
      />
    );
  }
  const newestFirst = [...contract.versions].reverse();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="m-0 text-sm text-fg-muted">
          Rates are without VAT. A change is a new version from a date; versions in force stay as
          they were.
        </p>
        {actions}
      </div>
      <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Rate card versions">
        {newestFirst.map((version) => (
          <VersionCard
            key={version.id}
            version={version}
            today={today}
            contract={contract}
            canEdit={canEdit}
          />
        ))}
      </ol>
    </div>
  );
}

function DetailsTab({
  contract,
  termsLabel,
  today,
  canEditWht,
}: {
  contract: ContractDetail;
  termsLabel: string;
  today: string;
  canEditWht: boolean;
}) {
  const sla = contract.sla;
  const whtNewestFirst = [...contract.whtRates].reverse();
  const latestWht = contract.whtRates[contract.whtRates.length - 1];
  const minFrom = contract.status === "draft" ? contract.startDate : today;
  const defaultWhtFrom =
    contract.status === "draft"
      ? latestWht
        ? addDays(latestWht.effectiveFrom > today ? latestWht.effectiveFrom : today, 1)
        : contract.startDate
      : addDays(today, 1);
  return (
    <div className="flex flex-col gap-8">
      <Section id="terms" title="Terms">
        <DetailList
          items={[
            { label: "Reference", value: contract.reference, testId: "contract-reference" },
            { label: "Type", value: CONTRACT_TYPE_LABELS[contract.type] },
            {
              label: "Dates",
              value:
                dateRange(contract.startDate, contract.endDate) +
                (contract.endDate ? "" : " (rolling)"),
            },
            {
              label: "Go-live",
              value: contract.goLiveDate ? formatDate(contract.goLiveDate) : "At activation",
            },
            { label: "Invoice", value: BILLING_FREQUENCY_LABELS[contract.billingFrequency] },
            {
              label: "Payment terms",
              value:
                contract.billingTermsDays === null
                  ? termsLabel
                  : paymentTermsLabel(contract.billingTermsDays),
            },
            { label: "VAT", value: contract.vatApplies ? "Charged (7.5%)" : "Not charged" },
            {
              label: "Sites",
              value: contract.sites.length ? contract.sites.map((s) => s.name).join(", ") : null,
            },
          ]}
        />
      </Section>
      <Section id="sla" title="Service level">
        <DetailList
          items={[
            {
              label: "Coverage target",
              value:
                sla.coverage_target_bps === undefined
                  ? null
                  : formatPercentBps(sla.coverage_target_bps),
            },
            {
              label: "Response time",
              value: sla.response_minutes === undefined ? null : `${sla.response_minutes} minutes`,
            },
            { label: "Notes", value: sla.notes ?? null },
          ]}
        />
      </Section>
      <Section
        id="wht"
        title="Withholding tax"
        description="The rate the client deducts on payment. Applied to invoices from Phase 6."
      >
        {whtNewestFirst.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted" data-testid="wht-none">
            No WHT rate yet.
          </p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0"
            aria-label="WHT history"
          >
            {whtNewestFirst.map((rate, index) => {
              const state = versionState(rate, today);
              const cancellable =
                canEditWht &&
                index === 0 &&
                contract.status !== "ended" &&
                (contract.status === "draft" || state === "scheduled");
              return (
                <li
                  key={rate.id}
                  className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-4 py-2"
                >
                  <span>
                    <span className="font-medium tabular-nums">
                      {formatPercentBps(rate.rateBps)}
                    </span>{" "}
                    <span className="text-sm text-fg-muted">
                      {dateRange(rate.effectiveFrom, rate.effectiveTo)}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Status
                      tone={
                        state === "in_force"
                          ? "done"
                          : state === "scheduled"
                            ? "pending"
                            : "partial"
                      }
                    >
                      {STATE_LABEL[state]}
                    </Status>
                    {cancellable ? (
                      <CancelVersionButton
                        kind="wht"
                        id={rate.id}
                        clientId={contract.clientId}
                        label={`Cancel the WHT rate from ${formatDate(rate.effectiveFrom)}`}
                      />
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {canEditWht && contract.status !== "ended" ? (
          <WhtRateForm
            clientId={contract.clientId}
            contractId={contract.id}
            defaultFrom={defaultWhtFrom}
            minFrom={minFrom}
            hasRate={contract.whtRates.length > 0}
          />
        ) : null}
      </Section>
    </div>
  );
}

async function ContractPage({
  params,
  searchParams,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]">["params"];
  searchParams: PageProps<"/app/clients/[clientId]/contracts/[contractId]">["searchParams"];
}) {
  const [{ clientId, contractId }, query] = await Promise.all([params, searchParams]);
  const tab = parseTab(query.tab);
  const ctx = await clientsPageContext();
  const [contract, client, company] = await Promise.all([
    loadContract(ctx.supabase, ctx.organisationId, clientId, contractId),
    loadClient(ctx.supabase, ctx.organisationId, clientId),
    getActiveCompany(),
  ]);
  if (!contract || !client) notFound();
  const today = lagosToday();
  const base = `/app/clients/${clientId}/contracts/${contract.id}`;

  return (
    <>
      <PageHeader
        back={{ href: `/app/clients/${clientId}?tab=contracts`, label: contract.clientName }}
        eyebrow={`${contract.clientName} · ${contract.reference}`}
        title={contract.name}
        description={`${CONTRACT_TYPE_LABELS[contract.type]} · ${dateRange(contract.startDate, contract.endDate)} · ${contract.sites.length} ${contract.sites.length === 1 ? "site" : "sites"}`}
        actions={
          <>
            <ContractStatusChip status={contract.status} />
            {ctx.canEditContracts && contract.status === "draft" ? (
              <Button asChild variant="outline" className="h-11 px-4">
                <Link href={`${base}/edit`}>Edit contract</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <TabLinks base={base} current={tab} />
      {tab === "details" ? (
        <DetailsTab
          contract={contract}
          termsLabel={inheritedTermsLabel(client.billingTermsDays, company?.paymentTermsDays ?? 30)}
          today={today}
          canEditWht={ctx.canEditWht}
        />
      ) : null}
      {tab === "rates" ? (
        <RatesTab contract={contract} today={today} canEdit={ctx.canEditContracts} />
      ) : null}
      {tab === "headcount" ? (
        <EmptyState message="No headcount yet. Posts, shifts and how many people each needs come here next." />
      ) : null}
      {tab === "documents" ? (
        <EmptyState message="No documents yet. Signed contracts and SLAs are uploaded here next." />
      ) : null}
    </>
  );
}

export default function Page({
  params,
  searchParams,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]">
      <ContractPage params={params} searchParams={searchParams} />
    </RouteGate>
  );
}
