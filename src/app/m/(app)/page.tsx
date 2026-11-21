import {
  Banknote,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  Clock,
  Plane,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { LogoMark } from "@/components/logo";
import { ThemeButton } from "@/components/theme/theme-button";
import { APP_HOME_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import { initials } from "@/lib/people";
import { createServerSupabase } from "@/lib/supabase/server";
import { signOutWorker } from "@/server/identity/worker-actions";
import { lookupWorkerPageSession } from "@/server/identity/worker-session";
import { loadClockContext, type ClockContext } from "@/server/workforce/clock-data";
import { loadCrewContext } from "@/server/workforce/crew-data";
import { formatShortDay } from "@/lib/roster";
import { loadMyQueries } from "@/server/people/queries";

import { ClockButton } from "../_components/clock/clock-button";
import { InboxLink } from "../_components/inbox-link";
import { InstallCard } from "../_components/offline/install-card";
import { WorkerSignOutForm } from "../_components/offline/sign-out-form";
import { ShiftTodayCard } from "../_components/shift-today-card";

export const metadata: Metadata = { title: "Home" };

const copy = workerMessages.home;

const TILES = [
  { href: "/m/shifts", label: copy.tiles.shifts, Icon: CalendarDays },
  // Slice 4.3: the worker's days this pay period, with "This is wrong".
  { href: "/m/hours", label: "My hours", Icon: Clock },
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
  const tiles = shifts
    ? TILES
    : TILES.filter((t) => t.href !== "/m/shifts" && t.href !== "/m/hours");
  const now = new Date();
  const supabase = shifts && lookup.type === "worker" ? await createServerSupabase() : null;
  const clock =
    supabase && lookup.type === "worker"
      ? await loadClockContext(supabase, lookup.session.organisationId, now)
      : null;
  // Worker-supervisors (the line manager of a crew) get the crew clock-in card (slice 3.6).
  const crewSize =
    supabase && lookup.type === "worker" && clock && !clock.left
      ? await loadCrewContext(supabase, lookup.session.organisationId)
          .then((c) => c.crewSize)
          .catch(() => 0)
      : 0;
  return (
    <>
      {shifts ? (
        <Suspense
          fallback={<span aria-hidden className="block h-[118px] rounded-xl border border-line" />}
        >
          <ShiftTodayCard />
        </Suspense>
      ) : null}
      {clock && !clock.left ? <ClockButton lastPunch={clockLastPunch(clock)} /> : null}
      {crewSize > 0 ? (
        <Link
          href="/m/crew"
          data-testid="crew-card"
          className="flex h-16 items-center gap-3 rounded-xl bg-foreground px-4 text-background no-underline hover:text-background hover:opacity-90"
        >
          <Users strokeWidth={1.75} className="size-6 shrink-0" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-display text-lg font-bold">{workerMessages.crew.homeCard}</span>
            <span className="text-[13px] opacity-80">
              {workerMessages.crew.homeCardLine(crewSize)}
            </span>
          </span>
          <ChevronRight strokeWidth={1.75} className="size-5 shrink-0" aria-hidden />
        </Link>
      ) : null}

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

/**
 * "1 query from Kola Adebayo · reply by Mon 2 Nov" (WkHome board, slice 4.6): queries still
 * awaiting the worker's reply, the earliest reply-by date first. Nothing when there are none.
 */
async function QueryBanner() {
  const lookup = await lookupWorkerPageSession();
  if (lookup.type !== "worker") return null;
  const queries = await loadMyQueries({
    supabase: await createServerSupabase(),
    organisationId: lookup.session.organisationId,
    workerId: lookup.session.workerId,
  }).catch(() => []);
  const waiting = queries
    .filter((q) => q.status === "awaiting_reply")
    .sort((a, b) => a.replyBy.localeCompare(b.replyBy));
  const first = waiting[0];
  if (!first) return null;
  return (
    <Link
      href="/m/queries"
      data-testid="home-query-banner"
      className="flex items-center justify-between gap-2 rounded-xl border-[1.5px] border-foreground px-3.5 py-3 text-[15px] font-semibold text-foreground no-underline hover:bg-surface hover:text-foreground"
    >
      {workerMessages.queries.homeBanner(
        waiting.length,
        first.raisedByName,
        formatShortDay(first.replyBy),
      )}
      <ChevronRight strokeWidth={1.75} className="size-[18px] shrink-0" aria-hidden />
    </Link>
  );
}

/** The server's last punch for the round Clock in / Clock out button (slice 3.5). */
function clockLastPunch(clock: ClockContext) {
  return clock.lastPunch
    ? {
        kind: clock.lastPunch.kind,
        recordedAt: clock.lastPunch.recordedAt,
        open: clock.lastPunch.open,
      }
    : null;
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
 * Worker home, from the WkHome board (slice 1.10): greeting, today's published shift (slice 3.3),
 * shortcut tiles, and the location line. The board's language picker is
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

      <Suspense fallback={null}>
        <QueryBanner />
      </Suspense>

      <Suspense fallback={<HomeBodySkeleton />}>
        <HomeBody />
      </Suspense>

      <InstallCard />

      <p className="m-0 mt-auto pt-4 text-center text-[13px] text-fg-muted">{copy.location}</p>
    </main>
  );
}
