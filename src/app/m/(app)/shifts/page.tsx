import type { Metadata } from "next";
import { Suspense } from "react";

import { Illustration } from "@/components/illustration";
import { addDays } from "@/lib/dates";
import { workerMessages } from "@/lib/messages/worker";
import { dayLabel, formatShiftHours, formatShortDay } from "@/lib/roster";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import {
  loadCompanyClock,
  loadMyPublishedShifts,
  type MyShift,
} from "@/server/workforce/roster-publish-data";

import { WorkerTopBar } from "../../_components/worker-top-bar";

export const metadata: Metadata = { title: "My shifts" };

const copy = workerMessages.shifts;

function groupByDay(shifts: MyShift[]): [string, MyShift[]][] {
  const days = new Map<string, MyShift[]>();
  for (const s of shifts) days.set(s.date, [...(days.get(s.date) ?? []), s]);
  return [...days.entries()];
}

function DayGroup({
  date,
  shifts,
  today,
  timeZone,
}: {
  date: string;
  shifts: MyShift[];
  today: string;
  timeZone: string;
}) {
  const name =
    date === today ? copy.today : date === addDays(today, 1) ? copy.tomorrow : dayLabel(date).long;
  const rest = formatShortDay(date).split(" ").slice(1).join(" ");
  return (
    <li className="flex flex-col gap-2" data-testid="shift-day" data-date={date}>
      <h3 className="m-0 text-sm font-semibold">
        {name} <span className="font-normal text-fg-muted">{rest}</span>
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {shifts.map((s) => (
          <li
            key={s.id}
            className="flex flex-col gap-0.5 rounded-xl border border-line px-4 py-3"
            data-testid="my-shift"
          >
            <span className="font-display text-xl font-bold tabular-nums">
              {formatShiftHours(s.startsAt, s.endsAt, timeZone)}
            </span>
            <span className="text-[15px] font-medium break-words">
              {copy.where(s.postName, s.siteName)}
            </span>
            {s.siteLandmark || s.siteAddress ? (
              <span className="text-sm break-words text-fg-muted">
                {[s.siteLandmark, s.siteAddress].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

async function Shifts() {
  const session = await requireWorkerPageSession();
  const supabase = await createServerSupabase();
  const { timeZone, today } = await loadCompanyClock(supabase, session.organisationId);
  const shifts = await loadMyPublishedShifts(supabase, addDays(today, -7), addDays(today, 13));
  const upcoming = groupByDay(shifts.filter((s) => s.date >= today));
  const earlier = groupByDay(shifts.filter((s) => s.date < today)).reverse();

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="shifts-upcoming" className="flex flex-col gap-3">
        <h2 id="shifts-upcoming" className="m-0 type-label text-fg-muted">
          {copy.upcoming}
        </h2>
        {upcoming.length === 0 ? (
          <div
            data-testid="shifts-empty"
            className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3"
          >
            <p className="m-0 min-w-0 flex-1 text-[15px] text-fg-muted">{copy.empty}</p>
            <Illustration name="clock-in" size="worker" decorative />
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0" data-testid="shifts-upcoming">
            {upcoming.map(([date, list]) => (
              <DayGroup key={date} date={date} shifts={list} today={today} timeZone={timeZone} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="shifts-earlier" className="flex flex-col gap-3">
        <h2 id="shifts-earlier" className="m-0 type-label text-fg-muted">
          {copy.earlier}
        </h2>
        {earlier.length === 0 ? (
          <p className="m-0 text-[15px] text-fg-muted">{copy.earlierEmpty}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0" data-testid="shifts-earlier">
            {earlier.map(([date, list]) => (
              <DayGroup key={date} date={date} shifts={list} today={today} timeZone={timeZone} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * My shifts (slice 3.3): the worker's published shifts for the next 14 days by day, then the last
 * 7 days. Only what the company published and still has them on (my_published_shifts).
 */
export default function ShiftsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }} inbox>
          <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
        </WorkerTopBar>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Suspense fallback={<span aria-hidden className="block h-64 w-full rounded bg-surface" />}>
          <Shifts />
        </Suspense>
      </div>
    </main>
  );
}
