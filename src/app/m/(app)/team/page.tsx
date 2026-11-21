import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Status } from "@/components/status";
import { APP_HOME_PATH, WORKER_HOME_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDayCount } from "@/lib/leave/days";
import { formatLeaveRange } from "@/lib/leave/requests";
import { workerMessages } from "@/lib/messages/worker";
import { formatShortDay, timeIn } from "@/lib/roster";
import { exceptionLabels } from "@/lib/timesheets/approval";
import { formatMinutes } from "@/lib/timesheets/minutes";
import { lookupCrewPageSession } from "@/server/workforce/crew-page-session";
import {
  crewApprovalCount,
  loadCrewQueue,
  type CrewDay,
  type CrewLeave,
  type CrewQueue,
} from "@/server/workforce/crew-team";

import { WorkerTopBar } from "../../_components/worker-top-bar";
import { CrewDayActions, CrewLeaveActions } from "./team-forms";

export const metadata: Metadata = { title: "My team" };

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function SectionTitle({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <h2 className="m-0 flex items-baseline justify-between gap-2 pt-2 font-display text-lg font-bold">
      {children}
      <span className="text-[15px] font-semibold tabular-nums text-fg-muted">{count}</span>
    </h2>
  );
}

function Empty({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <p
      className="m-0 rounded-xl border border-dashed border-line px-4 py-3 text-[15px] text-fg-muted"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

function DayCard({ day, timeZone }: { day: CrewDay; timeZone: string }) {
  const labels = exceptionLabels(day.exceptions.filter((e) => e !== "supervisor"));
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-line px-4 py-3"
      data-testid="crew-day"
      data-line={day.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 text-[15px] font-semibold break-words">{day.workerName}</span>
        {day.status === "disputed" ? (
          <Status tone="partial">Disputed</Status>
        ) : day.needsReview || labels.length > 0 ? (
          <Status tone="action">Check</Status>
        ) : (
          <Status tone="pending">To approve</Status>
        )}
      </div>
      <span className="font-display text-xl font-bold tabular-nums">
        {formatMinutes(day.workedMinutes)}
        {day.otMinutes > 0 ? ` + ${formatMinutes(day.otMinutes)} overtime` : ""}
      </span>
      <span className="text-sm text-fg-muted tabular-nums">
        {formatShortDay(day.workDate)}
        {day.startsAt && day.endsAt
          ? ` · Shift ${timeIn(day.startsAt, timeZone)}–${timeIn(day.endsAt, timeZone)}`
          : " · No shift"}
        {day.postName || day.siteName
          ? ` · ${[day.postName, day.siteName].filter(Boolean).join(" at ")}`
          : ""}
      </span>
      {labels.length > 0 ? <span className="text-sm">{labels.join(" · ")}</span> : null}
      {day.needsReview ? (
        <span className="text-sm text-fg-muted">Sent late or phone time not checked.</span>
      ) : null}
      {day.disputeReason ? (
        <p className="m-0 rounded-lg bg-surface px-3 py-2 text-sm break-words">
          The worker said: {day.disputeReason}
        </p>
      ) : null}
      <CrewDayActions lineId={day.id} running={day.running} />
    </li>
  );
}

function LeaveCard({ request, timeZone }: { request: CrewLeave; timeZone: string }) {
  const after = request.balance - request.otherPending - request.days;
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-line px-4 py-3"
      data-testid="crew-leave"
      data-request={request.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 text-[15px] font-semibold break-words">{request.workerName}</span>
        <Status tone="pending">Step 1 · you</Status>
      </div>
      <span className="font-display text-xl font-bold">
        {formatDayCount(request.days, request.counting)}
      </span>
      <span className="text-sm text-fg-muted">
        {request.leaveTypeName} · {formatLeaveRange(request.startDate, request.endDate)}
      </span>
      <span className="text-sm tabular-nums" data-testid="crew-leave-balance">
        {plural(request.balance, "day")} left · {plural(Math.max(after, 0), "day")} after this
        {request.otherPending > 0 ? ` and ${plural(request.otherPending, "day")} pending` : ""}
      </span>
      {request.openShifts.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg bg-surface px-3 py-2 text-sm">
          <span className="font-semibold" data-testid="crew-leave-shifts">
            Opens {plural(request.openShifts.length, "shift")} once HR approves
          </span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 tabular-nums">
            {request.openShifts.slice(0, 5).map((s) => (
              <li key={`${s.startsAt}-${s.postName}`} className="break-words">
                {formatShortDay(s.date)} · {timeIn(s.startsAt, timeZone)}–{timeIn(s.endsAt, timeZone)}{" "}
                · {s.postName} at {s.siteName}
              </li>
            ))}
            {request.openShifts.length > 5 ? (
              <li>and {plural(request.openShifts.length - 5, "more shift")}</li>
            ) : null}
          </ul>
        </div>
      ) : (
        <span className="text-sm text-fg-muted">No rostered shifts in these dates.</span>
      )}
      {request.reason ? (
        <p className="m-0 text-sm break-words">Reason: {request.reason}</p>
      ) : null}
      <CrewLeaveActions requestId={request.id} needsCertificate={request.needsCertificate} />
    </li>
  );
}

function Sections({ queue }: { queue: CrewQueue }) {
  const count = crewApprovalCount(queue);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span
          className="font-display text-[25px] leading-tight font-bold tabular-nums"
          data-testid="team-count"
        >
          {count === 0 ? "Nothing to approve" : `${count} to approve`}
        </span>
        <span className="text-[15px] text-fg-muted">
          {plural(queue.days.length, "day")} · {plural(queue.leave.length, "leave request")}
        </span>
      </div>

      {queue.shiftsEnabled ? (
        <section className="flex flex-col gap-3" aria-label="Timesheet days" data-testid="team-days">
          <SectionTitle count={queue.days.length}>Timesheet days</SectionTitle>
          {!queue.refreshed ? (
            <p className="m-0 text-sm text-fg-muted">
              Showing the days as last saved. Reload in a minute for the latest.
            </p>
          ) : null}
          {queue.days.length === 0 ? (
            <Empty testId="team-days-empty">No days waiting for you in the last 35 days.</Empty>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {queue.days.map((day) => (
                <DayCard key={day.id} day={day} timeZone={queue.timeZone} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Leave requests" data-testid="team-leave">
        <SectionTitle count={queue.leave.length}>Leave requests</SectionTitle>
        {queue.leave.length === 0 ? (
          <Empty testId="team-leave-empty">No leave waiting for you.</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {queue.leave.map((request) => (
              <LeaveCard key={request.id} request={request} timeZone={queue.timeZone} />
            ))}
          </ul>
        )}
        <p className="m-0 text-[13px] text-fg-muted">
          You decide step 1. HR decides next, and the worker is told at each step.
        </p>
      </section>

    </div>
  );
}

async function Team() {
  const lookup = await lookupCrewPageSession();
  if (lookup.type === "signed_out") redirect(WORKER_SIGN_IN_PATH);
  if (lookup.type !== "crew") {
    return (
      <p className="m-0 text-base" data-testid="team-blocked">
        You don&apos;t have a team. My team is for supervisors and line managers. Ask HR if this is
        wrong.
      </p>
    );
  }
  let queue: CrewQueue;
  try {
    queue = await loadCrewQueue(lookup.session);
  } catch (error) {
    console.error("crew_team.load_failed:", error instanceof Error ? error.name : "unknown");
    return (
      <p className="m-0 text-base" data-testid="team-blocked">
        My team couldn&apos;t load. Try again in a minute.
      </p>
    );
  }
  return <Sections queue={queue} />;
}

async function Back() {
  const lookup = await lookupCrewPageSession();
  const back =
    lookup.type === "crew" && lookup.session.kind === "line_manager"
      ? { href: APP_HOME_PATH, label: "Metalira Ops" }
      : { href: WORKER_HOME_PATH, label: workerMessages.back.home };
  return (
    <WorkerTopBar back={back}>
      <h1 className="m-0 font-display text-xl font-bold">My team</h1>
    </WorkerTopBar>
  );
}

/**
 * My team in the worker app (slice 4.7b, the SupHome Approvals tile): a worker-supervisor's or
 * line manager's timesheet days to approve and leave at step 1. The database decides whose rows each sees and may decide.
 */
export default function TeamPage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <Suspense fallback={<span aria-hidden className="block h-11" />}>
          <Back />
        </Suspense>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Suspense fallback={<span aria-hidden className="block h-64 w-full rounded bg-surface" />}>
          <Team />
        </Suspense>
      </div>
    </main>
  );
}
