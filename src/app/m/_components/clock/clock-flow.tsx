"use client";

import { liveQuery } from "dexie";
import { ArrowDownToLine, Check } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { queueEvent } from "@/lib/offline/active-queue";
import type { QueueStatus } from "@/lib/offline/types";
import { workerMessages } from "@/lib/messages/worker";
import {
  NOTE_MAX,
  OUTSIDE_REASONS,
  OUTSIDE_REASON_LABELS,
  formatDistance,
  noteProblem,
  pickSite,
  previewSite,
  type ClockSite,
  type OutsideReason,
  type PunchPayload,
  type SitePreview,
} from "@/lib/punches/clock";
import { PUNCH_CODE_MESSAGES, isPunchErrorCode } from "@/lib/punches/codes";
import { timeIn } from "@/lib/roster";
import { cn } from "@/lib/utils";

import { useActiveQueue, useOnline } from "../offline/hooks";
import { SelfieCamera } from "./selfie-camera";
import { useClockState, type ServerLastPunch } from "./use-clock-mode";

const copy = workerMessages.clock;
const LAGOS = "Africa/Lagos";

/** What the page read on the server for this worker (public.my_clock_context). */
export interface ClockFlowProps {
  selfieConsent: boolean;
  sites: ClockSite[];
  /** The site of the shift a punch now would belong to, if any. */
  shiftSiteId: string | null;
  lastPunch: (ServerLastPunch & { siteId: string | null }) | null;
}

interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
}

type Stage =
  | { name: "locating" }
  | { name: "located"; fix: Fix | null; failure: "denied" | "timeout" | null }
  | { name: "selfie" }
  | { name: "done"; id: string; at: number; kind: "in" | "out"; note: string };

