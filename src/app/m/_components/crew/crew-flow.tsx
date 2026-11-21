"use client";

import { liveQuery } from "dexie";
import { ArrowDownToLine, Camera, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { BackLink, type BackTarget } from "@/components/back-link";
import { ThemeButton } from "@/components/theme/theme-button";
import { queueEvent } from "@/lib/offline/active-queue";
import type { QueueStatus } from "@/lib/offline/types";
import { workerMessages } from "@/lib/messages/worker";
import { formatDistance, previewSite } from "@/lib/punches/clock";
import {
  canMark,
  crewEntries,
  crewState,
  photoBlockers,
  toggleAll,
  unmarkedNames,
  type CrewMember,
  type CrewMode,
  type CrewPayload,
} from "@/lib/punches/crew";
import { compressSelfieFile } from "@/lib/punches/photo";
import { timeIn } from "@/lib/roster";
import { cn } from "@/lib/utils";
import type { CrewSite } from "@/server/workforce/crew-data";

import { useActiveQueue, useOnline } from "../offline/hooks";

const copy = workerMessages.crew;
const clockCopy = workerMessages.clock;
const LAGOS = "Africa/Lagos";

const hours = (start: string, end: string) => `${timeIn(start, LAGOS)}–${timeIn(end, LAGOS)}`;

interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
}

interface Done {
  id: string;
  at: number;
  mode: CrewMode;
  count: number;
  photo: boolean;
  distance: string | null;
  unmarked: string[];
}

/** The supervisor's own position, once, for the distance line. Null when refused or slow. */
function useFix(enabled: boolean): Fix | null {
  const [fix, setFix] = useState<Fix | null>(null);
  useEffect(() => {
    if (!enabled || !("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setFix({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: Math.max(0, Math.round(position.coords.accuracy)),
        }),
      () => setFix(null),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 },
    );
  }, [enabled]);
  return fix;
}

/** Watches one queued item: gone means the server has it. */
function useItemStatus(id: string): QueueStatus | "gone" | "loading" {
  const queue = useActiveQueue();
  const [status, setStatus] = useState<QueueStatus | "gone" | "loading">("loading");
  useEffect(() => {
    if (!queue) return;
    const subscription = liveQuery(() => queue.db.punchQueue.get(id)).subscribe({
      next: (item) => setStatus(item?.status ?? "gone"),
      error: () => setStatus("loading"),
    });
    return () => subscription.unsubscribe();
  }, [queue, id]);
  return status;
}

function DoneScreen({ done, onBack }: { done: Done; onBack: () => void }) {
  const online = useOnline();
  const status = useItemStatus(done.id);
  const time = timeIn(new Date(done.at).toISOString(), LAGOS);
  let line: string;
  if (status === "gone") line = clockCopy.sent;
  else if (status === "failed_permanent") line = clockCopy.refused;
  else if (!online || status === "loading") line = clockCopy.savedOffline;
  else line = clockCopy.sending;
  return (
    <div className="flex flex-1 flex-col justify-center gap-4 p-6" data-testid="crew-done">
      <span className="flex size-16 items-center justify-center rounded-full bg-foreground text-background">
        <Check strokeWidth={2} className="size-8" aria-hidden />
      </span>
      <h1 className="m-0 font-display text-[31px] leading-[1.15] font-bold">
        {done.mode === "in" ? copy.doneIn(done.count, time) : copy.doneOut(done.count, time)}
      </h1>
      <p
        role="status"
        data-testid="crew-send-status"
        data-status={status}
        className="m-0 flex items-center gap-2 text-base"
      >
        <ArrowDownToLine strokeWidth={1.75} className="size-5 shrink-0" aria-hidden />
        {line}
      </p>
      <ul className="m-0 flex flex-col gap-1 pl-5 text-[15px] leading-relaxed text-fg-muted">
        <li>{copy.bySupervisor}</li>
        <li>{done.distance ? copy.yourLocation(done.distance) : copy.noLocation}</li>
        {done.mode === "in" ? (
          <li data-testid="crew-photo-note">{done.photo ? copy.photoAttached : copy.noPhoto}</li>
        ) : null}
        <li>{done.unmarked.length ? copy.notMarked(done.unmarked.join(", ")) : copy.wholeCrew}</li>
      </ul>
      <button
        type="button"
        onClick={onBack}
        className="mt-2 flex h-[52px] items-center justify-center rounded-xl border border-foreground bg-background text-base font-semibold text-foreground hover:bg-surface"
      >
        {copy.back}
      </button>
    </div>
  );
}

