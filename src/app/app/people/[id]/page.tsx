import { ArrowLeft, Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DataTable, type Column } from "@/components/data-table";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { addDays, firstOfNextMonth, formatDate } from "@/lib/dates";
import { maskAccount, maskRsaPin, ninStatus } from "@/lib/mask";
import { formatNaira, koboToMajorString, type Kobo } from "@/lib/money";
import {
  EMPLOYMENT_TYPE_LABELS,
  PAY_PERIOD,
  PAY_TYPE_LABELS,
  currentPayVersion,
  initials,
  payHeadline,
  payVersionState,
} from "@/lib/people";
import { ROLE_LABELS } from "@/lib/roles";
import type { PayRateVersion } from "@/server/people/pay-rates";
import { loadWorkerProfile, type WorkerProfile } from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";
import { canSeePii } from "@/server/people/pii-access";

import { RouteGate } from "../../_shell/slots";
import { CancelPayButton } from "../_components/cancel-pay-button";
import { DetailList, NotSet, Section } from "../_components/display";
import { EndEmploymentForm } from "../_components/end-employment-form";
import { PayChangeForm } from "../_components/pay-change-form";
import { RevealValue } from "../_components/reveal-value";

export const metadata: Metadata = { title: "Employee" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(kobo: Kobo | null): string | null {
  return kobo === null ? null : formatNaira(kobo);
}

function payBreakdown(rate: PayRateVersion): string {
  if (rate.payType !== "monthly")
    return `${formatNaira(payHeadline(rate))} ${PAY_PERIOD[rate.payType]}`;
  const parts = [`${formatNaira(rate.basic ?? 0n)} basic`];
  if (rate.housing) parts.push(`${formatNaira(rate.housing)} housing`);
  if (rate.transport) parts.push(`${formatNaira(rate.transport)} transport`);
  if (rate.otherAllowances) parts.push(`${formatNaira(rate.otherAllowances)} other`);
  return parts.join(" + ");
}

function PayHistory({
  versions,
  today,
  canEdit,
}: {
  versions: PayRateVersion[];
  today: string;
  canEdit: boolean;
}) {
  const latestId = versions.at(-1)?.id;
  const columns: Column<PayRateVersion>[] = [
    { key: "from", header: "From", cell: (v) => formatDate(v.effectiveFrom) },
    {
      key: "to",
      header: "To",
      cell: (v) => (v.effectiveTo ? formatDate(v.effectiveTo) : <NotSet>Open</NotSet>),
    },
    { key: "type", header: "Pay type", cell: (v) => PAY_TYPE_LABELS[v.payType] },
    {
      key: "amount",
      header: "Amount",
      kind: "money",
      cell: (v) => `${formatNaira(payHeadline(v))} ${PAY_PERIOD[v.payType]}`,
    },
    {
      key: "detail",
      header: "Made up of",
      className: "min-w-56 whitespace-normal",
      cell: (v) => payBreakdown(v),
    },
    {
      key: "state",
      header: "Status",
      cell: (v) => {
        const state = payVersionState(v, today);
        if (state === "current") return <Status tone="done">Current</Status>;
        if (state === "scheduled") {
          return (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Status tone="pending">Scheduled</Status>
              {canEdit && v.id === latestId ? (
                <CancelPayButton
                  payRateId={v.id}
                  label={`Cancel pay change from ${formatDate(v.effectiveFrom)}`}
                />
              ) : null}
            </span>
          );
        }
        return <span className="text-fg-muted">Ended</span>;
      },
    },
  ];
  return (
    <DataTable
      caption="Pay history"
      columns={columns}
      rows={[...versions].reverse()}
      getRowId={(v) => v.id}
      className="pay-history"
    />
  );
}

function amountsForForm(rate: PayRateVersion | null): Partial<Record<string, string>> {
  if (!rate) return {};
  const str = (kobo: Kobo | null) => (kobo === null ? undefined : koboToMajorString(kobo));
  return {
    basic: str(rate.basic),
    housing: str(rate.housing),
    transport: str(rate.transport),
    otherAllowances: str(rate.otherAllowances),
    dailyRate: str(rate.dailyRate),
    hourlyRate: str(rate.hourlyRate),
  };
}

function Profile({
  worker,
  ctx,
}: {
  worker: WorkerProfile;
  ctx: Awaited<ReturnType<typeof peoplePageContext>>;
}) {
  const { today, canEdit, role } = ctx;
  const active = worker.status === "active";
  const current = currentPayVersion(worker.payRates, today);
  const latest = worker.payRates.at(-1) ?? null;
  // A new version starts after the latest one, and never in the past.
  const minFrom =
    latest && latest.effectiveFrom >= today ? addDays(latest.effectiveFrom, 1) : today;
  const nextMonth = firstOfNextMonth(today);
  const defaultFrom = nextMonth > minFrom ? nextMonth : minFrom;

  return (
    <>
      <div className="flex flex-col gap-4">
        <Link
          href="/app/people"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted no-underline hover:text-foreground"
        >
          <ArrowLeft strokeWidth={1.75} className="size-4" aria-hidden />
          People
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span
              aria-hidden="true"
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-surface text-base font-semibold"
            >
              {initials(worker)}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="m-0 type-h1 break-words">{worker.name}</h1>
              <p className="m-0 type-body-lg text-fg-muted">
                {worker.jobTitle ? `${worker.jobTitle} · ` : ""}
                {worker.staffId}
              </p>
            </div>
          </div>
          {canEdit && active ? (
            <Button asChild variant="outline" className="h-10 rounded-lg">
              <Link href={`/app/people/${worker.id}/edit`}>
                <Pencil strokeWidth={1.75} aria-hidden />
                Edit details
              </Link>
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {active ? (
            <Status tone="done">Active</Status>
          ) : (
            <Status tone="pending">
              Left on {worker.endDate ? formatDate(worker.endDate) : "an earlier date"}
            </Status>
          )}
          {worker.mapped ? (
            <Status tone="done">Mapped</Status>
          ) : (
            <Status tone="pending" className="font-semibold">
              Mapping incomplete
            </Status>
          )}
          {worker.needsPayDetails ? (
            <Status tone="action">Needs pay details before payroll</Status>
          ) : null}
          {worker.supervisorClockIn ? <Status tone="pending">Supervisor clock-in</Status> : null}
        </div>
      </div>

      <Section id="job" title="Job and mapping">
        <DetailList
          items={[
            { label: "Department", value: worker.departmentName },
            { label: "Line manager", value: worker.lineManagerName },
            { label: "Site", value: worker.siteNames.join(", ") },
            { label: "Projects", value: worker.projectNames.join(", ") },
            { label: "Employment type", value: EMPLOYMENT_TYPE_LABELS[worker.employmentType] },
            { label: "Start date", value: formatDate(worker.startDate) },
            ...(worker.endDate ? [{ label: "End date", value: formatDate(worker.endDate) }] : []),
          ]}
        />
      </Section>

      <Section id="contact" title="Identity and contact">
        <DetailList
          items={[
            { label: "Staff ID", value: worker.staffId },
            { label: "Phone", value: worker.phone },
            { label: "Email", value: worker.email },
          ]}
        />
      </Section>

      <Section
        id="pay"
        title="Pay"
        description="Each change is a dated version. Versions already in force are never edited."
      >
        {worker.payRates.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            No pay on record yet. Payroll skips this employee until pay is added.
          </p>
        ) : (
          <>
            <DetailList
              items={[
                {
                  label: "Current pay",
                  value: current
                    ? `${formatNaira(payHeadline(current))} ${PAY_PERIOD[current.payType]}`
                    : "None in force today",
                  testId: "current-pay",
                },
                {
                  label: "Pay type",
                  value: current ? PAY_TYPE_LABELS[current.payType] : null,
                },
                {
                  label: "In force since",
                  value: current ? formatDate(current.effectiveFrom) : null,
                },
              ]}
            />
            <PayHistory versions={worker.payRates} today={today} canEdit={canEdit && active} />
          </>
        )}
        {canEdit && active ? (
          <PayChangeForm
            workerId={worker.id}
            defaultPayType={(current ?? latest)?.payType ?? "monthly"}
            defaultAmounts={amountsForForm(current ?? latest)}
            defaultFrom={
              worker.payRates.length === 0 && worker.startDate > today
                ? worker.startDate
                : defaultFrom
            }
            minFrom={worker.payRates.length === 0 ? worker.startDate : minFrom}
          />
        ) : null}
      </Section>

      <Section
        id="bank"
        title="Bank details"
        description="Changes need a second person to approve before payouts use them."
      >
        <DetailList
          items={[
            { label: "Bank", value: worker.bankName },
            { label: "Account name", value: worker.accountName },
            {
              label: "Account number",
              value: worker.bankAccountLast4 ? (
                <RevealValue
                  workerId={worker.id}
                  field="bank_account"
                  masked={maskAccount(worker.bankAccountLast4)}
                  canReveal={canSeePii(role, "bank_account")}
                  testId="bank-account"
                />
              ) : null,
            },
          ]}
        />
      </Section>

      <Section id="tax" title="Tax and pension">
        <DetailList
          items={[
            {
              label: "NIN",
              value: worker.ninOnFile ? (
                <span className="inline-flex flex-wrap items-center gap-x-3">
                  <span>{ninStatus(true)}</span>
                  {canSeePii(role, "nin") ? (
                    <RevealValue
                      workerId={worker.id}
                      field="nin"
                      masked=""
                      canReveal
                      testId="nin"
                    />
                  ) : null}
                </span>
              ) : (
                ninStatus(false)
              ),
            },
            { label: "TIN", value: worker.tin },
            { label: "Tax state", value: worker.taxState },
            { label: "Pension fund (PFA)", value: worker.pfaName },
            {
              label: "RSA PIN",
              value: worker.rsaPinOnFile ? (
                <RevealValue
                  workerId={worker.id}
                  field="rsa_pin"
                  masked={maskRsaPin(worker.rsaPinLast4) || "On file"}
                  canReveal={canSeePii(role, "rsa_pin")}
                  testId="rsa-pin"
                />
              ) : null,
            },
            { label: "National Housing Fund", value: worker.nhfOptIn ? "Contributes" : "No" },
            { label: "Annual rent declared", value: money(worker.annualRentDeclared) },
          ]}
        />
      </Section>

      <Section id="next-of-kin" title="Next of kin">
        <DetailList
          items={[
            { label: "Name", value: worker.nextOfKinName },
            { label: "Phone", value: worker.nextOfKinPhone },
          ]}
        />
      </Section>

      {canEdit && active ? (
        <Section
          id="end"
          title="End employment"
          description="Closes their site and project assignments on the last working day. The record and pay history stay."
        >
          <EndEmploymentForm workerId={worker.id} today={today} />
        </Section>
      ) : null}

      <p className="m-0 text-xs text-fg-muted">
        You are viewing as {ROLE_LABELS[role]}.{" "}
        {canSeePii(role, "bank_account") || canSeePii(role, "nin")
          ? "Showing personal data in full is recorded in the audit log."
          : "Personal data is masked for your role."}
      </p>
    </>
  );
}

async function WorkerPage({ params }: { params: PageProps<"/app/people/[id]">["params"] }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await peoplePageContext();
  const worker = await loadWorkerProfile(ctx.supabase, ctx.organisationId, id, ctx.today);
  if (!worker) notFound();
  return <Profile worker={worker} ctx={ctx} />;
}

export default function Page({ params }: PageProps<"/app/people/[id]">) {
  return (
    <RouteGate href="/app/people">
      <WorkerPage params={params} />
    </RouteGate>
  );
}
