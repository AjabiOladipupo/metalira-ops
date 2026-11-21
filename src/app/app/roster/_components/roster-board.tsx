"use client";

import { useActionState, useMemo, useState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Illustration } from "@/components/illustration";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  dayLabel,
  formatDayCounts,
  formatShiftHours,
  formatShortDay,
  type ReplacementTarget,
  type RosterCell,
  type RosterWeek,
} from "@/lib/roster";
import { matchesSearch, rankCandidates, type Suggestion } from "@/lib/roster-suggestions";
import { cn } from "@/lib/utils";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { assignShiftAction, removeAssignmentAction } from "@/server/workforce/roster-actions";
import type { OnLeaveChip, RosterCandidates, TrayCard } from "@/server/workforce/roster-data";

/**
 * The roster grid (slice 3.2), as on the Roster board: a row per post, a column per day with
 * "Required N · Scheduled M", name chips for who is assigned and dashed "Uncovered" chips for the
 * places still open, and the Uncovered tray with a suggestion for each. Below `lg` it shows one
 * day at a time with a day switcher. Clicking an Uncovered chip opens the picker (suggestions
 * first, then search); clicking a name opens "Remove from shift". The database checks every
 * assignment again. No money: cost and billable wait for Phase 4 and 7.
 *
 * Slice 4.5: a worker approved leave took off a post-day shows there as an "On leave" chip
 * (muted, never clickable) beside the Uncovered place it left; suggestions skip approved leave
 * and mark leave waiting for a decision.
 */

interface PickTarget {
  postId: string;
  postName: string;
  date: string;
  startsAt: string;
  endsAt: string;
}

interface RemoveTarget {
  assignmentId: string;
  workerName: string;
  postName: string;
  date: string;
  /** Prefilled reason (Send replacement from the live board: "No-show"). */
  reason?: string;
}

function shortName(name: string): string {
  const [firstName, ...rest] = name.split(" ");
  const last = rest.join(" ");
  return last ? `${firstName} ${last.charAt(0)}.` : name;
}

const CHIP =
  "flex min-h-10 w-full items-center rounded-[4px] px-2.5 text-left text-[13px] font-medium";

