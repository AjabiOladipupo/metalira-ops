import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { addDays, formatDate } from "@/lib/dates";
import { formatLeaveRange } from "@/lib/leave/requests";
import { formatNaira } from "@/lib/money";
import { OFF_CYCLE_REASONS, REVERSAL_STATUS, RUN_STATUS, runMonth } from "@/lib/payroll/run-format";
import { listRuns } from "@/server/payroll/run-data";
import { canPreparePayroll } from "@/server/payroll/runs";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../_shell/slots";
import { CreateRunForm, OffCycleRunForm, type OffCycleWorkerOption } from "./_components/run-forms";

export const metadata: Metadata = { title: "Payroll run" };

async function PayrollRunsPage() {
  const ctx = await peoplePageContext();
  const runs = await listRuns(ctx.supabase, ctx.organisationId);
  const canPrepare = canPreparePayroll(ctx.role);

  // The period holding today and the five before it, without a regular run yet.
  const periods: { value: string; label: string; payDate: string }[] = [];
  // Off-cycle runs (slice 5.7b) may share a period with the regular run and with each other.
  const offCyclePeriods: { value: string; label: string }[] = [];
  if (canPrepare) {
    let date = ctx.today;
    // Off-cycle runs reach back a year (a correction or one-off for a former worker, money
    // review L3); the regular run's choice stays the six latest periods.
    for (let i = 0; i < 13; i += 1) {
      const { data } = await ctx.supabase.rpc("payroll_period", {
        p_organisation_id: ctx.organisationId,
        p_date: date,
      });
      const p = data?.[0];
      if (!p) break;
      offCyclePeriods.push({
        value: p.period_start,
        label: `${runMonth(p.period_end)}: ${formatLeaveRange(p.period_start, p.period_end)}`,
      });
      // A reversed run (slice 5.7a) no longer holds its period: it may be run again.
      if (
        i < 6 &&
        !runs.some(
          (r) =>
            r.kind === "regular" && r.status !== "reversed" && r.periodStart === p.period_start,
        )
      ) {
        periods.push({
          value: p.period_start,
          label: `${runMonth(p.period_end)}: ${formatLeaveRange(p.period_start, p.period_end)}, paid ${formatDate(p.pay_date)}`,
          payDate: p.pay_date,
        });
      }
      date = addDays(p.period_start, -1);
    }
  }

  // Workers for the off-cycle picker: employed on some day of those periods.
  const offCycleWorkers: OffCycleWorkerOption[] = [];
  const earliest = offCyclePeriods.at(-1)?.value;
  if (canPrepare && earliest) {
    const { data, error } = await ctx.supabase
      .from("workers")
      .select("id, first_name, last_name, staff_id, start_date, end_date")
      .eq("organisation_id", ctx.organisationId)
      .or(`end_date.is.null,end_date.gte.${earliest}`)
      .order("first_name")
      .order("last_name")
      .limit(1000);
    if (error) throw new Error(`Could not read workers (${error.code})`);
    for (const w of data ?? []) {
      offCycleWorkers.push({
        id: w.id,
        name: `${w.first_name} ${w.last_name}`.trim(),
        staffId: w.staff_id,
        note: w.end_date
          ? `Last day ${formatDate(w.end_date)}`
          : w.start_date >= earliest
            ? `Started ${formatDate(w.start_date)}`
            : null,
      });
    }
  }

  return (
    <>
      <PageHeader
        back={{ href: "/app", label: "dashboard" }}
        eyebrow="Payroll"
        title="Payroll run"
        description={`${runs.length} ${runs.length === 1 ? "run" : "runs"} · pay cycle 20th to 19th, paid on the 25th. HR prepares; a different person in Finance approves.`}
        actions={
          runs.some((r) => r.status === "approved" || r.status === "released") ? (
            <Button asChild variant="outline">
              <Link href="/app/payroll/remittances">Statutory remittances</Link>
            </Button>
          ) : undefined
        }
      />

      {canPrepare && periods.length > 0 ? (
        <section
          aria-labelledby="prepare"
          className="flex flex-col gap-4 rounded-xl border border-line p-5"
        >
          <div className="flex flex-col gap-1">
            <h2 id="prepare" className="m-0 type-h3">
              Prepare a run
            </h2>
            <p className="m-0 text-sm text-fg-muted">
              The run pays approved timesheet days and approved leave, with the payroll rules in
              force on its pay date. You see the totals before anything is saved.
            </p>
          </div>
          <CreateRunForm periods={periods} />
        </section>
      ) : null}

      {canPrepare && offCyclePeriods.length > 0 && offCycleWorkers.length > 0 ? (
        <details
          data-testid="new-off-cycle"
          className="group flex flex-col gap-4 rounded-xl border border-line p-5"
        >
          <summary className="cursor-pointer list-none type-h3 marker:hidden">
            New off-cycle run
            <span className="mt-1 block text-sm font-normal text-fg-muted">
              A leaver&apos;s final pay, a worker the regular run missed, a correction or a one-off
              payment. It has its own payslips and bank file, and a different person in Finance
              approves it.
            </span>
          </summary>
          <div className="mt-4">
            <OffCycleRunForm
              periods={offCyclePeriods}
              reasons={Object.entries(OFF_CYCLE_REASONS).map(([value, r]) => ({
                value,
                label: r.label,
                hint: r.hint,
              }))}
              workers={offCycleWorkers}
              defaultPayDate={ctx.today}
            />
          </div>
        </details>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState message="No payroll runs yet. Approve timesheets to prepare the first run." />
      ) : (
        <div className="relative overflow-x-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-sm" aria-label="Payroll runs">
            <thead className="bg-surface">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold whitespace-nowrap">
                  Period
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold whitespace-nowrap">
                  Pay date
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                  Workers
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold whitespace-nowrap">
                  Net pay
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const reversal = r.kind === "reversal";
                const status = r.discardedAt
                  ? ({ label: "Discarded", tone: "partial" } as const)
                  : (reversal ? REVERSAL_STATUS : RUN_STATUS)[r.status];
                return (
                  <tr key={r.id} className="border-t border-line">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Link href={`/app/payroll/${r.id}`} className="font-semibold text-signal">
                        {reversal ? `Reversal of ${runMonth(r.periodEnd)}` : runMonth(r.periodEnd)}
                      </Link>
                      {r.kind === "off_cycle" ? (
                        <span
                          data-testid="off-cycle-label"
                          className="ml-2 rounded-md border border-line px-1.5 py-0.5 text-xs font-medium"
                        >
                          Off-cycle
                        </span>
                      ) : null}
                      <span className="block text-xs text-fg-muted">
                        {formatLeaveRange(r.periodStart, r.periodEnd)}
                        {r.offCycleReason ? ` · ${OFF_CYCLE_REASONS[r.offCycleReason].label}` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDate(r.payDate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.totals.workerCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {/* A reversal's totals count negatively (slice 5.7a's sign convention). */}
                      {formatNaira(reversal ? -r.totals.netKobo : r.totals.netKobo, {
                        whole: true,
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <Status tone={status.tone}>{status.label}</Status>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/payroll">
      <PayrollRunsPage />
    </RouteGate>
  );
}
