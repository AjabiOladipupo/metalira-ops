import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { addDays, formatDate } from "@/lib/dates";
import { formatLeaveRange } from "@/lib/leave/requests";
import { formatNaira } from "@/lib/money";
import { RUN_STATUS, runMonth } from "@/lib/payroll/run-format";
import { listRuns } from "@/server/payroll/run-data";
import { canPreparePayroll } from "@/server/payroll/runs";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../_shell/slots";
import { CreateRunForm } from "./_components/run-forms";

export const metadata: Metadata = { title: "Payroll run" };

async function PayrollRunsPage() {
  const ctx = await peoplePageContext();
  const runs = await listRuns(ctx.supabase, ctx.organisationId);
  const canPrepare = canPreparePayroll(ctx.role);

  // The period holding today and the five before it, without a run yet.
  const periods: { value: string; label: string; payDate: string }[] = [];
  if (canPrepare) {
    let date = ctx.today;
    for (let i = 0; i < 6; i += 1) {
      const { data } = await ctx.supabase.rpc("payroll_period", {
        p_organisation_id: ctx.organisationId,
        p_date: date,
      });
      const p = data?.[0];
      if (!p) break;
      if (!runs.some((r) => r.kind === "regular" && r.periodStart === p.period_start)) {
        periods.push({
          value: p.period_start,
          label: `${runMonth(p.period_end)}: ${formatLeaveRange(p.period_start, p.period_end)}, paid ${formatDate(p.pay_date)}`,
          payDate: p.pay_date,
        });
      }
      date = addDays(p.period_start, -1);
    }
  }

  return (
    <>
      <PageHeader
        back={{ href: "/app", label: "dashboard" }}
        eyebrow="Payroll"
        title="Payroll run"
        description={`${runs.length} ${runs.length === 1 ? "run" : "runs"} · pay cycle 20th to 19th, paid on the 25th. HR prepares; a different person in Finance approves.`}
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
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Link href={`/app/payroll/${r.id}`} className="font-semibold text-signal">
                      {runMonth(r.periodEnd)}
                    </Link>
                    <span className="block text-xs text-fg-muted">
                      {formatLeaveRange(r.periodStart, r.periodEnd)}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDate(r.payDate)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.totals.workerCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatNaira(r.totals.netKobo, { whole: true })}
                  </td>
                  <td className="px-4 py-3">
                    <Status tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Status>
                  </td>
                </tr>
              ))}
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
