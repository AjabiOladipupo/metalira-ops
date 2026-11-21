import type { Metadata } from "next";
import { Suspense } from "react";

import { formatDate, lagosToday } from "@/lib/dates";
import { workerMessages } from "@/lib/messages/worker";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { currentShift, loadClockContext } from "@/server/workforce/clock-data";
import { loadMyConsents } from "@/server/workforce/consents";

import { ClockFlow, ClockTitle } from "../../_components/clock/clock-flow";
import { ConsentScreen } from "../../_components/consent-screen";
import { WorkerTopBar } from "../../_components/worker-top-bar";

export const metadata: Metadata = { title: "Clock" };

const copy = workerMessages.clock;

const day = (at: string | null) => (at ? formatDate(lagosToday(new Date(at))) : null);

async function Clock() {
  const session = await requireWorkerPageSession();
  const supabase = await createServerSupabase();
  const now = new Date();
  const ctx = await loadClockContext(supabase, session.organisationId, now);
  const lastPunch = ctx.lastPunch
    ? {
        kind: ctx.lastPunch.kind,
        recordedAt: ctx.lastPunch.recordedAt,
        open: ctx.lastPunch.open,
        siteId: ctx.lastPunch.siteId,
      }
    : null;

  const top = (
    <div className="px-4 pt-3 pb-1">
      <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }} inbox>
        <ClockTitle lastPunch={lastPunch} />
      </WorkerTopBar>
    </div>
  );

  const blocked = ctx.left ? copy.left : !ctx.shiftsEnabled ? copy.shiftsOff : null;
  if (blocked) {
    return (
      <>
        {top}
        <p className="m-0 px-4 pt-4 text-base" data-testid="clock-blocked">
          {blocked}
        </p>
      </>
    );
  }

  // Consent first (slice 3.1's screen): location is needed to clock in on the phone. Declining
  // is a real choice: the supervisor clocks the worker in instead (slice 3.6).
  if (!ctx.locationConsent) {
    const consents = await loadMyConsents({ supabase, workerId: session.workerId });
    return (
      <>
        {top}
        <div className="flex flex-col gap-4 px-4 pt-2 pb-4" data-testid="clock-consent">
          <h1 className="m-0 font-display text-[25px] font-bold">{copy.consentTitle}</h1>
          <p className="m-0 text-[15px]">{copy.consentLine}</p>
          <ConsentScreen
            consents={consents.map((c) => ({
              kind: c.kind,
              agreedOn: day(c.acceptedAt),
              withdrawnOn: day(c.withdrawnAt),
            }))}
          />
        </div>
      </>
    );
  }

  const shift = currentShift(ctx.shifts, now.getTime());
  return (
    <>
      {top}
      <ClockFlow
        selfieConsent={ctx.selfieConsent}
        sites={ctx.sites}
        shiftSiteId={shift?.siteId ?? null}
        lastPunch={lastPunch}
      />
    </>
  );
}

/**
 * Clock in and out (slice 3.5, WkClock board). The page reads the worker's clock context with
 * their own session; the flow runs on the phone and saves every punch in the offline queue.
 */
export default function ClockPage() {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={<span aria-hidden className="m-4 block h-96 rounded bg-surface" />}>
        <Clock />
      </Suspense>
    </main>
  );
}
