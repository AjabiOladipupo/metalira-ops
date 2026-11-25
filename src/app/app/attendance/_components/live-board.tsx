"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { ListSelectionBar } from "@/components/list-export";
import {
  RowCheckbox,
  RowSelection,
  SelectAllCheckbox,
  selectableRowClass,
} from "@/components/row-selection";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ATTENDANCE_STATUSES,
  BOARD_POLL_MS,
  STATUS_LIST_TITLES,
  STATUS_TILE_LABELS,
  boardSites,
  callTarget,
  defaultTile,
  filterRows,
  flagLabels,
  formatSince,
  headline,
  lastPunchText,
  needsAction,
  replacementHref,
  shiftText,
  siteSummaries,
  statusCounts,
  statusText,
  statusTone,
  subline,
  type AttendanceStatus,
  type Board,
  type BoardRow,
} from "@/lib/attendance-board";
import { mondayOf, timeIn } from "@/lib/roster";
import { cn } from "@/lib/utils";
import { attendanceBoardAction } from "@/server/workforce/board-actions";

/**
 * The live board (slice 3.7, prototype Attendance.dc.html): tiles that filter the list, the list
 * (worker, site · post, shift, last punch, status, flags; Call and Send replacement on late and
 * no-show rows) and By site with each site's last sync. Asks the server again every 30 seconds
 * while the tab is visible, and at once when it becomes visible again. Times in the company's
 * zone (Africa/Lagos).
 */