export function RosterBoard({
  siteId,
  weekStart,
  today,
  timeZone,
  weeklyStandardMinutes,
  week,
  tray,
  candidates,
  canEdit,
  changedCells = [],
  replacement = null,
  onLeave = {},
}: {
  siteId: string;
  weekStart: string;
  today: string;
  timeZone: string;
  weeklyStandardMinutes: number;
  week: RosterWeek;
  tray: TrayCard[];
  candidates: RosterCandidates;
  canEdit: boolean;
  /** `${postId}|${date}` for the post-days that changed since the latest publish (slice 3.3). */
  changedCells?: string[];
  /**
   * Send replacement from the live board (slice 3.7): opens "Remove from shift" for the late or
   * no-show worker, then the picker for the same post-day; or the picker at once when the place
   * is already open. Only when the day can still change.
   */
  replacement?: ReplacementTarget | null;
  /** `${postId}|${date}` -> workers approved leave took off that post-day (slice 4.5). */
  onLeave?: Record<string, OnLeaveChip[]>;
}) {
  const changed = useMemo(() => new Set(changedCells), [changedCells]);
  const todayIndex = week.days.findIndex((d) => d.date === today);
  const replaceable = replacement !== null && canEdit && replacement.date >= today;
  const focusIndex = replaceable ? week.days.findIndex((d) => d.date === replacement.date) : -1;
  const [dayIndex, setDayIndex] = useState(
    focusIndex >= 0 ? focusIndex : todayIndex >= 0 ? todayIndex : 0,
  );
  const replacementPick: PickTarget | null = replaceable
    ? {
        postId: replacement.postId,
        postName: replacement.postName,
        date: replacement.date,
        startsAt: replacement.startsAt,
        endsAt: replacement.endsAt,
      }
    : null;
  const [picking, setPicking] = useState<PickTarget | null>(
    replaceable && !replacement.remove ? replacementPick : null,
  );
  const [removing, setRemoving] = useState<RemoveTarget | null>(
    replaceable && replacement.remove
      ? {
          assignmentId: replacement.remove.assignmentId,
          workerName: replacement.remove.workerName,
          postName: replacement.postName,
          date: replacement.date,
          reason: "No-show",
        }
      : null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const [assignState, assignAction] = useActionState<CompanyFormState, FormData>(
    async (prev, formData) => {
      const result = await assignShiftAction(prev, formData);
      if (result?.ok) {
        setPicking(null);
        setNotice(result.message ?? "Assigned");
      }
      return result;
    },
    null,
  );
  const [removeState, removeAction] = useActionState<CompanyFormState, FormData>(
    async (prev, formData) => {
      const result = await removeAssignmentAction(prev, formData);
      if (result?.ok) {
        // Send replacement: once the late or no-show worker is off the shift, pick someone.
        const next =
          replacementPick && formData.get("assignmentId") === replacement?.remove?.assignmentId
            ? replacementPick
            : null;
        setRemoving(null);
        setNotice(result.message ?? "Removed");
        if (next) setPicking(next);
      }
      return result;
    },
    null,
  );

  const editable = (date: string) => canEdit && date >= today;
  const openPicker = (target: PickTarget) => {
    setNotice(null);
    setPicking(target);
  };
  const openRemove = (target: RemoveTarget) => {
    setNotice(null);
    setRemoving(target);
  };

  const renderCell = (cell: RosterCell, post: { postId: string; name: string }) => {
    const canChange = editable(cell.date);
    const away = onLeave[`${post.postId}|${cell.date}`] ?? [];
    if (cell.required === null && cell.assigned.length === 0 && away.length === 0) {
      return <span className="block px-1 text-[13px] text-fg-muted">Not staffed</span>;
    }
    return (
      <div className="flex flex-col gap-1.5">
        {changed.has(`${post.postId}|${cell.date}`) ? (
          <span
            className="flex items-center gap-1.5 px-1 text-[11px] leading-tight text-fg-muted"
            data-testid="changed-since-publish"
          >
            <StatusDot tone="partial" />
            Changed since publish
          </span>
        ) : null}
        {cell.assigned.map((a) => {
          const notes = [
            a.mapped ? null : "Not mapped to this site",
            a.hoursChanged ? "Hours changed" : null,
            cell.required === null ? "No longer required" : null,
          ].filter(Boolean);
          const label = `${a.workerName}, ${post.name}, ${formatShortDay(cell.date)}`;
          return (
            <div key={a.id} className="flex flex-col gap-0.5">
              {canChange ? (
                <button
                  type="button"
                  className={cn(
                    CHIP,
                    "bg-surface hover:bg-line focus-visible:outline-2 focus-visible:outline-signal",
                  )}
                  aria-label={`${label}. Remove from shift`}
                  title={a.staffId ? `${a.workerName} · ${a.staffId}` : a.workerName}
                  onClick={() =>
                    openRemove({
                      assignmentId: a.id,
                      workerName: a.workerName,
                      postName: post.name,
                      date: cell.date,
                    })
                  }
                >
                  {shortName(a.workerName)}
                </button>
              ) : (
                <span className={cn(CHIP, "bg-surface")} title={a.workerName}>
                  {shortName(a.workerName)}
                </span>
              )}
              {notes.length > 0 ? (
                <span className="px-1 text-[11px] leading-tight text-fg-muted">
                  {notes.join(" · ")}
                </span>
              ) : null}
            </div>
          );
        })}
        {away.map((w) => (
          <span
            key={`leave-${w.assignmentId}`}
            className={cn(CHIP, "justify-between gap-2 border border-line text-fg-muted")}
            title={w.staffId ? `${w.workerName} · ${w.staffId} · on approved leave` : undefined}
            data-testid="on-leave-chip"
          >
            <span className="truncate line-through decoration-1">{shortName(w.workerName)}</span>
            <span className="shrink-0 text-[11px] font-semibold text-foreground">On leave</span>
          </span>
        ))}
        {Array.from({ length: cell.open }, (_, i) =>
          canChange && cell.startsAt && cell.endsAt ? (
            <button
              key={`open-${i}`}
              type="button"
              className={cn(
                CHIP,
                "border-[1.5px] border-dashed border-foreground font-semibold hover:bg-surface focus-visible:outline-2 focus-visible:outline-signal",
              )}
              aria-label={`Uncovered: ${post.name}, ${formatShortDay(cell.date)}. Assign someone`}
              onClick={() =>
                openPicker({
                  postId: post.postId,
                  postName: post.name,
                  date: cell.date,
                  startsAt: cell.startsAt!,
                  endsAt: cell.endsAt!,
                })
              }
            >
              Uncovered
            </button>
          ) : (
            <span
              key={`open-${i}`}
              className={cn(CHIP, "border-[1.5px] border-dashed border-foreground font-semibold")}
            >
              Uncovered
            </span>
          ),
        )}
      </div>
    );
  };

  const day = week.days[dayIndex] ?? week.days[0]!;
  const openPlaces = tray.reduce((sum, t) => sum + t.open, 0);

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <p
          role="status"
          className="m-0 flex items-center gap-2 self-start rounded-lg border border-line px-3.5 py-2.5 text-sm"
        >
          <StatusDot tone="done" />
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-5">
        {/* Full grid from lg up. */}
        <div
          className="hidden min-w-0 flex-[999_1_640px] overflow-x-auto rounded-xl border border-line lg:block"
          data-testid="roster-grid"
        >
          <table className="w-full min-w-[980px] table-fixed border-collapse">
            <colgroup>
              <col className="w-[190px]" />
              {week.days.map((d) => (
                <col key={d.date} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="border-b border-line bg-surface p-3 text-left align-top type-label text-fg-muted"
                >
                  Post
                </th>
                {week.days.map((d) => {
                  const label = dayLabel(d.date);
                  return (
                    <th
                      key={d.date}
                      scope="col"
                      className="border-b border-l border-line bg-surface px-3 py-2.5 text-left align-top font-normal"
                    >
                      <span className="block text-sm font-semibold">
                        {label.short}{" "}
                        <span className="font-normal text-fg-muted">{label.date}</span>
                      </span>
                      <span
                        className={cn(
                          "mt-1 flex items-center gap-1.5 text-xs tabular-nums",
                          d.gap ? "font-semibold" : "font-normal",
                        )}
                      >
                        <StatusDot tone={d.gap ? "pending" : "done"} />
                        {formatDayCounts(d)}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {week.posts.map((post) => (
                <tr key={post.postId} data-testid="roster-row">
                  <th
                    scope="row"
                    className="border-b border-line p-3 text-left align-top font-normal"
                  >
                    <span className="block text-sm font-semibold">{post.name}</span>
                    <span className="block text-xs text-fg-muted tabular-nums">{post.hours}</span>
                  </th>
                  {post.cells.map((cell) => (
                    <td key={cell.date} className="border-b border-l border-line p-2 align-top">
                      {renderCell(cell, post)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* One day at a time below lg. */}
        <div className="flex w-full min-w-0 flex-col gap-3 lg:hidden" data-testid="roster-day-view">
          <div role="tablist" aria-label="Day" className="grid grid-cols-7 gap-1">
            {week.days.map((d, i) => {
              const label = dayLabel(d.date);
              const selected = i === dayIndex;
              return (
                <button
                  key={d.date}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={`${label.long} ${label.date}: ${formatDayCounts(d)}`}
                  onClick={() => setDayIndex(i)}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg border text-xs",
                    selected ? "border-foreground bg-surface font-semibold" : "border-line",
                  )}
                >
                  <span>{label.short}</span>
                  <span className="tabular-nums">{label.date}</span>
                  <StatusDot tone={d.gap ? "pending" : "done"} />
                </button>
              );
            })}
          </div>
          <p
            className={cn(
              "m-0 flex items-center gap-2 text-sm tabular-nums",
              day.gap ? "font-semibold" : "",
            )}
          >
            <StatusDot tone={day.gap ? "pending" : "done"} />
            {dayLabel(day.date).long} {formatShortDay(day.date).split(" ").slice(1).join(" ")} ·{" "}
            {formatDayCounts(day)}
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {week.posts.map((post) => {
              const cell = post.cells[dayIndex];
              if (!cell) return null;
              return (
                <li
                  key={post.postId}
                  className="flex flex-col gap-2 rounded-xl border border-line p-3"
                  data-testid="roster-day-post"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{post.name}</span>
                    <span className="text-xs text-fg-muted tabular-nums">
                      {cell.startsAt && cell.endsAt
                        ? formatShiftHours(cell.startsAt, cell.endsAt, timeZone)
                        : post.hours}
                    </span>
                  </div>
                  {renderCell(cell, post)}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Uncovered tray. */}
        <section
          aria-labelledby="uncovered-heading"
          className="flex w-full flex-[1_1_280px] flex-col gap-3 rounded-xl border border-line p-4 lg:w-auto"
          data-testid="uncovered-tray"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="uncovered-heading" className="m-0 type-h3">
              Uncovered
            </h2>
            <span className="text-sm font-semibold tabular-nums">{openPlaces} open</span>
          </div>
          {tray.length === 0 ? (
            week.totals.open > 0 ? (
              <p className="m-0 text-sm text-fg-muted">
                No open shifts are left to fill this week.
              </p>
            ) : (
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <Illustration name="all-covered" size="empty" decorative />
                <p className="m-0 text-sm text-fg-muted">Every post is covered this week.</p>
              </div>
            )
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {tray.map((card) => (
                <li
                  key={`${card.postId}|${card.date}`}
                  className="flex flex-col gap-2 rounded-lg bg-surface p-3"
                  data-testid="tray-card"
                >
                  <span className="text-sm font-semibold">{card.postName}</span>
                  <span className="text-[13px] text-fg-muted tabular-nums">
                    {formatShortDay(card.date)} ·{" "}
                    {formatShiftHours(card.startsAt, card.endsAt, timeZone)}
                    {card.open > 1 ? ` · ${card.open} places open` : ""}
                  </span>
                  {card.suggestion ? (
                    <span className="text-[13px]">
                      Suggested: <b>{card.suggestion.name}</b> · {card.suggestion.reason}
                    </span>
                  ) : (
                    <span className="text-[13px]">No one is free for this shift.</span>
                  )}
                  {canEdit ? (
                    <div className="flex flex-wrap gap-2">
                      {card.suggestion ? (
                        <form action={assignAction}>
                          <input type="hidden" name="postId" value={card.postId} />
                          <input type="hidden" name="date" value={card.date} />
                          <input type="hidden" name="workerId" value={card.suggestion.workerId} />
                          <input type="hidden" name="workerName" value={card.suggestion.name} />
                          <Button type="submit" variant="outline" size="sm" className="h-9">
                            Assign {card.suggestion.firstName}
                          </Button>
                        </form>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-9"
                        onClick={() =>
                          openPicker({
                            postId: card.postId,
                            postName: card.postName,
                            date: card.date,
                            startsAt: card.startsAt,
                            endsAt: card.endsAt,
                          })
                        }
                      >
                        {card.suggestion ? "Someone else" : "Choose someone"}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {!picking && assignState && !assignState.ok ? (
            <FormAlert message={assignState.formError} />
          ) : null}
          <p className="m-0 text-[13px] text-fg-muted">
            Suggestions skip anyone who has left, is on approved leave or is double-booked. People
            mapped to the site come first, then those furthest under the weekly standard hours;
            anyone within 4 hours of it, or with leave waiting for a decision, is noted.
          </p>
        </section>
      </div>

      <AssignSheet
        target={picking}
        siteId={siteId}
        weekStart={weekStart}
        timeZone={timeZone}
        weeklyStandardMinutes={weeklyStandardMinutes}
        candidates={candidates}
        action={assignAction}
        error={picking && assignState && !assignState.ok ? assignState.formError : undefined}
        onClose={() => setPicking(null)}
      />
      <RemoveSheet
        target={removing}
        action={removeAction}
        error={removing && removeState && !removeState.ok ? removeState.formError : undefined}
        fieldError={
          removing && removeState && !removeState.ok ? removeState.fieldErrors?.reason : undefined
        }
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

function AssignSheet({
  target,
  siteId,
  weekStart,
  timeZone,
  weeklyStandardMinutes,
  candidates,
  action,
  error,
  onClose,
}: {
  target: PickTarget | null;
  siteId: string;
  weekStart: string;
  timeZone: string;
  weeklyStandardMinutes: number;
  candidates: RosterCandidates;
  action: (formData: FormData) => void;
  error?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const ranked = useMemo<Suggestion[]>(
    () =>
      target
        ? rankCandidates({ ...target, siteId, weekStart }, candidates.workers, candidates.booked, {
            weeklyStandardMinutes,
            timeZone,
            leave: candidates.leave,
          })
        : [],
    [target, siteId, weekStart, candidates, weeklyStandardMinutes, timeZone],
  );
  const searching = query.trim().length > 0;
  const matching = searching ? ranked.filter((s) => matchesSearch(s, query)) : ranked;
  const eligible = matching.filter((s) => s.eligible).slice(0, searching ? 30 : 8);
  const blocked = matching.filter((s) => !s.eligible).slice(0, searching ? 10 : 5);

  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
          onClose();
        }
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="type-h3">{target?.postName ?? "Assign"}</SheetTitle>
          <SheetDescription className="tabular-nums">
            {target
              ? `${formatShortDay(target.date)} · ${formatShiftHours(target.startsAt, target.endsAt, timeZone)}`
              : ""}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Search all employees</span>
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or staff ID"
              className="h-11 rounded-lg text-[15px]"
            />
          </label>
          <FormAlert message={error} />
          <h3 className="m-0 type-label text-fg-muted">{searching ? "Matches" : "Suggested"}</h3>
          {eligible.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">
              {searching ? "No one free matches that search." : "No one is free for this shift."}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="picker-suggestions">
              {eligible.map((s) => (
                <li
                  key={s.workerId}
                  className="flex flex-col gap-2 rounded-lg border border-line p-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold">
                      {s.name} <span className="font-normal text-fg-muted">{s.staffId}</span>
                    </span>
                    <span className="text-[13px] text-fg-muted">{s.reason}</span>
                  </div>
                  {target ? (
                    <form action={action}>
                      <input type="hidden" name="postId" value={target.postId} />
                      <input type="hidden" name="date" value={target.date} />
                      <input type="hidden" name="workerId" value={s.workerId} />
                      <input type="hidden" name="workerName" value={s.name} />
                      <Button type="submit" variant="outline" size="sm" className="h-9">
                        Assign {s.firstName}
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {blocked.length > 0 ? (
            <>
              <h3 className="m-0 type-label text-fg-muted">Can&apos;t be assigned</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {blocked.map((s) => (
                  <li key={s.workerId} className="text-[13px] text-fg-muted">
                    {s.name} · {s.blocked}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RemoveSheet({
  target,
  action,
  error,
  fieldError,
  onClose,
}: {
  target: RemoveTarget | null;
  action: (formData: FormData) => void;
  error?: string;
  fieldError?: string;
  onClose: () => void;
}) {
  return (
    <Sheet open={target !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="type-h3">Remove from shift</SheetTitle>
          <SheetDescription>
            {target
              ? `${target.workerName} · ${target.postName} · ${formatShortDay(target.date)}`
              : ""}
          </SheetDescription>
        </SheetHeader>
        {target ? (
          <form action={action} className="flex flex-col gap-4 px-4 pb-6">
            <input type="hidden" name="assignmentId" value={target.assignmentId} />
            <Field
              label="Reason (optional)"
              name="reason"
              maxLength={500}
              defaultValue={target.reason}
              hint="For example: swapped with the night team."
              error={fieldError}
            />
            <FormAlert message={error} />
            <SubmitButton pendingLabel="Removing…">Remove from shift</SubmitButton>
          </form>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
