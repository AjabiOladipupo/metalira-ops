import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { KpiTile } from "@/components/kpi-tile";
import { PageHeader } from "@/components/page-header";
import { RowCheckbox, RowSelection, SelectAllCheckbox } from "@/components/row-selection";
import { Status, type StatusTone } from "@/components/status";
import { addDays } from "@/lib/dates";
import { formatLeaveRange, STATUS_LABELS } from "@/lib/leave/requests";
import { cn } from "@/lib/utils";
import {
  loadLeaveBoard,
  type LeaveRequestRow,
  type StepDecision,
} from "@/server/people/leave-data";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../_shell/slots";
import { LeaveBulkBar } from "./_components/leave-bulk";

export const metadata: Metadata = { title: "Leave" };

type Tab = "requests" | "calendar" | "policies";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A step's cell: the decision, or where it stands. */
function stepCell(
  row: LeaveRequestRow,
  which: "line_manager" | "hr",
): { tone: StatusTone; label: string } {
  const decision: StepDecision | null = which === "line_manager" ? row.lineManagerStep : row.hrStep;
  if (decision) {
    const who = decision.by ? ` · ${decision.by}` : "";
    return {
      tone: decision.decision === "approved" ? "done" : "pending",
      label: `${decision.decision === "approved" ? "Approved" : "Declined"}${who}`,
    };
  }
  if (row.status === "cancelled") return { tone: "pending", label: "Cancelled" };
  if (which === "line_manager") {
    if (row.status !== "pending_line_manager") return { tone: "pending", label: "—" };
    if (row.canDecideStep1) return { tone: "action", label: "Yours to decide" };
    return {
      tone: "pending",
      label: row.hasLineManager
        ? `Waiting · ${row.lineManagerName ?? "line manager"}`
        : "Waiting · ops",
    };
  }
  if (row.status === "pending_hr") {
    return row.canDecideStep2
      ? { tone: "action", label: "Yours to decide" }
      : { tone: "pending", label: "Waiting" };
  }
  if (row.status === "pending_line_manager")
    return { tone: "pending", label: "After line manager" };
  return { tone: "pending", label: "—" };
}