export function LiveBoard({
  initial,
  organisationId,
  canReplace,
}: {
  initial: Board;
  organisationId: string;
  canReplace: boolean;
}) {
  const [board, setBoard] = useState(initial);
  const [stale, setStale] = useState(false);
  const [, startTransition] = useTransition();
  const [picked, setPicked] = useState<AttendanceStatus | null>(null);
  const [siteId, setSiteId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const busy = useRef(false);

  const refresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      try {
        const result = await attendanceBoardAction({ organisationId });
        if (result.ok) {
          setBoard(result.board);
          setStale(false);
        } else {
          setStale(true);
        }
      } catch {
        setStale(true);
      } finally {
        busy.current = false;
      }
    });
  }, [organisationId]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(tick, BOARD_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const now = Date.parse(board.at);
  const zone = board.timeZone;
  const siteRows = useMemo(
    () => (siteId === "all" ? board.rows : board.rows.filter((r) => r.siteId === siteId)),
    [board.rows, siteId],
  );
  const counts = useMemo(() => statusCounts(siteRows), [siteRows]);
  const tile = picked ?? defaultTile(counts);
  const list = useMemo(
    () => filterRows(siteRows, { status: tile, siteId: "all", search }),
    [siteRows, tile, search],
  );
  const sites = useMemo(() => boardSites(board.rows), [board.rows]);
  const bySite = useMemo(() => siteSummaries(siteRows, now), [siteRows, now]);
  const siteKnown = siteId === "all" || sites.some((s) => s.id === siteId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3" data-testid="board-toolbar">
        <span className="type-label text-fg-muted" data-testid="board-updated">
          Live · updated {timeIn(board.at, zone)}
          {stale ? " · couldn't refresh, trying again" : ""}
        </span>
        <span className="hidden flex-1 sm:block" />
        <label className="flex max-w-full min-w-0">
          <span className="sr-only">Site</span>
          <select
            value={siteKnown ? siteId : "all"}
            onChange={(e) => setSiteId(e.target.value)}
            className="h-10 max-w-full min-w-0 rounded-lg border border-line bg-background px-3 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            <option value="all">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 type-h1" data-testid="board-headline">
          {headline(siteRows, now)}
        </h1>
        <p className="m-0 type-body-lg text-fg-muted">
          {board.rows.length === 0
            ? "No one is rostered for today yet."
            : `${subline(siteRows)} · late after ${board.lateGraceMinutes} min, no-show after ${board.noShowAfterMinutes} min`}
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Attendance status"
        className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]"
      >
        {ATTENDANCE_STATUSES.map((status) => {
          const selected = status === tile;
          return (
            <button
              key={status}
              type="button"
              role="tab"
              id={`tile-${status}`}
              aria-selected={selected}
              aria-controls="board-list"
              data-testid={`tile-${status}`}
              onClick={() => setPicked(status)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1.5 rounded-xl border px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-line bg-background text-foreground hover:bg-surface",
              )}
            >
              <span className="type-label">{STATUS_TILE_LABELS[status]}</span>
              <span className="type-kpi tabular-nums">{counts[status]}</span>
            </button>
          );
        })}
      </div>

      <section
        id="board-list"
        role="tabpanel"
        aria-labelledby={`tile-${tile}`}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="m-0 type-h2" data-testid="board-list-title">
            {STATUS_LIST_TITLES[tile]} ({list.length})
          </h2>
          <label className="flex w-full max-w-xs min-w-0 flex-col gap-1 sm:w-64">
            <span className="sr-only">Find a worker or post</span>
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a worker or post"
            />
          </label>
        </div>
        {list.length === 0 ? (
          <EmptyState message={emptyMessage(tile, search, board.rows.length === 0)} />
        ) : (
          // Slice U.2: tick rows to export them. Keyed by the tile, site and search, so another
          // view starts with nothing ticked.
          <RowSelection
            key={`${tile}|${siteId}|${search}`}
            rowIds={list.map((row) => row.assignmentId)}
            matchingCount={list.length}
            noun={{ one: "shift", many: "shifts" }}
          >
            <ListSelectionBar
              params={{ list: "attendance" }}
              noun={{ one: "shift", many: "shifts" }}
            />
            <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
              <table className="w-full border-collapse text-sm" data-testid="board-table">
                <thead>
                  <tr className="text-left">
                    <Th>
                      <SelectAllCheckbox label="Select every shift shown" />
                    </Th>
                    <Th>Worker</Th>
                    <Th>Site · post</Th>
                    <Th>Shift</Th>
                    <Th>Last punch</Th>
                    <Th>Status</Th>
                    <Th>Flags</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => (
                    <tr
                      key={row.assignmentId}
                      data-testid="board-row"
                      className={selectableRowClass}
                    >
                      <Td>
                        <RowCheckbox rowId={row.assignmentId} label={`Select ${row.workerName}`} />
                      </Td>
                      <Td className="font-semibold">
                        {row.workerName}
                        {row.staffId ? (
                          <span className="block text-[13px] font-normal text-fg-muted">
                            {row.staffId}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {row.siteName} · {row.postName}
                      </Td>
                      <Td className="text-fg-muted tabular-nums">{shiftText(row, zone)}</Td>
                      <Td className="text-fg-muted tabular-nums">{lastPunchText(row, zone)}</Td>
                      <Td>
                        <Status tone={statusTone(row.status)}>{statusText(row, zone, now)}</Status>
                      </Td>
                      <Td className="text-[13px] text-fg-muted">
                        <Flags row={row} />
                      </Td>
                      <Td className="text-right">
                        <Actions row={row} canReplace={canReplace} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul
              className="m-0 flex list-none flex-col gap-3 p-0 md:hidden"
              data-testid="board-cards"
            >
              {list.map((row) => (
                <li
                  key={row.assignmentId}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border border-line p-4",
                    selectableRowClass,
                  )}
                  data-testid="board-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 font-semibold">
                      <RowCheckbox rowId={row.assignmentId} label={`Select ${row.workerName}`} />
                      {row.workerName}
                    </span>
                    <Status tone={statusTone(row.status)}>{statusText(row, zone, now)}</Status>
                  </div>
                  <span className="text-sm">
                    {row.siteName} · {row.postName}
                  </span>
                  <span className="text-[13px] text-fg-muted tabular-nums">
                    {shiftText(row, zone)} · Last punch {lastPunchText(row, zone)}
                  </span>
                  <span className="text-[13px] text-fg-muted">
                    <Flags row={row} />
                  </span>
                  <Actions row={row} canReplace={canReplace} />
                </li>
              ))}
            </ul>
          </RowSelection>
        )}
      </section>

      <section aria-labelledby="by-site" className="flex flex-col gap-3">
        <h2 id="by-site" className="m-0 type-h2">
          By site
        </h2>
        {bySite.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">No sites have shifts today.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-sm" data-testid="by-site">
              <thead>
                <tr className="text-left">
                  <Th>Site</Th>
                  <Th num>Rostered now</Th>
                  <Th num>On site</Th>
                  <Th num>Late</Th>
                  <Th num>No-show</Th>
                  <Th>Last sync</Th>
                </tr>
              </thead>
              <tbody>
                {bySite.map((site) => (
                  <tr key={site.siteId} data-testid="by-site-row">
                    <Td className="font-semibold">{site.siteName}</Td>
                    <Td num>{site.rosteredNow}</Td>
                    <Td num>{site.onSite}</Td>
                    <Td num>{site.late}</Td>
                    <Td num>{site.noShow}</Td>
                    <Td className="text-fg-muted">
                      {formatSince(site.lastSyncAt, now)}
                      {site.lateSyncs > 0 ? ` · ${site.lateSyncs} sent late today` : ""}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="m-0 text-[13px] text-fg-muted">
          Punches made offline show here once the phone reconnects; their time is checked against
          the server clock. Last sync is the latest punch the server received from that site.
        </p>
      </section>
    </div>
  );
}

function emptyMessage(tile: AttendanceStatus, search: string, nothingRostered: boolean): string {
  if (nothingRostered) return "No one is rostered for today yet. Publish a roster to see it here.";
  if (search.trim()) return "No one matches that search.";
  switch (tile) {
    case "on_site":
      return "No one is clocked in right now.";
    case "late":
      return "No one is late right now.";
    case "no_show":
      return "No no-shows today.";
    case "starting":
      return "No shifts start in the next 2 hours.";
    case "clocked_out":
      return "No one has clocked out yet today.";
  }
}

function Th({ children, num }: { children: React.ReactNode; num?: boolean }) {
  return (
    <th
      className={cn(
        "border-b border-line px-3 py-2.5 font-semibold whitespace-nowrap",
        num && "text-right tabular-nums",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  num,
}: {
  children: React.ReactNode;
  className?: string;
  num?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-b border-line px-3 py-3 align-top whitespace-nowrap",
        num && "text-right tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}

function Flags({ row }: { row: BoardRow }) {
  const labels = flagLabels(row);
  if (labels.length === 0) return <span>None</span>;
  return <span data-testid="board-flags">{labels.join(" · ")}</span>;
}

function Actions({ row, canReplace }: { row: BoardRow; canReplace: boolean }) {
  if (!needsAction(row)) return null;
  const call = callTarget(row);
  return (
    <span className="inline-flex flex-wrap gap-2">
      {call && "href" in call ? (
        <Button asChild variant="outline" size="sm" className="h-9">
          <a href={call.href} aria-label={`Call ${row.workerName}`}>
            Call
          </a>
        </Button>
      ) : call ? (
        <span className="inline-flex h-9 items-center text-[13px] text-fg-muted tabular-nums">
          {call.masked}
        </span>
      ) : null}
      {canReplace ? (
        <Button asChild variant="outline" size="sm" className="h-9 border-foreground">
          <Link
            href={replacementHref(row, mondayOf(row.shiftDate))}
            prefetch={false}
            aria-label={`Send replacement for ${row.workerName}, ${row.postName}`}
          >
            Send replacement
          </Link>
        </Button>
      ) : null}
    </span>
  );
}
