import { Banknote, CalendarDays, ChevronRight, CircleHelp, Plane } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Illustration } from "@/components/illustration";
import { LogoMark } from "@/components/logo";
import { ThemeButton } from "@/components/theme/theme-button";
import { APP_HOME_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import { initials } from "@/lib/people";
import { timeIn } from "@/lib/roster";
import { createServerSupabase } from "@/lib/supabase/server";
import { signOutWorker } from "@/server/identity/worker-actions";
import { lookupWorkerPageSession } from "@/server/identity/worker-session";
import { currentShift, loadClockContext, type ClockContext } from "@/server/workforce/clock-data";

import { ClockButton } from "../_components/clock/clock-button";
import { InboxLink } from "../_components/inbox-link";
import { InstallCard } from "../_components/offline/install-card";
import { WorkerSignOutForm } from "../_components/offline/sign-out-form";

export const metadata: Metadata = { title: "Home" };

const copy = workerMessages.home;

const TILES = [
  { href: "/m/shifts", label: copy.tiles.shifts, Icon: CalendarDays },
  { href: "/m/leave", label: copy.tiles.leave, Icon: Plane },
  { href: "/m/payslips", label: copy.tiles.payslips, Icon: Banknote },
  { href: "/m/help", label: copy.tiles.help, Icon: CircleHelp },
] as const;

/** "Hello, Musa" and the avatar that opens Me, or the explanation for an unlinked login. */
async function Header() {
  const lookup = await lookupWorkerPageSession();
  if (lookup.type === "signed_out") redirect(WORKER_SIGN_IN_PATH);
  if (lookup.type === "not_worker") redirect(APP_HOME_PATH);
  if (lookup.type === "unlinked") {
    return (
      <div className="flex flex-col gap-4">
        <div className="-mb-2 flex justify-end">
          <ThemeButton className="-mr-2" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 font-display text-[25px] leading-tight font-bold">
            {copy.unlinkedTitle}
          </h1>
          <p className="m-0 text-[15px] text-fg-muted">{copy.unlinked}</p>
        </div>
        <WorkerSignOutForm
          action={signOutWorker}
          label={copy.signOut}
          variant="outline"
          buttonClassName="h-11 rounded-lg"
        />
      </div>
    );
  }
  const worker = lookup.session;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2">
        <LogoMark size={24} />
        <h1 className="m-0 truncate font-display text-xl font-bold">
          {copy.hello(worker.firstName)}
        </h1>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <InboxLink />
        <ThemeButton />
        <Link
          href="/m/me"
          aria-label={copy.myProfile}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-semibold text-background no-underline hover:text-background"
        >
          {initials(worker)}
        </Link>
      </span>
    </div>
  );
}

/**
 * Today's shift card and the shortcut tiles. When the company has Shifts switched off (slice
 * 3.0) there is no shift card and no My shifts tile.
 */
async function HomeBody() {
  const lookup = await lookupWorkerPageSession();
  const shifts = lookup.type !== "worker" || lookup.session.shiftsEnabled;
  const tiles = shifts ? TILES : TILES.filter((t) => t.href !== "/m/shifts");
  const now = new Date();
  const clock =
    shifts && lookup.type === "worker"
      ? await loadClockContext(await createServerSupabase(), lookup.session.organisationId, now)
      : null;
  return (
    <>
      {clock ? <ShiftToday clock={clock} now={now.getTime()} /> : null}

      <nav aria-label={copy.shortcuts} className="grid grid-cols-2 gap-3 pt-2">
        {tiles.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex h-[104px] flex-col justify-between rounded-xl bg-surface p-4 text-[17px] font-semibold text-foreground no-underline hover:bg-line hover:text-foreground"
          >
            <span className="flex items-start justify-between">
              <Icon strokeWidth={1.75} className="size-[26px]" aria-hidden />
              <ChevronRight strokeWidth={1.75} className="size-4 text-fg-muted" aria-hidden />
            </span>
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

const LAGOS = "Africa/Lagos";

/**
 * "Your shift today" and the big round Clock in button (WkHome board, slice 3.5): the shift a
 * punch now would belong to, else the next one in the coming 24 hours.
 */
function ShiftToday({ clock, now }: { clock: ClockContext; now: number }) {
  const shift =
    currentShift(clock.shifts, now) ?? clock.shifts.find((s) => Date.parse(s.startsAt) > now) ?? null;
  const lastPunch = clock.lastPunch
    ? { kind: clock.lastPunch.kind, recordedAt: clock.lastPunch.recordedAt, open: clock.lastPunch.open }
    : null;
  return (
    <>
      <section
        aria-labelledby="shift-today"
        data-testid="shift-today"
        className="flex items-center gap-3 rounded-xl border border-line px-4 py-3.5"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 id="shift-today" className="m-0 type-label text-fg-muted">
            {copy.shiftLabel}
          </h2>
          {shift ? (
            <>
              <p className="m-0 font-display text-[25px] leading-tight font-bold">
                {workerMessages.clock.homeShiftHours(
                  timeIn(shift.startsAt, LAGOS),
                  timeIn(shift.endsAt, LAGOS),
                )}
              </p>
              <p className="m-0 text-base">
                {workerMessages.clock.homeShiftWhere(shift.postName, shift.siteName)}
              </p>
            </>
          ) : (
            <>
              <p className="m-0 font-display text-[25px] leading-tight font-bold">{copy.noShift}</p>
              <p className="m-0 text-sm text-fg-muted">{copy.noShiftHint}</p>
            </>
          )}
        </div>
        {shift ? null : <Illustration name="clock-in" size="worker" decorative />}
      </section>
      {clock.left ? null : <ClockButton lastPunch={lastPunch} />}
    </>
  );
}

function HomeBodySkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <span className="h-[106px] rounded-xl bg-surface" />
      <div className="grid grid-cols-2 gap-3 pt-2">
        {TILES.map((t) => (
          <span key={t.href} className="h-[104px] rounded-xl bg-surface" />
        ))}
      </div>
    </div>
  );
}

/**
 * Worker home, from the WkHome board (slice 1.10): greeting, today's shift ("No shift today"
 * until rosters exist), shortcut tiles, and the location line. The board's language picker is
 * hidden: English only for now (owner decision 16).
 */
export default function WorkerHomePage() {
  return (
    <main className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-4">
      <Suspense
        fallback={
          <div aria-hidden className="flex h-11 items-center justify-between">
            <span className="h-6 w-40 rounded bg-surface" />
            <span className="size-11 rounded-full bg-surface" />
          </div>
        }
      >
        <Header />
      </Suspense>

      <Suspense fallback={<HomeBodySkeleton />}>
        <HomeBody />
      </Suspense>

      <InstallCard />

      <p className="m-0 mt-auto pt-4 text-center text-[13px] text-fg-muted">{copy.location}</p>
    </main>
  );
}
