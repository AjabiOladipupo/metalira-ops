import type { Metadata } from "next";
import { Suspense } from "react";

import { Illustration } from "@/components/illustration";
import { formatDate } from "@/lib/dates";
import { createServerSupabase } from "@/lib/supabase/server";
import { workerMessages } from "@/lib/messages/worker";
import {
  appNaira,
  lessNaira,
  paidToLine,
  pensionLine,
  rentLine,
  signedNaira,
  type PayslipLineView,
  type PayslipView,
} from "@/lib/payroll/payslip-view";
import { cn } from "@/lib/utils";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { loadMyPayslips } from "@/server/payroll/payslip-reads";

import { WorkerTopBar } from "../../_components/worker-top-bar";
import { AskHrButton, DownloadPdfButton, MonthSwitcher } from "./payslip-controls";

export const metadata: Metadata = { title: "Payslips" };

const copy = workerMessages.payslips;

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={cn(
        "flex justify-between gap-3 py-2.5 text-[15px]",
        strong ? "font-semibold" : "border-b border-line",
      )}
    >
      <span className="min-w-0 break-words">{label}</span>
      <span className="whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

function Lines({ lines, less }: { lines: readonly PayslipLineView[]; less?: boolean }) {
  return lines.map((l, i) => (
    <Line
      key={`${l.code}-${i}`}
      label={l.label}
      value={less ? lessNaira(l.amountKobo) : signedNaira(l.amountKobo)}
    />
  ));
}

function Payslip({ view }: { view: PayslipView }) {
  const pension = pensionLine(view);
  const rent = rentLine(view);
  const ytd = view.yearToDate;
  return (
    <div className="flex flex-col gap-4" data-testid="payslip" data-payslip-id={view.payslipId}>
      <section
        aria-label="Net pay"
        className="flex flex-col gap-1.5 rounded-xl bg-foreground p-5 text-background"
      >
        <span className="type-label opacity-70">{copy.youReceived(view.month)}</span>
        <span
          className="font-display text-[44px] leading-[1.05] font-bold tabular-nums"
          data-testid="payslip-net"
        >
          {appNaira(view.netKobo)}
        </span>
        <span className="text-sm opacity-80" data-testid="payslip-paid-to">
          {paidToLine(view)}
        </span>
      </section>

      <section aria-labelledby="earn">
        <h2 id="earn" className="m-0 mb-1 type-label text-fg-muted">
          {copy.earned}
        </h2>
        <Lines lines={view.earned} />
        <Line label={copy.grossPay} value={appNaira(view.grossKobo)} strong />
      </section>

      <section aria-labelledby="ded">
        <h2 id="ded" className="m-0 mb-1 type-label text-fg-muted">
          {copy.takenOut}
        </h2>
        <Lines lines={view.takenOut} less />
        <Line label={copy.totalTakenOut} value={lessNaira(view.totalTakenOutKobo)} strong />
        {view.carriedForwardKobo > 0n ? (
          <p className="m-0 text-[13px] text-fg-muted">
            {copy.carried(appNaira(view.carriedForwardKobo))}
          </p>
        ) : null}
      </section>

      {view.employer.length > 0 ? (
        <section
          aria-labelledby="emp"
          className="flex flex-col gap-1.5 rounded-xl bg-surface px-4 py-3.5"
        >
          <h2 id="emp" className="m-0 type-label text-fg-muted">
            {copy.employer}
          </h2>
          {view.employer.map((l, i) => (
            <span key={`${l.code}-${i}`} className="flex justify-between gap-3 text-[15px]">
              <span>{l.label}</span>
              <span className="tabular-nums">{appNaira(l.amountKobo)}</span>
            </span>
          ))}
          {pension ? <span className="text-[13px] text-fg-muted">{pension}</span> : null}
        </section>
      ) : null}

      <section aria-labelledby="ytd">
        <h2 id="ytd" className="m-0 mb-1 type-label text-fg-muted">
          {copy.yearToDate}
        </h2>
        <Line label={copy.grossPay} value={appNaira(ytd.grossKobo)} />
        <Line label={copy.incomeTax} value={appNaira(ytd.payeKobo)} />
        <Line label={copy.yourPension} value={appNaira(ytd.pensionEmployeeKobo)} />
        {ytd.nhfKobo > 0n ? <Line label={copy.nhf} value={appNaira(ytd.nhfKobo)} /> : null}
        <Line label={copy.netPay} value={appNaira(ytd.netKobo)} strong />
      </section>

      {rent ? (
        <p className="m-0 text-[13px] text-fg-muted" data-testid="payslip-rent">
          {rent}
        </p>
      ) : null}
      {view.ruleSetName ? (
        <p className="m-0 text-[13px] text-fg-muted">{copy.ruleSet(view.ruleSetName)}</p>
      ) : null}
    </div>
  );
}

function TopBar({ children }: { children?: React.ReactNode }) {
  return (
    <div className="px-4 pt-3 pb-1">
      <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }} inbox>
        <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
        <span className="flex-1" />
        {children}
      </WorkerTopBar>
    </div>
  );
}

async function Payslips({
  searchParams,
}: {
  searchParams: PageProps<"/m/payslips">["searchParams"];
}) {
  const [session, query] = await Promise.all([requireWorkerPageSession(), searchParams]);
  const payslips = await loadMyPayslips(await createServerSupabase(), session.organisationId);
  if (payslips.length === 0) {
    return (
      <>
        <TopBar />
        <div className="px-4 pt-2 pb-4">
          <section
            data-testid="payslips-empty"
            className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3"
          >
            <p className="m-0 min-w-0 flex-1 text-[15px] text-fg-muted">{copy.empty}</p>
            <Illustration name="payslip-empty" size="worker" decorative />
          </section>
        </div>
      </>
    );
  }
  const wanted = typeof query.p === "string" ? query.p : undefined;
  const view = payslips.find((p) => p.payslipId === wanted) ?? payslips[0]!;
  return (
    <>
      <TopBar>
        {payslips.length > 1 ? (
          <MonthSwitcher
            current={view.payslipId}
            options={payslips.map((p) => ({
              id: p.payslipId,
              // An off-cycle payslip (slice 5.7b) shares its month with the regular one: the pay
              // date tells them apart.
              month:
                payslips.filter((q) => q.month === p.month).length > 1
                  ? `${p.month}, ${formatDate(p.payDate)}`
                  : p.month,
            }))}
          />
        ) : null}
      </TopBar>
      <div className="flex-1 px-4 pt-2 pb-4">
        <Payslip view={view} />
      </div>
      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] border-t border-line bg-background px-4 pt-3 pb-4">
        <div className="grid grid-cols-2 gap-2.5">
          <DownloadPdfButton payslipId={view.payslipId} ready={view.hasDocument} />
          <AskHrButton payslipId={view.payslipId} month={view.month} />
        </div>
      </div>
    </>
  );
}

/**
 * The worker's payslips (slice 5.5), per the WkPayslip board: You received with the bank (masked)
 * and pay date, What you earned, Taken out, Your employer also paid, This year so far, the rent
 * line, Download PDF and Ask HR, with a month switcher. Released payslips only (my_payslips).
 */
export default function PayslipsPage({ searchParams }: PageProps<"/m/payslips">) {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={<span aria-hidden className="m-4 block h-64 rounded-xl bg-surface" />}>
        <Payslips searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
