import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { addDays } from "@/lib/dates";
import { formatDayCount } from "@/lib/leave/days";
import { formatLeaveRange, STATUS_LABELS } from "@/lib/leave/requests";
import { formatOpenedShifts } from "@/lib/leave/roster";
import {
  formatLeaveBalance,
  formatTeamShift,
  formatWeekHours,
  teamHeadline,
  type MyTeamSummary,
} from "@/lib/my-team";
import { DEFAULT_REPLY_DAYS, replyByRange } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { peoplePageContext } from "@/server/people/page-context";
import { balanceKey, loadTeamBoard, type TeamBoard, type TeamRow } from "@/server/people/team-board";

import { RouteGate } from "../_shell/slots";
import { DecideLeaveForm } from "../leave/_components/leave-decision-forms";
import { QueryCard, RaiseQueryForm } from "../people/_components/hr-file";
import { AssignPanel } from "./_components/assign-panel";

export const metadata: Metadata = { title: "My team" };

type Tab = "people" | "leave" | "queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SMALL_BUTTON =
  "inline-flex h-9 items-center rounded-lg border border-line bg-background px-3 text-[13px] font-medium whitespace-nowrap text-foreground no-underline hover:bg-surface hover:text-foreground";

function TabLink({ tab, current, label }: { tab: Tab; current: Tab; label: string }) {
  const selected = tab === current;
  return (
    <Link
      href={tab === "people" ? "/app/team" : `/app/team?tab=${tab}`}
      role="tab"
      aria-selected={selected}
      className={cn(
        "flex min-h-11 items-center border-b-2 px-3 text-sm font-semibold whitespace-nowrap no-underline",
        selected
          ? "border-foreground text-foreground hover:text-foreground"
          : "border-transparent text-fg-muted hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}

/** "1 on site · 2 late · 3 timesheet days to decide", numbers first; the quiet case says so. */
function summaryLine(summary: MyTeamSummary): string {
  const parts: string[] = [];
  if (summary.onSite > 0) parts.push(`${summary.onSite} on site`);
  if (summary.late > 0) parts.push(`${summary.late} late`);
  if (summary.noShow > 0) parts.push(`${summary.noShow} no-show`);
  if (summary.timesheetDaysOpen > 0) {
    parts.push(
      `${summary.timesheetDaysOpen} timesheet ${summary.timesheetDaysOpen === 1 ? "day" : "days"} to decide`,
    );
  }
  if (summary.openShifts > 0) {
    parts.push(
      `${summary.openShifts} open ${summary.openShifts === 1 ? "shift" : "shifts"} at your sites`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing needs you right now";
}

function ReporteesTable({ board }: { board: TeamBoard }) {
  const columns: Column<TeamRow>[] = [
    {
      key: "employee",
      header: "Employee",
      cell: (r) => (
        <Link
          href={`/app/people/${r.member.id}`}
          className="flex flex-col text-foreground no-underline hover:underline"
        >
          <span className="font-semibold">
            {r.member.firstName} {r.member.lastName}
          </span>
          <span className="text-xs text-fg-muted">{r.member.jobTitle ?? r.member.staffId}</span>
        </Link>
      ),
    },
    {
      key: "today",
      header: "Today",
      cell: (r) => (
        <span data-testid="team-today">
          <Status tone={r.today.tone}>{r.today.label}</Status>
        </span>
      ),
    },
    {
      key: "hours",
      header: "Hours this week",
      kind: "number",
      cell: (r) => formatWeekHours(r.minutesThisWeek),
    },
    {
      key: "leave",
      header: "Annual leave left",
      kind: "number",
      cell: (r) =>
        r.annualLeft === null ? (
          <span className="text-fg-muted">—</span>
        ) : (
          `${r.annualLeft} ${r.annualLeft === 1 ? "day" : "days"}`
        ),
    },
    {
      key: "next",
      header: "Next shift",
      cell: (r) =>
        r.next ? (
          <span className="whitespace-nowrap" data-testid="team-next-shift">
            {formatTeamShift(r.next, board.timeZone)}
          </span>
        ) : (
          <span className="text-fg-muted">None</span>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (r) => {
        const name = `${r.member.firstName} ${r.member.lastName}`;
        return (
          <span className="inline-flex gap-2">
            <Link
              href={`/app/team?assign=${r.member.id}`}
              aria-label={`Assign a shift to ${name}`}
              className={SMALL_BUTTON}
            >
              Assign shift
            </Link>
            <Link
              href={`/app/team?tab=queries&query=${r.member.id}`}
              aria-label={`Raise a query for ${name}`}
              className={SMALL_BUTTON}
            >
              Query
            </Link>
          </span>
        );
      },
    },
  ];
  return (
    <DataTable caption="Reportees" columns={columns} rows={board.rows} getRowId={(r) => r.member.id} />
  );
}

function LeaveTab({ board }: { board: TeamBoard }) {
  if (board.leave.length === 0) {
    return (
      <p
        data-testid="team-leave-empty"
        className="m-0 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-fg-muted"
      >
        No leave requests waiting. Your people ask from Leave in the worker app.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {board.leave.map((r) => {
        const opens = board.leaveOpens.get(r.id);
        const yours = r.status === "pending_line_manager" && r.canDecideStep1;
        const available = board.balances.get(balanceKey(r.workerId, r.leaveTypeId)) ?? null;
        return (
          <article
            key={r.id}
            data-testid="team-leave-request"
            aria-labelledby={`leave-${r.id}`}
            className="flex flex-wrap items-start gap-x-6 gap-y-4 rounded-xl border border-line px-5 py-4"
          >
            <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
              <h3 id={`leave-${r.id}`} className="m-0 text-base font-semibold">
                {r.workerName}
              </h3>
              <span className="text-sm">
                {r.leaveTypeName} · {formatLeaveRange(r.startDate, r.endDate, false)} ·{" "}
                {formatDayCount(r.days, r.counting)}
              </span>
              {r.reason ? (
                <span className="text-[13px] break-words text-fg-muted">“{r.reason}”</span>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1 text-sm">
              <span>{formatLeaveBalance(available, r.days)}</span>
              {opens ? (
                <span className="font-semibold" data-testid="team-leave-opens">
                  {formatOpenedShifts(opens)}
                </span>
              ) : yours ? (
                <span className="font-semibold" data-testid="team-leave-opens">
                  {formatOpenedShifts([])}
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-2">
              {yours ? (
                <DecideLeaveForm
                  step="line_manager"
                  requestId={r.id}
                  needsCertificate={r.needsCertificate}
                  certificateSeen={r.certificateSeen}
                />
              ) : (
                <Status tone="pending">{STATUS_LABELS[r.status]}</Status>
              )}
            </div>
          </article>
        );
      })}
      <p className="m-0 text-[13px] text-fg-muted">
        After you approve, HR decides. HR&apos;s approval takes the shifts above off the roster so
        ops can fill them. HR sees every decision in Leave.
      </p>
    </div>
  );
}

function QueriesTab({
  board,
  userId,
  queryFor,
}: {
  board: TeamBoard;
  userId: string;
  queryFor: string | undefined;
}) {
  const range = replyByRange(board.today);
  const workers = board.rows.map((r) => ({
    id: r.member.id,
    name: `${r.member.firstName} ${r.member.lastName}`,
  }));
  const names = new Map(workers.map((w) => [w.id, w.name]));
  const chosen = workers.find((w) => w.id === queryFor) ?? workers[0];
  return (
    <div className="flex flex-wrap items-start gap-5">
      <section
        aria-labelledby="team-queries"
        className="flex min-w-0 flex-[999_1_420px] flex-col gap-3"
      >
        <h2 id="team-queries" className="m-0 type-h3">
          Queries about your team
        </h2>
        {board.queries.length === 0 ? (
          <p className="m-0 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-fg-muted">
            No queries yet.
          </p>
        ) : (
          board.queries.map((q) => (
            <div key={q.id} className="flex flex-col gap-1">
              <span className="text-[13px] font-semibold">
                {names.get(q.workerId) ?? "Not on your team now"}
              </span>
              <QueryCard query={q} today={board.today} canAct isRaiser={q.raisedBy === userId} />
            </div>
          ))
        )}
      </section>
      {chosen ? (
        <RaiseQueryForm
          key={chosen.id}
          workerId={chosen.id}
          workerName={chosen.name}
          workers={workers}
          minDate={range.min}
          maxDate={range.max}
          defaultDate={addDays(board.today, DEFAULT_REPLY_DAYS)}
        />
      ) : null}
    </div>
  );
}

async function TeamPage({ searchParams }: { searchParams: PageProps<"/app/team">["searchParams"] }) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const now = new Date();
  const board = await loadTeamBoard(ctx.supabase, ctx.organisationId, now);
  const raw = first(query.tab);
  const tab: Tab = raw === "leave" || raw === "queries" ? raw : "people";
  const assignId = first(query.assign);
  const assigning =
    tab === "people" && assignId && UUID.test(assignId)
      ? board.rows.find((r) => r.member.id === assignId)
      : undefined;
  const queryFor = first(query.query);
  const leaveCount = board.leave.filter((r) => r.status === "pending_line_manager").length;

  if (board.rows.length === 0) {
    return (
      <>
        <PageHeader
          title={teamHeadline(0)}
          description="People whose line manager is you show here."
        />
        <EmptyState
          illustration={<Illustration name="import-people" decorative />}
          message="No one reports to you yet. HR sets line managers on each person's page."
        />
      </>
    );
  }

  const description = [
    board.siteNames.length > 0 ? board.siteNames.join(", ") : null,
    summaryLine(board.summary),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <PageHeader title={teamHeadline(board.rows.length)} description={description} />
      <div role="tablist" aria-label="Team" className="flex gap-1 overflow-x-auto border-b border-line">
        <TabLink tab="people" current={tab} label={`Reportees · ${board.rows.length}`} />
        <TabLink tab="leave" current={tab} label={`Leave requests · ${leaveCount}`} />
        <TabLink tab="queries" current={tab} label={`Queries · ${board.summary.openQueries}`} />
      </div>

      {tab === "people" ? (
        <div className="flex flex-col gap-4">
          {assigning ? (
            <AssignPanel
              workerId={assigning.member.id}
              workerName={`${assigning.member.firstName} ${assigning.member.lastName}`}
              choices={board.openShifts.map((s) => ({
                value: `${s.postId}|${s.shiftDate}`,
                label: `${formatTeamShift(s, board.timeZone)} · ${s.siteName} · ${s.required - s.assigned} open`,
              }))}
              upcoming={board.shifts
                .filter((s) => s.workerId === assigning.member.id)
                .map((s) => ({
                  assignmentId: s.assignmentId,
                  label: `${formatTeamShift(s, board.timeZone)} · ${s.siteName}`,
                  canRemove: s.canRemove,
                }))}
            />
          ) : null}
          <ReporteesTable board={board} />
          <p className="m-0 text-[13px] text-fg-muted">
            Today comes from clock-ins; hours this week from timesheet days, Monday to today.
            {board.summary.timesheetDaysOpen > 0 ? (
              <>
                {" "}
                <Link href="/app/timesheets" className="text-signal">
                  Decide timesheet days
                </Link>
                .
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {tab === "leave" ? <LeaveTab board={board} /> : null}
      {tab === "queries" ? (
        <QueriesTab board={board} userId={ctx.userId} queryFor={queryFor} />
      ) : null}
    </>
  );
}

/**
 * My team (slice 4.7, Team board): a line manager's reportees with today's status, hours this
 * week, annual leave left and next shift; Assign shift and Query on each; leave requests at step
 * 1 with the balance and the shifts they open; the team's queries and New query. Reads only
 * through public.my_reportees and the definer reads (never public.workers).
 */
export default function Page({ searchParams }: PageProps<"/app/team">) {
  return (
    <RouteGate href="/app/team">
      <TeamPage searchParams={searchParams} />
    </RouteGate>
  );
}