function TabLink({ tab, current, label }: { tab: Tab; current: Tab; label: string }) {
  const selected = tab === current;
  return (
    <Link
      href={tab === "requests" ? "/app/leave" : `/app/leave?tab=${tab}`}
      role="tab"
      aria-selected={selected}
      className={cn(
        "flex min-h-11 items-center border-b-2 px-3 text-sm font-medium no-underline",
        selected
          ? "border-signal text-foreground hover:text-foreground"
          : "border-transparent text-fg-muted hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}

function RequestsTable({ rows, canDecide }: { rows: LeaveRequestRow[]; canDecide: boolean }) {
  const columns: Column<LeaveRequestRow>[] = [
    // Slice U.2: tick requests to approve them together or export them.
    {
      key: "select",
      header: <SelectAllCheckbox label="Select all requests" />,
      className: "w-10",
      cell: (r) => (
        <RowCheckbox
          rowId={r.id}
          label={`Select ${r.workerName}'s ${r.leaveTypeName.toLowerCase()} leave`}
        />
      ),
    },
    {
      key: "worker",
      header: "Employee",
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{r.workerName}</span>
          <span className="text-xs text-fg-muted">{r.departmentName ?? r.staffId}</span>
        </span>
      ),
    },
    { key: "type", header: "Type", cell: (r) => r.leaveTypeName },
    {
      key: "dates",
      header: "Dates",
      cell: (r) => (
        <span className="whitespace-nowrap">{formatLeaveRange(r.startDate, r.endDate)}</span>
      ),
    },
    { key: "days", header: "Days", kind: "number", cell: (r) => r.days },
    {
      key: "lm",
      header: "Line manager",
      cell: (r) => {
        const s = stepCell(r, "line_manager");
        return <Status tone={s.tone}>{s.label}</Status>;
      },
    },
    {
      key: "hr",
      header: "HR",
      cell: (r) => {
        const s = stepCell(r, "hr");
        return <Status tone={s.tone}>{s.label}</Status>;
      },
    },
    {
      key: "open",
      header: "",
      cell: (r) => (
        <Link
          href={`/app/leave/${r.id}`}
          aria-label={`Open ${r.workerName}'s ${r.leaveTypeName.toLowerCase()} leave`}
          className="font-medium whitespace-nowrap text-signal no-underline hover:underline"
        >
          {r.canDecideStep1 || r.canDecideStep2 ? "Decide" : "Open"}
        </Link>
      ),
    },
  ];
  return (
    <RowSelection
      rowIds={rows.map((r) => r.id)}
      matchingCount={rows.length}
      noun={{ one: "request", many: "requests" }}
    >
      <LeaveBulkBar canDecide={canDecide} />
      <DataTable caption="Leave requests" columns={columns} rows={rows} getRowId={(r) => r.id} />
    </RowSelection>
  );
}

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

function CalendarGrid({ rows, today }: { rows: LeaveRequestRow[]; today: string }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const byWorker = new Map<string, LeaveRequestRow[]>();
  for (const r of rows) byWorker.set(r.workerId, [...(byWorker.get(r.workerId) ?? []), r]);
  if (byWorker.size === 0) {
    return (
      <p className="m-0 rounded-xl border border-line p-5 text-sm text-fg-muted">
        No one is on leave or waiting for leave in the next 14 days.
      </p>
    );
  }
  return (
    <div
      role="region"
      aria-label="Leave calendar"
      tabIndex={0}
      className="overflow-x-auto rounded-xl border border-line"
    >
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 bg-background px-3 py-2 text-left font-semibold"
            >
              Employee
            </th>
            {days.map((d) => {
              const weekday = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
              return (
                <th
                  key={d}
                  scope="col"
                  className="px-1 py-2 text-center text-xs font-medium text-fg-muted"
                >
                  <span className="block">{DAY_LETTERS[weekday]}</span>
                  <span className="block text-foreground tabular-nums">{Number(d.slice(8))}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {[...byWorker.values()].map((list) => (
            <tr key={list[0]!.workerId} className="border-t border-line">
              <th
                scope="row"
                className="sticky left-0 bg-background px-3 py-2 text-left font-normal"
              >
                <span className="flex flex-col">
                  <span className="font-semibold">{list[0]!.workerName}</span>
                  <span className="text-xs text-fg-muted">
                    {[...new Set(list.map((r) => r.leaveTypeName))].join(", ")}
                  </span>
                </span>
              </th>
              {days.map((d) => {
                const hit = list.find((r) => r.startDate <= d && r.endDate >= d);
                return (
                  <td key={d} className="px-0.5 py-2">
                    {hit ? (
                      <span
                        title={`${hit.leaveTypeName} · ${STATUS_LABELS[hit.status]}`}
                        className={cn(
                          "block h-3 rounded-[4px] border-[1.5px] border-foreground",
                          hit.status === "approved" ? "bg-foreground" : "bg-transparent",
                        )}
                      />
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function LeaveBoardPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/leave">["searchParams"];
}) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const raw = first(query.tab);
  const tab: Tab = raw === "calendar" || raw === "policies" ? raw : "requests";
  const board = await loadLeaveBoard(ctx.supabase, ctx.organisationId, ctx.today);
  const showBalances = ["owner", "admin", "hr", "line_manager"].includes(ctx.role);
  const waiting = board.waitingForLineManager + board.waitingForHr;

  return (
    <>
      <PageHeader
        title="Leave"
        description={
          board.yours > 0
            ? `${board.yours} ${board.yours === 1 ? "request needs" : "requests need"} your decision · ${waiting} waiting in all`
            : `${waiting} ${waiting === 1 ? "request" : "requests"} waiting · line manager first, then HR`
        }
        actions={
          showBalances ? (
            <Link
              href="/app/leave/balances"
              className="inline-flex h-11 items-center rounded-lg border border-line px-4 text-sm font-medium text-foreground no-underline hover:bg-surface hover:text-foreground"
            >
              Balances
            </Link>
          ) : undefined
        }
      />
      <section aria-label="Leave today" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="On leave today" value={String(board.onLeaveToday)} />
        <KpiTile label="Waiting for line manager" value={String(board.waitingForLineManager)} />
        <KpiTile label="Waiting for HR" value={String(board.waitingForHr)} />
        <KpiTile label="Starting in 14 days" value={String(board.startingIn14Days)} />
      </section>

      <div
        role="tablist"
        aria-label="Leave"
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        <TabLink tab="requests" current={tab} label="Requests" />
        <TabLink tab="calendar" current={tab} label="Calendar" />
        <TabLink tab="policies" current={tab} label="Policies" />
      </div>

      {tab === "requests" ? (
        board.requests.length === 0 ? (
          <EmptyState
            illustration={<Illustration name="leave-empty" decorative />}
            message="No leave requests yet. Workers ask from Leave in the worker app."
          />
        ) : (
          <div className="flex flex-col gap-3">
            <RequestsTable rows={board.requests} canDecide={board.yours > 0} />
            <p className="m-0 text-[13px] text-fg-muted">
              Requests go to the line manager first, then HR. The balance drops when HR approves.
              {ctx.role === "ops_manager" ? " You see dates and type only, for the roster." : ""}
            </p>
          </div>
        )
      ) : null}

      {tab === "calendar" ? (
        <div className="flex flex-col gap-3">
          <CalendarGrid rows={board.calendar} today={board.today} />
          <p className="m-0 text-[13px] text-fg-muted">
            The next 14 days. Solid bars are approved leave; outlined bars are waiting for a
            decision.
          </p>
        </div>
      ) : null}

      {tab === "policies" ? (
        <p className="m-0 rounded-xl border border-line p-5 text-sm">
          Leave types, days a year and carry-over are set in{" "}
          {canEditLeaveSetup(ctx.role) ? (
            <Link href="/app/settings/leave" className="text-signal">
              Settings &gt; Leave
            </Link>
          ) : (
            "Settings > Leave by an owner, admin or HR"
          )}
          . Every type goes to the line manager, then HR.
        </p>
      ) : null}
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/leave">) {
  return (
    <RouteGate href="/app/leave">
      <LeaveBoardPage searchParams={searchParams} />
    </RouteGate>
  );
}
