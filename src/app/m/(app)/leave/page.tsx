import type { Metadata } from "next";
import { Suspense } from "react";

import { StatusDot } from "@/components/status";
import { formatDate, LAGOS_TIME_ZONE, todayIn } from "@/lib/dates";
import { formatDayCount } from "@/lib/leave/days";
import { formatMonths } from "@/lib/leave/entitlements";
import { formatLeaveRange, serviceMonths, STATUS_LABELS, statusTone } from "@/lib/leave/requests";
import { workerMessages } from "@/lib/messages/worker";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { loadMyLeave } from "@/server/people/leave-data";

import { WorkerTopBar } from "../../_components/worker-top-bar";
import { CancelOwnLeave, LeaveRequestForm, type FormType } from "./leave-form";

export const metadata: Metadata = { title: "Leave" };

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function Body() {
  const session = await requireWorkerPageSession();
  const supabase = await createServerSupabase();
  const { data: org } = await supabase
    .from("organisations")
    .select("timezone")
    .eq("id", session.organisationId)
    .maybeSingle();
  const today = todayIn(org?.timezone ?? LAGOS_TIME_ZONE);
  const leave = await loadMyLeave(supabase, session.organisationId, session.workerId, today);

  const balanceOf = (id: string) => leave.balances.find((b) => b.leaveTypeId === id);
  const types: FormType[] = leave.types.map((t) => {
    const b = balanceOf(t.id);
    const opens =
      t.minServiceMonths > 0 && serviceMonths(leave.startDate, today) < t.minServiceMonths
        ? formatDate(addMonths(leave.startDate, t.minServiceMonths))
        : null;
    return {
      id: t.id,
      name: t.name,
      counting: t.counting,
      needsCertificate: t.needsCertificate,
      available: t.daysPerYear > 0 ? (b?.available ?? 0) : null,
      opensOn: opens ? `on ${opens}, after ${formatMonths(t.minServiceMonths)}' service` : null,
    };
  });
  const tiles = leave.balances.filter((b) => b.limited);
  const isWaiting = (status: string) => status === "pending_line_manager" || status === "pending_hr";
  const waiting = leave.requests.filter((r) => isWaiting(r.status));
  const past = leave.requests.filter((r) => !isWaiting(r.status));

  return (
    <div className="flex flex-col gap-4">
      {tiles.length > 0 ? (
        <section aria-label="Days left" className="grid grid-cols-3 gap-2">
          {tiles.map((b) => (
            <div
              key={b.leaveTypeId}
              data-testid={`balance-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-surface p-3"
            >
              <span className="font-display text-[25px] font-bold tabular-nums">{b.available}</span>
              <span className="text-[13px] text-fg-muted">
                {b.name} left of {b.entitled}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {waiting.length > 0 ? (
        <section aria-labelledby="waiting" className="flex flex-col">
          <h2 id="waiting" className="m-0 mb-1 type-label text-fg-muted">
            Waiting for a decision
          </h2>
          {waiting.map((r) => (
            <div
              key={r.id}
              data-testid="my-leave-request"
              className="flex items-center justify-between gap-3 border-b border-line py-3 text-[15px]"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>
                  {r.leaveTypeName} · {formatLeaveRange(r.startDate, r.endDate, false)}
                </span>
                <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
                  <StatusDot tone={statusTone(r.status)} />
                  {STATUS_LABELS[r.status]} · {formatDayCount(r.days, r.counting)}
                </span>
              </span>
              <CancelOwnLeave requestId={r.id} />
            </div>
          ))}
        </section>
      ) : null}

      <LeaveRequestForm
        types={types}
        lineManagerName={leave.lineManagerName}
        calendar={{
          today,
          yearEnd: `${leave.year}-12-31`,
          workDays: [...leave.calendar.workDays],
          lastRostered: leave.calendar.lastRostered,
          holidays: [...leave.calendar.holidays],
          shifts: [...leave.calendar.shifts],
        }}
      />

      <section aria-labelledby="past" className="flex flex-col">
        <h2 id="past" className="m-0 mb-1 type-label text-fg-muted">
          Past requests
        </h2>
        {past.length === 0 ? (
          <p className="m-0 py-3 text-[15px] text-fg-muted">No past requests yet.</p>
        ) : (
          past.map((r) => (
            <div
              key={r.id}
              data-testid="my-past-leave"
              className="flex flex-col gap-0.5 border-b border-line py-3 text-[15px]"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  {r.leaveTypeName} · {formatLeaveRange(r.startDate, r.endDate, false)}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  <StatusDot tone={statusTone(r.status)} />
                  {STATUS_LABELS[r.status]}
                </span>
              </span>
              {r.status === "declined" && r.note ? (
                <span className="text-[13px] text-fg-muted">Why: {r.note}</span>
              ) : null}
              {r.status === "cancelled" && r.cancelReason ? (
                <span className="text-[13px] text-fg-muted">Why: {r.cancelReason}</span>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/** The worker's leave (slice 4.4, WkLeave board): balances, ask for leave, past requests. */
export default function LeavePage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }} inbox>
          <span className="font-display text-xl font-bold">Leave</span>
        </WorkerTopBar>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Suspense fallback={<span aria-hidden className="block h-96 w-full rounded bg-surface" />}>
          <Body />
        </Suspense>
      </div>
    </main>
  );
}
