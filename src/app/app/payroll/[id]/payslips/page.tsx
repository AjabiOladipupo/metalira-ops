import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatLeaveRange } from "@/lib/leave/requests";
import { formatNaira, type Kobo } from "@/lib/money";
import { RUN_STATUS, runMonth } from "@/lib/payroll/run-format";
import type { ManagerRole } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { loadRunPayslipDocuments, PAYSLIP_PUBLISHERS } from "@/server/payroll/payslip-reads";
import { loadRunDetail } from "@/server/payroll/run-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../../_shell/slots";
import { PayslipPdfButton, PublishPayslipsForm } from "../../_components/payslip-forms";

export const metadata: Metadata = { title: "Payslips" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const naira = (k: Kobo) => formatNaira(k, { whole: true });
const TH = "px-3 py-2.5 text-left font-semibold whitespace-nowrap";
const THN = "px-3 py-2.5 text-right font-semibold whitespace-nowrap";
const TD = "px-3 py-3 whitespace-nowrap";
const TDN = "px-3 py-3 text-right tabular-nums whitespace-nowrap";

async function PayslipsPage({
  params,
}: {
  params: PageProps<"/app/payroll/[id]/payslips">["params"];
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await peoplePageContext();
  const d = await loadRunDetail(ctx.supabase, ctx.organisationId, id);
  if (!d) notFound();
  const released = d.run.status === "released";
  const docs = await loadRunPayslipDocuments(
    ctx.supabase,
    ctx.organisationId,
    d.run.id,
    d.payslips.map((p) => p.id),
    // Inboxes are read by owner, admin and hr; finance sees no notices.
    { canSeeNotices: ctx.role === "owner" || ctx.role === "hr" },
  );
  const made = [...docs.values()].filter((x) => x.documentId).length;
  const notified = [...docs.values()].filter((x) => x.notified).length;
  const canSeeNotices = ctx.role === "owner" || ctx.role === "hr";
  const canPublish = (PAYSLIP_PUBLISHERS as readonly ManagerRole[]).includes(ctx.role);
  const status = RUN_STATUS[d.run.status];
  const payslips = [...d.payslips].sort((a, b) => a.workerName.localeCompare(b.workerName));

  return (
    <>
      <PageHeader
        back={{
          href: `/app/payroll/${d.run.id}`,
          label: `Run ${runMonth(d.run.periodEnd)} payroll`,
        }}
        eyebrow={`${formatLeaveRange(d.run.periodStart, d.run.periodEnd)} · pay date ${formatDate(d.run.payDate)}`}
        title={`${runMonth(d.run.periodEnd)} payslips`}
        description={
          released
            ? `${made} of ${payslips.length} PDFs made${canSeeNotices ? ` · ${notified} workers told` : ""}. Workers see their payslip in the app; emails carry no amounts.`
            : "Workers see their payslips and PDFs are made once the run is released."
        }
        actions={<Status tone={status.tone}>{status.label}</Status>}
      />
      {released &&
      canPublish &&
      (made < payslips.length || (canSeeNotices && notified < payslips.length)) ? (
        <PublishPayslipsForm runId={d.run.id} />
      ) : null}
      <div className="relative overflow-x-auto rounded-xl border border-line">
        <table className="w-full border-collapse text-sm" aria-label="Payslips">
          <thead className="bg-surface">
            <tr>
              <th className={TH}>Worker</th>
              <th className={THN}>Gross</th>
              <th className={THN}>Net pay</th>
              <th className={TH}>PDF</th>
              {canSeeNotices ? <th className={TH}>Notice</th> : null}
              <th className={TH}>
                <span className="sr-only">Download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {payslips.map((p) => {
              const doc = docs.get(p.id);
              return (
                <tr key={p.id} className="border-t border-line" data-testid="payslip-row">
                  <td className={TD}>
                    <span className="flex flex-col">
                      <span className="font-semibold">{p.workerName}</span>
                      <span className="text-xs text-fg-muted">
                        {[p.staffId, p.jobTitle].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </td>
                  <td className={TDN}>{naira(p.grossKobo)}</td>
                  <td className={cn(TDN, "font-semibold")}>{naira(p.netKobo)}</td>
                  <td className={TD}>
                    {doc?.madeAt ? (
                      <Status tone="done">Made {formatDateTime(doc.madeAt)}</Status>
                    ) : (
                      <Status tone="pending">{released ? "Not made yet" : "At release"}</Status>
                    )}
                  </td>
                  {canSeeNotices ? (
                    <td className={TD}>
                      {doc?.notified ? (
                        <Status tone="done">Told</Status>
                      ) : (
                        <Status tone="pending">Not yet</Status>
                      )}
                    </td>
                  ) : null}
                  <td className={cn(TD, "text-right")}>
                    {doc?.documentId ? (
                      <PayslipPdfButton payslipId={p.id} workerName={p.workerName} />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-[13px] text-fg-muted">
        Each PDF opens through a link that lasts 60 seconds, and every download is recorded. Bank
        accounts and RSA PINs show the last 4 digits only.
      </p>
    </>
  );
}

/** A run's payslips with their PDFs (slice 5.5): owner, hr and finance. */
export default function Page({ params }: PageProps<"/app/payroll/[id]/payslips">) {
  return (
    <RouteGate href="/app/payroll/[id]/payslips">
      <PayslipsPage params={params} />
    </RouteGate>
  );
}
