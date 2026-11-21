import type { Metadata } from "next";
import { Suspense } from "react";

import { Status, type StatusTone } from "@/components/status";
import { formatDate } from "@/lib/dates";
import { workerMessages } from "@/lib/messages/worker";
import { formatHoursTotal, formatShortDay, timeIn } from "@/lib/roster";
import { createServerSupabase } from "@/lib/supabase/server";
import { exceptionLabels } from "@/lib/timesheets/approval";
import { formatMinutes } from "@/lib/timesheets/minutes";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { loadMyHours, type MyDay } from "@/server/workforce/timesheet-review-data";

import { WorkerTopBar } from "../../_components/worker-top-bar";
import { DisputeForm } from "./dispute-form";

export const metadata: Metadata = { title: "My hours" };

const STATUS: Record<MyDay["status"], { text: string; tone: StatusTone }> = {
  pending: { text: "Waiting for approval", tone: "pending" },
  approved: { text: "Approved", tone: "done" },
  rejected: { text: "Not approved", tone: "action" },
  disputed: { text: "With your manager", tone: "partial" },
};

function DayCard({ day, timeZone }: { day: MyDay; timeZone: string }) {
  const status = STATUS[day.status];
  const labels = exceptionLabels(day.exceptions.filter((e) => e !== "supervisor"));
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-line px-4 py-3"
      data-testid="my-day"
      data-status={day.status}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{formatShortDay(day.workDate)}</span>
        <Status tone={status.tone}>{status.text}</Status>
      </div>
      <span className="font-display text-xl font-bold tabular-nums" data-testid="my-day-minutes">
        {formatMinutes(day.workedMinutes)}
        {day.otMinutes > 0 ? ` + ${formatMinutes(day.otMinutes)} overtime` : ""}
      </span>
      <span className="text-[15px] break-words">
        {day.postName || day.siteName
          ? [day.postName, day.siteName].filter(Boolean).join(" at ")
          : "No shift"}
      </span>
      <span className="text-sm text-fg-muted tabular-nums">
        {day.startsAt && day.endsAt
          ? `Shift ${timeIn(day.startsAt, timeZone)}–${timeIn(day.endsAt, timeZone)} · `
          : ""}
        In {day.inAt ? timeIn(day.inAt, timeZone) : "none"} · Out{" "}
        {day.outAt ? timeIn(day.outAt, timeZone) : "none"}
      </span>
      {labels.length > 0 ? (
        <span className="text-sm text-fg-muted">{labels.join(" · ")}</span>
      ) : null}
      {day.lastDecisionReason && (day.status === "rejected" || day.status === "disputed") ? (
        <p className="m-0 rounded-lg bg-surface px-3 py-2 text-sm break-words">
          {day.status === "rejected" ? "Reason: " : "You said: "}
          {day.lastDecisionReason}
        </p>
      ) : null}
      {day.lastCorrectionReason ? (
        <p className="m-0 text-sm break-words text-fg-muted">
          Corrected by your manager: {day.lastCorrectionReason}
        </p>
      ) : null}
      {day.canDispute ? <DisputeForm lineId={day.id} /> : null}
    </li>
  );
}

async function Hours() {
  const session = await requireWorkerPageSession();
  if (!session.shiftsEnabled) {
    return (
      <p className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]" data-testid="hours-off">
        {workerMessages.shiftsOff}
      </p>
    );
  }
  const supabase = await createServerSupabase();
  const hours = await loadMyHours(supabase, session.organisationId);
  const total = hours.days.reduce((sum, d) => sum + d.workedMinutes + d.otMinutes, 0);
  const approved = hours.days.filter((d) => d.status === "approved").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="type-label text-fg-muted">
          {formatDate(hours.period.start)} – {formatDate(hours.period.end)}
        </span>
        <span
          className="font-display text-[25px] leading-tight font-bold tabular-nums"
          data-testid="hours-total"
        >
          {formatHoursTotal(total)} this period
        </span>
        <span className="text-[15px] text-fg-muted">
          {hours.days.length} {hours.days.length === 1 ? "day" : "days"} · {approved} approved
        </span>
      </div>
      {hours.days.length === 0 ? (
        <p
          className="m-0 rounded-xl border border-dashed border-line px-4 py-3 text-[15px] text-fg-muted"
          data-testid="hours-empty"
        >
          No days yet this period. Your days show here once your shifts start.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="my-days">
          {hours.days.map((day) => (
            <DayCard key={day.id} day={day} timeZone={hours.timeZone} />
          ))}
        </ul>
      )}
      <p className="m-0 text-[13px] text-fg-muted">
        Times come from the server, not your phone. If a day is wrong, tap &quot;This is wrong&quot;
        and say why; your manager decides.
      </p>
    </div>
  );
}

/**
 * The worker's days this pay period (slice 4.3): minutes, status and "This is wrong", which
 * sends the day back to the approver with the worker's reason.
 */
export default function HoursPage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }} inbox>
          <h1 className="m-0 font-display text-xl font-bold">My hours</h1>
        </WorkerTopBar>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Suspense fallback={<span aria-hidden className="block h-64 w-full rounded bg-surface" />}>
          <Hours />
        </Suspense>
      </div>
    </main>
  );
}
