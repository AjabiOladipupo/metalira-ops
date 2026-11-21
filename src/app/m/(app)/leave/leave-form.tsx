"use client";

import { useActionState, useMemo, useState } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import {
  countLeaveDays,
  formatDayCount,
  formatShiftCover,
  spanDays,
} from "@/lib/leave/days";
import type { LeaveCounting } from "@/lib/leave/presets";
import { formatLeaveRange } from "@/lib/leave/requests";
import { cn } from "@/lib/utils";
import { cancelOwnLeaveAction, requestLeaveAction } from "@/server/people/own-leave-actions";

export interface FormType {
  id: string;
  name: string;
  counting: LeaveCounting;
  needsCertificate: boolean;
  /** Days left after requests waiting, or null when the type has no allowance. */
  available: number | null;
  /** "Opens 6 Jan 2027" when the worker hasn't the service yet. */
  opensOn: string | null;
}

export interface FormCalendar {
  today: string;
  yearEnd: string;
  workDays: number[];
  lastRostered: string | null;
  holidays: string[];
  shifts: { date: string; site: string }[];
}

const INPUT =
  "h-12 w-full min-w-0 rounded-xl border border-line bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

/**
 * "Ask for leave" (WkLeave board): type chips, from and to, the live count of days and shifts,
 * an optional reason and Send request. The count here mirrors the database
 * (src/lib/leave/days.ts); the database counts again when the request is sent and has the last
 * word.
 */
export function LeaveRequestForm({
  types,
  calendar,
  lineManagerName,
}: {
  types: FormType[];
  calendar: FormCalendar;
  lineManagerName: string | null;
}) {
  const [state, action] = useActionState(requestLeaveAction, null);
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const type = types.find((t) => t.id === typeId) ?? types[0];

  const cal = useMemo(
    () => ({
      workDays: calendar.workDays,
      lastRostered: calendar.lastRostered,
      holidays: new Set(calendar.holidays),
      shifts: calendar.shifts,
    }),
    [calendar],
  );

  const end = to || from;
  const count =
    type && from && end && end >= from && spanDays(from, end) <= 366
      ? countLeaveDays(from, end, type.counting, cal)
      : null;

  if (state?.ok) {
    return (
      <section
        aria-labelledby="sent"
        data-testid="leave-sent"
        className="flex flex-col gap-3 rounded-xl border-[1.5px] border-foreground p-4"
      >
        <h2 id="sent" className="m-0 font-display text-[22px] font-bold">
          {type?.name ?? "Leave"} · {from && end ? formatLeaveRange(from, end, false) : ""}
        </h2>
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-[15px]">
          <li className="flex items-center gap-2.5">
            <span aria-hidden className="size-2 rounded-full border-[1.5px] border-foreground bg-foreground" />
            Sent
          </li>
          <li className="flex items-center gap-2.5 font-semibold">
            <span aria-hidden className="size-2 rounded-full border-[1.5px] border-foreground" />
            Line manager{lineManagerName ? `: ${lineManagerName}` : ""}
          </li>
          <li className="flex items-center gap-2.5 text-fg-muted">
            <span aria-hidden className="size-2 rounded-full border-[1.5px] border-foreground" />
            HR: after your manager
          </li>
        </ol>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state.message} Your manager arranges cover for your shifts.
        </p>
      </section>
    );
  }

  if (!type) {
    return (
      <p className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]">
        Your company has no leave types yet. Ask HR.
      </p>
    );
  }

  const short = count && type.available !== null && count.days > type.available;

  return (
    <section aria-labelledby="ask" className="flex flex-col gap-3.5">
      <h1 id="ask" className="m-0 font-display text-[25px] font-bold">
        Ask for leave
      </h1>
      <form action={action} aria-label="Ask for leave" className="flex flex-col gap-3.5" noValidate>
        <input type="hidden" name="leaveTypeId" value={type.id} />
        <div role="group" aria-label="Leave type" className="grid grid-cols-2 gap-2">
          {types.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === type.id}
              onClick={() => setTypeId(t.id)}
              className={cn(
                "min-h-12 rounded-xl border px-2 text-[15px] font-semibold",
                t.id === type.id
                  ? "border-foreground bg-foreground text-background"
                  : "border-line bg-background text-foreground",
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            From
            <input
              type="date"
              name="startDate"
              required
              min={calendar.today}
              max={calendar.yearEnd}
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                if (to && e.target.value > to) setTo(e.target.value);
              }}
              className={INPUT}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            To
            <input
              type="date"
              name="endDate"
              required
              min={from || calendar.today}
              max={calendar.yearEnd}
              value={end}
              onChange={(e) => setTo(e.target.value)}
              className={INPUT}
            />
          </label>
        </div>
        <p data-testid="leave-count" aria-live="polite" className="m-0 text-[15px]">
          {count ? (
            <>
              <b>{formatDayCount(count.days, type.counting)}.</b> {formatShiftCover(count)}
              {short ? ` You have ${type.available} left.` : ""}
            </>
          ) : (
            <span className="text-fg-muted">
              {type.available !== null
                ? `${type.available} ${type.available === 1 ? "day" : "days"} of ${type.name.toLowerCase()} leave left.`
                : "Choose your first and last day."}
            </span>
          )}
        </p>
        {type.opensOn ? (
          <p className="m-0 text-sm text-fg-muted">{type.name} leave opens {type.opensOn}.</p>
        ) : null}
        {type.needsCertificate ? (
          <p className="m-0 text-sm text-fg-muted">
            Show your certificate to your manager or HR. They tick it before approving.
          </p>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Reason (optional)
          <textarea
            name="reason"
            rows={2}
            maxLength={500}
            placeholder="A short reason helps your manager decide"
            className="min-h-12 rounded-xl border border-line bg-background p-2.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          />
        </label>
        <FormAlert message={state && !state.ok ? state.message : undefined} />
        <SubmitButton size="lg" pendingLabel="Sending…" disabled={!count || count.days === 0}>
          Send request
        </SubmitButton>
        <p className="m-0 text-sm text-fg-muted">You will get a message when it is decided.</p>
      </form>
    </section>
  );
}

/** "Cancel request" on a request still waiting for a decision. */
export function CancelOwnLeave({ requestId }: { requestId: string }) {
  const [state, action] = useActionState(cancelOwnLeaveAction, null);
  if (state?.ok) {
    return (
      <span role="status" className="text-sm text-fg-muted">
        {state.message}
      </span>
    );
  }
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        className="min-h-11 rounded-lg px-2 text-sm font-medium text-signal underline-offset-2 hover:underline"
      >
        Cancel request
      </button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
