import { Illustration } from "@/components/illustration";
import { addDays } from "@/lib/dates";
import { workerMessages } from "@/lib/messages/worker";
import { formatShiftHours } from "@/lib/roster";
import { pickShiftsToday } from "@/lib/roster-publish";
import { createServerSupabase } from "@/lib/supabase/server";
import { lookupWorkerPageSession } from "@/server/identity/worker-session";
import { loadCompanyClock, loadMyPublishedShifts } from "@/server/workforce/roster-publish-data";

const home = workerMessages.home;
const copy = workerMessages.shifts;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="shift-today"
      className="flex items-center gap-3 rounded-xl border border-line px-4 py-3.5"
      data-testid="shift-today"
    >
      {children}
    </section>
  );
}

/** The no-shift state, also the loading fallback (slice 1.10's card). */
export function NoShiftToday() {
  return (
    <Frame>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h2 id="shift-today" className="m-0 type-label text-fg-muted">
          {home.shiftLabel}
        </h2>
        <p className="m-0 font-display text-[25px] leading-tight font-bold">{home.noShift}</p>
        <p className="m-0 text-sm text-fg-muted">{home.noShiftHint}</p>
      </div>
      <Illustration name="clock-in" size="worker" decorative />
    </Frame>
  );
}

/**
 * "Your shift today" on the worker home (slice 3.3): the time, post and site of today's published
 * shift (one still running from last night counts), or the no-shift state. Only published shifts
 * (my_published_shifts). Clock-in arrives with slice 3.5.
 */
export async function ShiftTodayCard() {
  const lookup = await lookupWorkerPageSession();
  if (lookup.type !== "worker") return <NoShiftToday />;
  const supabase = await createServerSupabase();
  const { timeZone, today, nowMs } = await loadCompanyClock(
    supabase,
    lookup.session.organisationId,
  );
  const shifts = await loadMyPublishedShifts(supabase, addDays(today, -1), today);
  const { shift, more } = pickShiftsToday(shifts, today, nowMs);
  if (!shift) return <NoShiftToday />;

  return (
    <Frame>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h2 id="shift-today" className="m-0 type-label text-fg-muted">
          {home.shiftLabel}
        </h2>
        <p className="m-0 font-display text-[25px] leading-tight font-bold tabular-nums">
          {formatShiftHours(shift.startsAt, shift.endsAt, timeZone)}
        </p>
        <p className="m-0 text-[15px] font-medium break-words">
          {copy.homeWhere(shift.postName, shift.siteName)}
        </p>
        {shift.siteLandmark || shift.siteAddress ? (
          <p className="m-0 text-sm break-words text-fg-muted">
            {shift.siteLandmark ?? shift.siteAddress}
          </p>
        ) : null}
        {more > 0 ? <p className="m-0 text-sm text-fg-muted">{copy.alsoToday(more)}</p> : null}
      </div>
    </Frame>
  );
}
