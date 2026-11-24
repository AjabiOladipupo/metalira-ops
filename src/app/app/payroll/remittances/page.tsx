import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatLeaveRange } from "@/lib/leave/requests";
import { formatNaira, koboToMajorString, sumKobo } from "@/lib/money";
import { TAX_ADVISER_LINE } from "@/lib/payroll/rule-set";
import { runMonth } from "@/lib/payroll/run-format";
import { REMITTANCE_STATUS, remittanceTitle } from "@/lib/payroll/statutory";
import { loadRemittances, type RemittanceRow } from "@/server/payroll/remittance-data";
import { canRecordRemittances } from "@/server/payroll/remittances";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import {
  ReceiptLinkButton,
  RecordPaymentForm,
  VoidPaymentForm,
} from "./_components/remittance-forms";

export const metadata: Metadata = { title: "Statutory remittances" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function dueText(r: RemittanceRow): string {
  if (r.dueDate) {
    return `Due ${formatDate(r.dueDate)} (worked out on ${formatDate(r.createdAt.slice(0, 10))})`;
  }
  return r.kind === "itf" ? "Accrued monthly; no due date set" : "No due date set";
}

function RemittanceCard({
  r,
  canRecord,
  today,
  periodStart,
}: {
  r: RemittanceRow;
  canRecord: boolean;
  today: string;
  periodStart: string;
}) {
  const title = remittanceTitle(r.kind, r.authorityName);
  const status = REMITTANCE_STATUS[r.status];
  const paid = r.payment;
  const gap = paid ? paid.paidAmountKobo - r.amountKobo : 0n;
  return (
    <li
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
      data-testid="remittance"
      aria-label={title}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="m-0 text-base font-semibold break-words">{title}</h3>
          <p className="m-0 text-sm text-fg-muted">
            {r.workerCount} {r.workerCount === 1 ? "worker" : "workers"} · {dueText(r)}
          </p>
        </div>
        {r.runVoid ? (
          <Status tone="pending">Voided</Status>
        ) : (
          <Status tone={status.tone}>{status.label}</Status>
        )}
      </div>
      {r.runVoid ? (
        <p
          className="m-0 rounded-lg border border-line px-3 py-2 text-sm"
          data-testid="remittance-run-void"
        >
          Voided {formatDateTime(r.runVoid.voidedAt)}: the run was reversed, so nothing is owed for
          it.
          {paid ? (
            <strong className="block font-semibold" data-testid="refund-needed">
              Refund or offset needed: {formatNaira(paid.paidAmountKobo)} was already paid to the
              authority. The payment record stays on file.
            </strong>
          ) : null}
        </p>
      ) : null}
      <p
        className="m-0 font-heading text-2xl font-medium tabular-nums"
        data-testid="remittance-amount"
      >
        {formatNaira(r.amountKobo)}
      </p>
      {r.kind === "pension" ? (
        <p className="m-0 -mt-2 text-xs text-fg-muted">Employee and employer shares together.</p>
      ) : null}
      {r.authorityVariants.length > 1 ? (
        <p
          className="m-0 rounded-lg border border-line px-3 py-2 text-xs"
          data-testid="variants-note"
        >
          Spelled {r.authorityVariants.length} ways on the payslips, counted as one:{" "}
          {r.authorityVariants.join(", ")}. Check the people&apos;s{" "}
          {r.kind === "paye" ? "tax state" : "PFA"} if these are different authorities.
        </p>
      ) : null}

      {paid ? (
        <div
          className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2.5 text-sm"
          data-testid="remittance-paid"
        >
          <span className="font-medium">
            Paid {formatNaira(paid.paidAmountKobo)} on {formatDate(paid.paidOn)}
            {paid.reference ? ` · ref ${paid.reference}` : ""}
          </span>
          {gap !== 0n ? (
            <span className="font-medium">
              {gap < 0n
                ? `${formatNaira(-gap)} still owed`
                : `${formatNaira(gap)} more than due: check with the authority`}
            </span>
          ) : null}
          <span className="text-fg-muted">
            Recorded by {paid.recordedByName} · {formatDateTime(paid.recordedAt)}
          </span>
          <ReceiptLinkButton paymentId={paid.id} />
        </div>
      ) : null}

      {r.runVoid ? null : (
        <div className="flex flex-wrap items-start gap-3">
          {/* A plain link: the route streams the CSV (no-store, attachment); nothing is stored. */}
          <a
            href={`/app/payroll/remittances/${r.id}/schedule`}
            aria-label={`Download schedule: ${title}`}
            className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-medium text-foreground no-underline hover:bg-surface hover:text-foreground"
          >
            Download schedule
          </a>
        </div>
      )}

      {canRecord && !paid && !r.runVoid ? (
        <details className="rounded-lg border border-line px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-semibold">Record payment</summary>
          <div className="pt-3">
            <RecordPaymentForm
              remittanceId={r.id}
              amountDue={koboToMajorString(r.amountKobo)}
              today={today}
              minDate={periodStart}
            />
          </div>
        </details>
      ) : null}
      {canRecord && paid && !r.runVoid ? (
        <details className="rounded-lg border border-line px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">This record is wrong</summary>
          <div className="pt-3">
            <VoidPaymentForm paymentId={paid.id} />
          </div>
        </details>
      ) : null}

      {r.voided.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs text-fg-muted"
          aria-label="Voided records"
        >
          {r.voided.map((v) => (
            <li key={v.id}>
              Voided: {formatNaira(v.paidAmountKobo)} on {formatDate(v.paidOn)}, by{" "}
              {v.void.voidedByName} · {formatDateTime(v.void.voidedAt)}. {v.void.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

async function RemittancesPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/payroll/remittances">["searchParams"];
}) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const runParam = first(query.run);
  const runId = runParam && UUID.test(runParam) ? runParam : undefined;
  const runs = await loadRemittances(ctx.supabase, ctx.organisationId, ctx.today, { runId });
  const canRecord = canRecordRemittances(ctx.role);
  const all = runs.flatMap((r) => r.remittances);
  const overdue = all.filter((r) => r.overdue).length;
  const outstanding = sumKobo(all.map((r) => r.outstandingKobo));

  return (
    <>
      <PageHeader
        back={{ href: "/app/payroll", label: "Payroll run" }}
        eyebrow="Payroll"
        title="Statutory remittances"
        description={`${all.length} ${all.length === 1 ? "remittance" : "remittances"} · ${overdue} overdue · ${formatNaira(outstanding, { whole: true })} still to pay. You pay each authority from your own bank account; record each payment here with its receipt.`}
      />

      <div
        className="flex flex-col gap-1 rounded-xl border border-foreground bg-surface px-4 py-3"
        data-testid="adviser-line"
      >
        <p className="m-0 text-[15px] font-semibold">{TAX_ADVISER_LINE}</p>
        <p className="m-0 text-sm text-fg-muted">
          Pension is due by the 7th working day counting the pay date (or the working day before it,
          when it falls on a weekend or holiday), leaving out weekends and your public holidays.
          PAYE, NHF, NSITF and ITF have a due date only when you set one in{" "}
          <Link href="/app/settings/payroll#due-days" className="text-signal">
            Payroll rules
          </Link>
          .
        </p>
      </div>

      {runId ? (
        <p className="m-0 text-sm">
          <Link href="/app/payroll/remittances" className="text-signal">
            Show every posted run
          </Link>
        </p>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState message="No posted payroll yet. Remittances appear here once a run is approved." />
      ) : (
        runs.map((run) => {
          const heading = `run-${run.id}`;
          return (
            <section key={run.id} aria-labelledby={heading} className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 id={heading} className="m-0 type-h2">
                  {runMonth(run.periodEnd)}
                  {run.kind === "off_cycle" ? " · off-cycle" : ""}
                </h2>
                <p className="m-0 text-sm text-fg-muted">
                  {formatLeaveRange(run.periodStart, run.periodEnd)} · paid{" "}
                  {formatDate(run.payDate)} ·{" "}
                  <Link href={`/app/payroll/${run.id}?step=submit`} className="text-signal">
                    Open the run
                  </Link>
                </p>
              </div>
              {run.remittances.length === 0 ? (
                <p className="m-0 text-sm text-fg-muted">This run owes no remittances.</p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-4 p-0">
                  {run.remittances.map((r) => (
                    <RemittanceCard
                      key={r.id}
                      r={r}
                      canRecord={canRecord}
                      today={ctx.today}
                      periodStart={run.periodStart}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/payroll/remittances">) {
  return (
    <RouteGate href="/app/payroll/remittances">
      <RemittancesPage searchParams={searchParams} />
    </RouteGate>
  );
}