/** The steps bar: Location, Selfie, Done (WkClock board). */
function Steps({ stage, withSelfie }: { stage: Stage["name"]; withSelfie: boolean }) {
  const order = withSelfie
    ? [copy.stepLocation, copy.stepSelfie, copy.stepDone]
    : [copy.stepLocation, copy.stepDone];
  const reached =
    stage === "done" ? order.length : stage === "selfie" ? 2 : stage === "located" ? 1 : 0;
  return (
    <ol
      aria-label={copy.steps}
      className="m-0 grid list-none gap-1.5 px-4 pt-1"
      style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))` }}
    >
      {order.map((label, i) => (
        <li
          key={label}
          className="flex flex-col gap-1.5"
          aria-current={i === Math.min(reached, order.length - 1) ? "step" : undefined}
        >
          <span
            className={cn("h-1 rounded-full", i < Math.max(reached, 1) ? "bg-foreground" : "bg-line")}
          />
          <span className="text-xs text-fg-muted">{label}</span>
        </li>
      ))}
    </ol>
  );
}

function locate(): Promise<{ fix: Fix } | { failure: "denied" | "timeout" }> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ failure: "denied" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          fix: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: Math.max(0, Math.round(position.coords.accuracy)),
          },
        }),
      (error) => resolve({ failure: error.code === error.PERMISSION_DENIED ? "denied" : "timeout" }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

/** A schematic of the site circle with the phone's dot, for an inside result. */
function InsideMap({ preview, site }: { preview: SitePreview; site: ClockSite }) {
  const ratio = Math.min(1, (preview.distanceM ?? 0) / Math.max(site.radiusM, 1));
  return (
    <div
      role="img"
      aria-label={copy.insideMapLabel}
      className="relative h-[220px] overflow-hidden rounded-xl bg-surface"
    >
      <span className="absolute top-1/2 left-1/2 size-40 -translate-1/2 rounded-full border-2 border-dashed border-fg-muted" />
      <span className="absolute top-1/2 left-1/2 size-3 -translate-1/2 rounded-[3px] bg-fg-muted" />
      <span
        className="absolute top-1/2 left-1/2 size-[22px] rounded-full border-[3px] border-background bg-foreground"
        style={{ transform: `translate(calc(-50% + ${ratio * 60}px), calc(-50% - ${ratio * 40}px))` }}
      />
    </div>
  );
}

/** Watches one queued punch: queued, sending, sent or refused. */
function useItemStatus(id: string | null): { status: QueueStatus | null; error: string | null } {
  const queue = useActiveQueue();
  const [state, setState] = useState<{ status: QueueStatus | null; error: string | null }>({
    status: null,
    error: null,
  });
  useEffect(() => {
    if (!queue || !id) return;
    const subscription = liveQuery(() => queue.db.punchQueue.get(id)).subscribe({
      next: (item) => setState({ status: item?.status ?? null, error: item?.last_error ?? null }),
      error: () => setState({ status: null, error: null }),
    });
    return () => subscription.unsubscribe();
  }, [queue, id]);
  return state;
}

function DoneScreen({ stage }: { stage: Extract<Stage, { name: "done" }> }) {
  const online = useOnline();
  const { status, error } = useItemStatus(stage.id);
  const time = timeIn(new Date(stage.at).toISOString(), LAGOS);
  let line: string;
  if (status === "sent") line = copy.sent;
  else if (status === "failed_permanent") {
    line = isPunchErrorCode(error) ? PUNCH_CODE_MESSAGES[error] : copy.failed;
  } else if (!online || status === null) line = copy.savedOffline;
  else line = copy.sending;
  return (
    <div className="flex flex-1 flex-col justify-center gap-4" data-testid="clock-done">
      <span className="flex size-[72px] items-center justify-center rounded-full bg-foreground text-background">
        <Check strokeWidth={2} className="size-9" aria-hidden />
      </span>
      <h1 className="m-0 font-display text-[34px] leading-[1.1] font-bold">
        {stage.kind === "in" ? copy.clockedInAt(time) : copy.clockedOutAt(time)}
      </h1>
      <p
        role="status"
        data-testid="clock-send-status"
        data-status={status ?? "unknown"}
        className="m-0 flex items-center gap-2 text-base"
      >
        <ArrowDownToLine strokeWidth={1.75} className="size-5 shrink-0" aria-hidden />
        {line}
      </p>
      <p className="m-0 text-[15px] text-fg-muted" data-testid="clock-note">
        {stage.note}
      </p>
      <Link
        href="/m"
        className="mt-3 flex h-[52px] items-center justify-center rounded-xl border border-foreground text-base font-semibold text-foreground no-underline hover:bg-surface hover:text-foreground"
      >
        {copy.backHome}
      </Link>
    </div>
  );
}

/**
 * Clock in or out (WkClock board): find the phone's location (20 seconds at most), show the
 * distance to the site and whether it looks inside, ask why when it doesn't, take the selfie on
 * a clock-in, and save the punch on the phone. Every punch goes through the offline queue, even
 * online; the queue sends it straight away when it can. The server decides inside or outside,
 * the time and the flags; this screen only previews.
 */
export function ClockFlow({ selfieConsent, sites, shiftSiteId, lastPunch }: ClockFlowProps) {
  const state = useClockState(lastPunch);
  const queue = useActiveQueue();
  const [stage, setStage] = useState<Stage>({ name: "locating" });
  const [mode, setMode] = useState<"in" | "out" | null>(null);
  const [reason, setReason] = useState<OutsideReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run = useRef(0);

  // The mode is fixed once the phone's queue is read, so a punch sent mid-flow can't flip it.
  useEffect(() => {
    if (mode === null && state.ready) setMode(state.clockedIn ? "out" : "in");
  }, [mode, state.ready, state.clockedIn]);

  const findLocation = useCallback(async () => {
    const attempt = ++run.current;
    setStage({ name: "locating" });
    const result = await locate();
    if (attempt !== run.current) return;
    setStage(
      "fix" in result
        ? { name: "located", fix: result.fix, failure: null }
        : { name: "located", fix: null, failure: result.failure },
    );
  }, []);

  useEffect(() => {
    // Starts the location request once, when the screen opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void findLocation();
  }, [findLocation]);

  const kind = mode ?? "in";
  const withSelfie = kind === "in" && selfieConsent;
  const fix = stage.name === "located" ? stage.fix : null;
  const preferred = shiftSiteId ?? (kind === "out" ? (lastPunch?.siteId ?? null) : null);
  const site = pickSite(sites, preferred, fix ? { lat: fix.lat, lng: fix.lng } : null);
  const preview = site && fix ? previewSite(site, { lat: fix.lat, lng: fix.lng }, fix.accuracy) : null;
  const away = preview?.result === "outside" || preview?.result === "near";
  const noteError = reason === "other" ? noteProblem(note) : null;

  // Kept from the location step for the selfie step and the save.
  const located = useRef<{ fix: Fix | null; siteId: string | null; away: boolean; unknown: boolean }>(
    { fix: null, siteId: null, away: false, unknown: true },
  );

  async function save(photo: Blob | null) {
    if (!queue) {
      setFailed(copy.noQueue);
      return;
    }
    const where = located.current;
    const payload: PunchPayload = {
      site_id: where.siteId,
      latitude: where.fix?.lat ?? null,
      longitude: where.fix?.lng ?? null,
      accuracy_m: where.fix?.accuracy ?? null,
      outside_reason: where.away ? reason : null,
      outside_note: where.away && reason === "other" && note.trim() ? note.trim() : null,
      has_selfie: kind === "in" && photo !== null,
    };
    setBusy(true);
    setFailed(null);
    try {
      const item = await queueEvent({
        kind: kind === "in" ? "clock_in" : "clock_out",
        payload,
        ...(photo ? { photo } : {}),
      });
      let doneNote: string;
      if (where.away) {
        doneNote = copy.noteOutside(reason ? OUTSIDE_REASON_LABELS[reason] : null);
      } else if (!where.fix) doneNote = copy.noteNoLocation;
      else if (where.unknown) doneNote = copy.noteNoSite;
      else if (kind === "out") doneNote = copy.noteOut;
      else if (photo) doneNote = copy.noteInsideSelfie;
      else if (withSelfie) doneNote = copy.noteNoSelfie;
      else doneNote = copy.noteInside;
      setStage({ name: "done", id: item.client_event_id, at: item.device_time, kind, note: doneNote });
    } catch {
      setFailed(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  function next() {
    located.current = {
      fix,
      siteId: site?.id ?? null,
      away,
      unknown: !preview || preview.result === "unknown",
    };
    if (withSelfie) setStage({ name: "selfie" });
    else void save(null);
  }

  const proceedLabel = withSelfie ? copy.takeSelfie : kind === "in" ? copy.clockInNow : copy.clockOutNow;

  return (
    <>
      <Steps stage={stage.name} withSelfie={withSelfie} />
      <div className="flex flex-1 flex-col gap-4 p-4">
        {stage.name === "locating" || mode === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
            <span
              aria-hidden
              className="size-[72px] animate-spin rounded-full border-4 border-line border-t-foreground"
            />
            <h1 className="m-0 font-display text-[25px] font-bold">{copy.locating}</h1>
            <p className="m-0 text-base text-fg-muted">{copy.locatingHint}</p>
          </div>
        ) : null}

        {stage.name === "located" && mode !== null && !fix ? (
          <div className="flex flex-1 flex-col gap-4">
            <h1 className="m-0 font-display text-[31px] leading-[1.15] font-bold">
              {copy.locationFailedTitle}
            </h1>
            <p className="m-0 text-base">
              {stage.failure === "denied" ? copy.locationDenied : copy.locationTimeout}
            </p>
            <div className="mt-auto flex flex-col gap-2.5">
              <Button
                type="button"
                onClick={() => void findLocation()}
                className="h-[60px] w-full rounded-xl font-display text-xl font-bold"
              >
                {copy.tryAgain}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={next}
                className="h-[52px] w-full rounded-xl border-foreground text-base font-semibold"
              >
                {copy.sendWithoutLocation}
              </Button>
            </div>
          </div>
        ) : null}

        {stage.name === "located" && mode !== null && fix && (!site || !preview || preview.result === "unknown") ? (
          <div className="flex flex-1 flex-col gap-4">
            <h1 className="m-0 font-display text-[31px] leading-[1.15] font-bold">{copy.noSiteTitle}</h1>
            <p className="m-0 text-base">{site ? copy.noGeofenceLine(site.name) : copy.noSiteLine}</p>
            <div className="mt-auto flex flex-col gap-2.5">
              <Button
                type="button"
                disabled={busy}
                onClick={next}
                className="h-[60px] w-full rounded-xl font-display text-xl font-bold"
              >
                {busy ? copy.saving : proceedLabel}
              </Button>
            </div>
          </div>
        ) : null}

        {stage.name === "located" && mode !== null && fix && site && preview?.result === "inside" ? (
          <div className="flex flex-1 flex-col gap-4">
            <InsideMap preview={preview} site={site} />
            <h1 className="m-0 font-display text-[31px] leading-[1.15] font-bold">
              {copy.distance(formatDistance(preview.distanceM ?? 0))}
            </h1>
            <p className="m-0 text-base">
              {copy.insideLine(
                site.name,
                withSelfie ? copy.nextSelfie : kind === "in" ? copy.nextIn : copy.nextOut,
              )}
            </p>
            <div className="mt-auto flex flex-col gap-2.5">
              <Button
                type="button"
                disabled={busy}
                onClick={next}
                className="h-[60px] w-full rounded-xl font-display text-xl font-bold"
              >
                {busy ? copy.saving : proceedLabel}
              </Button>
            </div>
          </div>
        ) : null}

        {stage.name === "located" && mode !== null && fix && site && away ? (
          <div className="flex flex-1 flex-col gap-3.5">
            <h1 className="m-0 font-display text-[31px] leading-[1.15] font-bold">
              {copy.distance(formatDistance(preview?.distanceM ?? 0))}
            </h1>
            <p className="m-0 text-base">{kind === "in" ? copy.outsideLine : copy.outsideLineOut}</p>
            <div role="group" aria-label={copy.reasonGroup} className="flex flex-col gap-2">
              {OUTSIDE_REASONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={reason === value}
                  onClick={() => setReason(value)}
                  className={cn(
                    "h-11 rounded-lg border border-line bg-background px-3.5 text-left text-[15px] font-medium text-foreground",
                    reason === value && "border-[1.5px] border-signal font-semibold",
                  )}
                >
                  {OUTSIDE_REASON_LABELS[value]}
                </button>
              ))}
            </div>
            {reason === "other" ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {copy.noteLabel}
                <textarea
                  value={note}
                  maxLength={NOTE_MAX}
                  rows={2}
                  onChange={(event) => setNote(event.target.value)}
                  aria-invalid={noteError ? true : undefined}
                  className="rounded-lg border border-line bg-background px-3 py-2 text-base font-normal"
                />
                {noteError ? (
                  <span role="alert" className="text-sm font-normal">
                    {noteError}
                  </span>
                ) : null}
              </label>
            ) : null}
            <div className="mt-auto flex flex-col gap-2.5">
              <Button
                type="button"
                disabled={busy || reason === null || noteError !== null}
                onClick={next}
                className="h-[60px] w-full rounded-xl font-display text-xl font-bold"
              >
                {busy ? copy.saving : copy.sendAnyway}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void findLocation()}
                className="h-[52px] w-full rounded-xl border-foreground text-base font-semibold"
              >
                {copy.checkAgain}
              </Button>
            </div>
          </div>
        ) : null}

        {stage.name === "selfie" ? (
          <SelfieCamera busy={busy} onPhoto={(photo) => void save(photo)} onSkip={() => void save(null)} />
        ) : null}

        {stage.name === "done" ? <DoneScreen stage={stage} /> : null}

        {failed ? (
          <p role="alert" className="m-0 text-[15px]">
            {failed}
          </p>
        ) : null}
      </div>
    </>
  );
}

/** "Clock in" or "Clock out" in the top bar, from the same state the flow uses. */
export function ClockTitle({ lastPunch }: { lastPunch: ServerLastPunch | null }) {
  const state = useClockState(lastPunch);
  return (
    <span className="font-display text-xl font-bold" data-testid="clock-title">
      {state.ready ? (state.clockedIn ? copy.titleOut : copy.titleIn) : copy.titleIn}
    </span>
  );
}
