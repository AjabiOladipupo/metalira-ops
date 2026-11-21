import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import { formatDayCount, formatShiftCover } from "@/lib/leave/days";
import { formatLeaveRange, STATUS_LABELS, managerStatusTone } from "@/lib/leave/requests";
import { describeHrDecision } from "@/server/capabilities/leave-previews";
import {
  loadBalances,
  loadDayCount,
  loadLeaveRequest,
  previewHrDecision,
  type StepDecision,
} from "@/server/people/leave-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import { CancelLeaveForm, DecideLeaveForm } from "../_components/leave-decision-forms";

export const metadata: Metadata = { title: "Leave request" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function StepLine({ label, decision, waiting }: { label: string; decision: StepDecision | null; waiting: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line py-3 last:border-b-0">
      <span className="type-label text-fg-muted">{label}</span>
      {decision ? (
        <>
          <Status tone={decision.decision === "approved" ? "done" : "pending"}>
            {decision.decision === "approved" ? "Approved" : "Declined"}
            {decision.by ? ` by ${decision.by}` : ""}
            {decision.at ? ` · ${formatDateTime(decision.at)}` : ""}
          </Status>
          {decision.note ? <span className="text-sm">“{decision.note}”</span> : null}
        </>
      ) : (
        <span className="text-sm text-fg-muted">{waiting}</span>
      )}
    </div>
  );
}

async function RequestPage({ params }: { params: PageProps<"/app/leave/[requestId]">["params"] }) {
  const [{ requestId }, ctx] = await Promise.all([params, peoplePageContext()]);
  if (!UUID.test(requestId)) notFound();
  const request = await loadLeaveRequest(ctx.supabase, ctx.organisationId, requestId);
  if (!request) notFound();

  const live = ["pending_line_manager", "pending_hr", "approved"].includes(request.status);
  const [count, balances, preview] = await Promise.all([
    live
      ? loadDayCount(
          ctx.supabase,
          ctx.organisationId,
          request.workerId,
          request.leaveTypeId,
          request.startDate,
          request.endDate,
        )
      : Promise.resolve(null),
    ["owner", "admin", "hr", "line_manager"].includes(ctx.role)
      ? loadBalances(ctx.supabase, ctx.organisationId, request.leaveYear, [request.workerId]).catch(
          () => [],
        )
      : Promise.resolve([]),
    request.canDecideStep2
      ? previewHrDecision(ctx.supabase, ctx.organisationId, {
          requestId: request.id,
          decision: "approved",
          note: null,
          certificateSeen: true,
        })
          .then((r) => describeHrDecision(r))
          .catch((error: unknown) => ({
            summary: error instanceof Error ? error.message : "This can't be approved as it stands.",
            changes: [],
          }))
      : Promise.resolve(null),
  ]);
  const balance = balances.find((b) => b.leaveTypeId === request.leaveTypeId);
  const yours = request.canDecideStep1 || request.canDecideStep2;

  return (
    <>
      <PageHeader
        back={{ href: "/app/leave", label: "Leave" }}
        eyebrow={request.leaveTypeName}
        title={request.workerName}
        description={`${formatDayCount(request.days, request.counting)} · ${formatLeaveRange(request.startDate, request.endDate)}`}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <section aria-labelledby="details" className="flex flex-col gap-3 rounded-xl border border-line p-5">
          <h2 id="details" className="m-0 type-h3">
            Request
          </h2>
          <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-0.5">
              <dt className="type-label text-fg-muted">Status</dt>
              <dd className="m-0">
                <Status tone={managerStatusTone(request.status, yours)}>{STATUS_LABELS[request.status]}</Status>
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="type-label text-fg-muted">Staff ID</dt>
              <dd className="m-0 text-sm">{request.staffId}</dd>
            </div>
            {count ? (
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="type-label text-fg-muted">Counted now</dt>
                <dd className="m-0 text-sm" data-testid="leave-recount">
                  {formatDayCount(count.days, request.counting)}. {formatShiftCover(count)}
                  {count.days !== request.days ? ` The request says ${request.days}; approving uses the new count.` : ""}
                </dd>
              </div>
            ) : null}
            {balance ? (
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="type-label text-fg-muted">{request.leaveTypeName} balance {request.leaveYear}</dt>
                <dd className="m-0 text-sm" data-testid="leave-balance">
                  {balance.balance} left of {balance.granted + balance.carried + balance.adjusted}
                  {balance.pending > 0 ? ` · ${balance.pending} waiting for a decision` : ""}
                </dd>
              </div>
            ) : null}
            {request.reason ? (
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="type-label text-fg-muted">Reason</dt>
                <dd className="m-0 text-sm">{request.reason}</dd>
              </div>
            ) : null}
            {request.needsCertificate ? (
              <div className="flex flex-col gap-0.5">
                <dt className="type-label text-fg-muted">Certificate</dt>
                <dd className="m-0 text-sm">{request.certificateSeen ? "Seen" : "Not seen yet"}</dd>
              </div>
            ) : null}
            {request.payBelowService ? (
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="type-label text-fg-muted">Pay</dt>
                <dd className="m-0 text-sm">
                  The worker&apos;s service is below what this leave&apos;s pay needs. The leave is
                  allowed; payroll treats it as unpaid.
                </dd>
              </div>
            ) : null}
            {request.status === "cancelled" && request.cancelReason ? (
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="type-label text-fg-muted">Cancelled</dt>
                <dd className="m-0 text-sm">{request.cancelReason}</dd>
              </div>
            ) : null}
          </dl>
          <div className="flex flex-col">
            <StepLine
              label="Line manager"
              decision={request.lineManagerStep}
              waiting={
                request.status === "pending_line_manager"
                  ? request.hasLineManager
                    ? `Waiting for ${request.lineManagerName ?? "the line manager"}`
                    : "No line manager set: an owner, admin or ops manager decides"
                  : "Not decided"
              }
            />
            <StepLine
              label="HR"
              decision={request.hrStep}
              waiting={request.status === "pending_hr" ? "Waiting for HR" : "After the line manager"}
            />
          </div>
        </section>

        <div className="flex flex-col gap-4">
          {request.canDecideStep1 ? (
            <section aria-labelledby="decide1" className="flex flex-col gap-3 rounded-xl border border-foreground p-5">
              <h2 id="decide1" className="m-0 type-h3">
                Your decision
              </h2>
              <p className="m-0 text-sm text-fg-muted">
                You decide first. HR decides after you; the balance drops when HR approves.
              </p>
              <DecideLeaveForm
                step="line_manager"
                requestId={request.id}
                needsCertificate={request.needsCertificate}
                certificateSeen={request.certificateSeen}
              />
            </section>
          ) : null}
          {request.canDecideStep2 ? (
            <section aria-labelledby="decide2" className="flex flex-col gap-3 rounded-xl border border-foreground p-5">
              <h2 id="decide2" className="m-0 type-h3">
                HR decision
              </h2>
              {preview ? (
                <div data-testid="hr-preview" className="flex flex-col gap-2 rounded-lg bg-surface px-3 py-2.5 text-sm">
                  <p className="m-0 font-medium">{preview.summary}</p>
                  {preview.changes.map((c) => (
                    <p key={c.label} className="m-0 text-fg-muted">
                      {c.label}: {c.before ? `${c.before} → ` : ""}
                      {c.after}
                    </p>
                  ))}
                </div>
              ) : null}
              <DecideLeaveForm
                step="hr"
                requestId={request.id}
                needsCertificate={request.needsCertificate}
                certificateSeen={request.certificateSeen}
              />
            </section>
          ) : null}
          {request.canCancel ? (
            <section aria-labelledby="cancel" className="flex flex-col gap-3 rounded-xl border border-line p-5">
              <h2 id="cancel" className="m-0 type-h3">
                Cancel
              </h2>
              <CancelLeaveForm requestId={request.id} approved={request.status === "approved"} />
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

export default function Page({ params }: PageProps<"/app/leave/[requestId]">) {
  return (
    <RouteGate href="/app/leave/[id]">
      <RequestPage params={params} />
    </RouteGate>
  );
}
