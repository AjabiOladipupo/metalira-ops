"use client";

import { Clock } from "lucide-react";
import Link from "next/link";

import { workerMessages } from "@/lib/messages/worker";
import { timeIn } from "@/lib/roster";

import { useClockState, type ServerLastPunch } from "./use-clock-mode";

const copy = workerMessages.clock;

/**
 * The big round Clock in / Clock out button on worker home (WkHome board), from the worker's
 * newest punch on the phone or, with none waiting, the server's last punch.
 */
export function ClockButton({ lastPunch }: { lastPunch: ServerLastPunch | null }) {
  const state = useClockState(lastPunch);
  const label = state.clockedIn ? copy.homeButtonOut : copy.homeButtonIn;
  return (
    <div className="flex flex-col items-center gap-3 pt-2 pb-3">
      <Link
        href="/m/clock"
        data-testid="clock-button"
        data-clocked-in={state.clockedIn ? "yes" : "no"}
        className="flex size-[168px] flex-col items-center justify-center gap-2 rounded-full bg-foreground text-background no-underline shadow-[0_0_0_10px_var(--surface)] hover:text-background hover:opacity-90"
      >
        <Clock strokeWidth={1.75} className="size-12" aria-hidden />
        <span className="font-display text-[25px] font-bold">{label}</span>
      </Link>
      {state.clockedIn && state.since !== null ? (
        <p className="m-0 text-sm text-fg-muted">
          {copy.homeClockedInAt(timeIn(new Date(state.since).toISOString(), "Africa/Lagos"))}
        </p>
      ) : null}
    </div>
  );
}