function memberNote(member: CrewMember, now: number): string {
  const state = crewState(member, now);
  if (state === "present" && member.lastAt) return copy.clockedInAt(timeIn(member.lastAt, LAGOS));
  if (state === "out" && member.lastAt) return copy.clockedOutAt(timeIn(member.lastAt, LAGOS));
  const parts = [copy.shiftHours(hours(member.startsAt, member.endsAt))];
  if (member.noPhone) parts.push(copy.noPhone);
  return parts.join(" · ");
}

/**
 * The crew checklist (SupCrew board): the crew on shift at the site, Select all, tick the people
 * here, an optional group photo on a clock-in, then "Mark N present" (or clocked out). The batch
 * is saved on the phone first and sent by the offline queue; the server decides who may be
 * marked, the time and the flags.
 */
export function CrewFlow({
  back,
  locationConsent,
  sites,
}: {
  back: BackTarget;
  locationConsent: boolean;
  sites: CrewSite[];
}) {
  const router = useRouter();
  const queue = useActiveQueue();
  const fix = useFix(locationConsent);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [mode, setMode] = useState<CrewMode>("in");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  // Marked on this phone since the page loaded, so they can't be sent twice before a refresh.
  const [sentHere, setSentHere] = useState<Record<string, { kind: CrewMode; at: string }>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const site = sites.find((s) => s.id === siteId) ?? sites[0]!;
  const crew = useMemo(
    () =>
      site.crew.map((m) => {
        const local = sentHere[m.workerId];
        return local ? { ...m, lastKind: local.kind, lastAt: local.at } : m;
      }),
    [site, sentHere],
  );
  const markable = crew.filter((m) => canMark(m, mode, now));
  const count = markable.filter((m) => selected.has(m.workerId)).length;
  const blockers = mode === "in" ? photoBlockers(crew, selected) : [];
  const preview = fix ? previewSite(site, { lat: fix.lat, lng: fix.lng }, fix.accuracy) : null;
  const distance = preview?.distanceM != null ? formatDistance(preview.distanceM) : null;
  const allOn = markable.length > 0 && markable.every((m) => selected.has(m.workerId));

  function switchMode(next: CrewMode) {
    setMode(next);
    setSelected(new Set());
    setPhoto(null);
    setProblem(null);
  }

  function toggle(workerId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const small = await compressSelfieFile(file);
    if (!small) {
      setProblem(copy.photoFailed);
      return;
    }
    setProblem(null);
    setPhoto(small);
  }

  async function submit() {
    if (!queue) {
      setProblem(clockCopy.noQueue);
      return;
    }
    const ids = markable.filter((m) => selected.has(m.workerId)).map((m) => m.workerId);
    if (ids.length === 0) return;
    const withPhoto = mode === "in" && photo !== null && blockers.length === 0;
    const payload: CrewPayload = {
      site_id: site.id,
      entries: crewEntries(ids, () => crypto.randomUUID()),
      latitude: fix?.lat ?? null,
      longitude: fix?.lng ?? null,
      accuracy_m: fix?.accuracy ?? null,
      has_photo: withPhoto,
    };
    setBusy(true);
    setProblem(null);
    try {
      const item = await queueEvent({
        kind: mode === "in" ? "crew_in" : "crew_out",
        payload,
        ...(withPhoto && photo ? { photo } : {}),
      });
      const at = new Date(item.device_time).toISOString();
      setSentHere((current) => {
        const next = { ...current };
        for (const id of ids) next[id] = { kind: mode, at };
        return next;
      });
      setDone({
        id: item.client_event_id,
        at: item.device_time,
        mode,
        count: ids.length,
        photo: withPhoto,
        distance,
        unmarked: unmarkedNames(crew, selected, mode, now),
      });
    } catch {
      setProblem(clockCopy.failed);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <DoneScreen
        done={done}
        onBack={() => {
          setDone(null);
          setSelected(new Set());
          setPhoto(null);
          router.refresh();
        }}
      />
    );
  }

  const subtitle = site.shift
    ? copy.subtitle(site.shift.postName, hours(site.shift.startsAt, site.shift.endsAt), site.name)
    : site.name;

  return (
    <div className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        {/* WorkerTopBar's row, without its server-rendered inbox button. */}
        <div className="flex min-h-11 items-center gap-2">
          <BackLink {...back} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="m-0 font-display text-xl font-bold" data-testid="crew-title">
              {mode === "in" ? copy.titleIn : copy.titleOut}
            </h1>
            <span className="truncate text-[13px] text-fg-muted">{subtitle}</span>
          </div>
          <span className="-mr-2 flex shrink-0 items-center">
            <ThemeButton />
          </span>
        </div>
      </div>

      {sites.length > 1 ? (
        <label className="flex flex-col gap-1 px-4 pt-2 text-[13px] text-fg-muted">
          {copy.sitePicker}
          <select
            value={site.id}
            onChange={(e) => {
              setSiteId(e.target.value);
              setSelected(new Set());
              setPhoto(null);
            }}
            className="h-11 rounded-xl border border-line bg-background px-3 text-base text-foreground"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div role="tablist" aria-label={copy.modes} className="grid grid-cols-2 gap-2 px-4 pt-3">
        {(["in", "out"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => switchMode(m)}
            className={cn(
              "h-11 rounded-xl border text-[15px] font-semibold",
              mode === m
                ? "border-foreground bg-foreground text-background"
                : "border-line bg-background text-foreground hover:bg-surface",
            )}
          >
            {m === "in" ? copy.modeIn : copy.modeOut}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between px-4 pt-2 pb-2">
        <span className="text-[15px] font-semibold" data-testid="crew-count">
          {mode === "in"
            ? copy.presentCount(count, markable.length)
            : copy.outCount(count, markable.length)}
        </span>
        <button
          type="button"
          disabled={markable.length === 0}
          onClick={() => setSelected(toggleAll(crew, selected, mode, now))}
          className="h-11 px-1 text-[15px] font-semibold text-action disabled:text-fg-muted"
        >
          {allOn ? copy.clearAll : copy.selectAll}
        </button>
      </div>

      {crew.length === 0 ? (
        <p className="m-0 px-4 pt-2 text-base">{copy.empty}</p>
      ) : (
        <ul className="m-0 flex-1 list-none border-t border-line p-0" data-testid="crew-list">
          {crew.map((m) => {
            const can = canMark(m, mode, now);
            const name = `${m.firstName} ${m.lastName}`;
            return (
              <li key={m.workerId} className="border-b border-line">
                <label
                  className={cn(
                    "flex min-h-14 items-center gap-3 px-4 py-2",
                    can ? "cursor-pointer" : "opacity-60",
                  )}
                >
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-[13px] font-semibold"
                  >
                    {`${m.firstName[0] ?? ""}${m.lastName[0] ?? ""}`}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base font-medium">{name}</span>
                    <span className="truncate text-xs text-fg-muted">{memberNote(m, now)}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="size-6 shrink-0 accent-foreground"
                    aria-label={mode === "in" ? copy.markPresent(name) : copy.markOut(name)}
                    disabled={!can}
                    checked={can && selected.has(m.workerId)}
                    onChange={() => toggle(m.workerId)}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sticky bottom-0 flex flex-col gap-2.5 border-t border-line bg-background px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {distance ? (
          <p className="m-0 text-[13px] text-fg-muted">{copy.yourLocation(distance)}</p>
        ) : null}
        {mode === "in" ? (
          blockers.length > 0 ? (
            <p className="m-0 text-[13px] text-fg-muted" data-testid="crew-photo-blocked">
              {copy.photoNoConsent(blockers.length)}
            </p>
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                data-testid="crew-photo-input"
                onChange={(e) => void onFile(e)}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={cn(
                  "flex h-12 items-center justify-center gap-2 rounded-xl border bg-background text-[15px] font-semibold text-foreground hover:bg-surface",
                  photo ? "border-foreground" : "border-line",
                )}
              >
                <Camera strokeWidth={1.75} className="size-5" aria-hidden />
                {photo ? copy.retakePhoto : copy.takePhoto}
              </button>
            </>
          )
        ) : null}
        {problem ? (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {problem}
          </p>
        ) : null}
        <button
          type="button"
          disabled={count === 0 || busy}
          onClick={() => void submit()}
          className="h-14 rounded-xl bg-foreground font-display text-lg font-bold text-background disabled:opacity-40"
        >
          {mode === "in" ? copy.submitIn(count) : copy.submitOut(count)}
        </button>
      </div>
    </div>
  );
}
