"use client";

import { useRouter } from "next/navigation";
import { useActionState, useMemo, useRef, useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { FormAlert, SelectField } from "@/components/form";
import { Illustration } from "@/components/illustration";
import { Status, type StatusTone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { formatHoursTotal, formatShortDay, timeIn } from "@/lib/roster";
import {
  CLEAN_REFUSAL_TEXT,
  DECISION_TEXT,
  LINE_STATUS_TEXT,
  cleanLineIds,
  deviceVsServer,
  distanceText,
  exceptionLabels,
  headlineFlag,
  methodText,
  reviewReasons,
  workUnitText,
} from "@/lib/timesheets/approval";
import { formatMinutes } from "@/lib/timesheets/minutes";
import { cn } from "@/lib/utils";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { punchSelfieLinkAction } from "@/server/workforce/punch-actions";
import { addTimesheetCorrectionAction } from "@/server/workforce/timesheet-actions";
import {
  approveCleanTimesheetLinesAction,
  approveTimesheetLineAction,
  rejectTimesheetLineAction,
  reopenTimesheetLineAction,
  type CleanActionState,
} from "@/server/workforce/timesheet-approval-actions";
import type {
  ReviewDay,
  ReviewPunch,
  TimesheetReview,
} from "@/server/workforce/timesheet-review-data";

/**
 * The timesheet board (slice 4.3, prototype Timesheets.dc.html): the period picker and "Approve
 * N clean" in the header, "N timesheets to decide", the list (disputed, then needs review with
 * why, then flagged, then clean, then decided) and the detail panel (clock in and out, distance,
 * device against server time, method, the selfie by a 60-second link, the Work Unit it makes)
 * with Approve, Adjust hours, Reject and Reopen. Times in the company's zone. No money: pay is
 * Phase 5, billing Phase 6.
 */

type Panel = "none" | "adjust" | "reject" | "reopen";

const STATUS_TONE: Record<ReviewDay["status"], StatusTone> = {
  pending: "action",
  disputed: "action",
  approved: "done",
  rejected: "pending",
};

function where(day: ReviewDay): string {
  if (!day.hasShift) return `${day.siteName ?? "No site"} · no shift`;
  return [day.siteName, day.postName].filter(Boolean).join(" · ");
}

function hours(day: ReviewDay): string {
  return formatHoursTotal(day.workedMinutes + day.otMinutes);
}

function reviewPunch(p: ReviewPunch | null) {
  return p
    ? {
        recordedAt: Date.parse(p.recordedAt),
        deviceTime: Date.parse(p.deviceTime),
        receivedAt: Date.parse(p.receivedAt),
        timeSource: p.timeSource,
      }
    : null;
}

/** The sentence under the flag in the detail panel. */
function why(day: ReviewDay): string {
  const parts: string[] = [];
  if (day.status === "disputed" && day.lastDecisionReason) {
    parts.push(`The worker says: "${day.lastDecisionReason}".`);
  }
  if (day.exceptions.includes("late_punch_after_decision")) {
    parts.push("A punch arrived after this day was decided. Reopen it to count the punch.");
  }
  if (day.exceptions.includes("no_clock_out")) {
    parts.push("No clock-out, so the day counts no hours until you set one with Adjust hours.");
  }
  if (day.exceptions.includes("no_show")) parts.push("No clock-in for this shift.");
  parts.push(
    ...reviewReasons(day.exceptions, [reviewPunch(day.inPunch), reviewPunch(day.outPunch)]),
  );
  if (day.lastCorrectionReason) parts.push(`Last correction: "${day.lastCorrectionReason}".`);
  if (day.status === "rejected" && day.lastDecisionReason) {
    parts.push(`Rejected: "${day.lastDecisionReason}".`);
  }
  if (parts.length === 0) {
    return day.exceptions.length === 0
      ? "Matches the roster with nothing to check."
      : exceptionLabels(day.exceptions).join(" · ");
  }
  return parts.join(" ");
}

function punchLine(p: ReviewPunch | null, zone: string): string {
  if (!p) return "None";
  const parts = [timeIn(p.recordedAt, zone)];
  if (p.source === "supervisor") parts.push("by supervisor");
  else if (p.hasSelfie) parts.push("selfie taken");
  if (p.timeSource === "device") parts.push("phone time");
  return parts.join(" · ");
}

export function TimesheetBoard({
  review,
  periods,
  canCorrect,
  canReopen,
  canSeeSelfie,
}: {
  review: TimesheetReview;
  periods: string[];
  canCorrect: boolean;
  canReopen: boolean;
  canSeeSelfie: boolean;
}) {
  const router = useRouter();
  const zone = review.timeZone;
  const days = review.days;
  const toDecide = days.filter(
    (d) => (d.status === "pending" || d.status === "disputed") && d.canDecide,
  ).length;
  const openForAll = days.filter((d) => d.status === "pending" || d.status === "disputed").length;
  const cleanIds = useMemo(() => cleanLineIds(days), [days]);
  const [selectedId, setSelectedId] = useState<string | null>(days[0]?.id ?? null);
  const selected = days.find((d) => d.id === selectedId) ?? days[0] ?? null;
  const detailRef = useRef<HTMLElement>(null);

  const pick = (id: string) => {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start" }));
    }
  };

  const open = canCorrect ? toDecide : openForAll;
  const headline =
    days.length === 0
      ? "No timesheet days yet"
      : open === 0
        ? "All timesheets decided"
        : `${open} ${open === 1 ? "timesheet" : "timesheets"} to decide`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3" data-testid="timesheets-toolbar">
        <span className="type-label text-fg-muted" data-testid="timesheets-period">
          Period {formatDate(review.period.start)} – {formatDate(review.period.end)}
        </span>
        <span className="hidden flex-1 sm:block" />
        <label className="flex max-w-full min-w-0">
          <span className="sr-only">Pay period</span>
          <select
            value={review.period.start}
            onChange={(e) => router.push(`/app/timesheets?period=${e.target.value}`)}
            className="h-10 max-w-full min-w-0 rounded-lg border border-line bg-background px-3 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            {(periods.includes(review.period.start)
              ? periods
              : [review.period.start, ...periods]
            ).map((start) => (
              <option key={start} value={start}>
                From {formatDate(start)}
              </option>
            ))}
          </select>
        </label>
        {canCorrect ? <ApproveClean lineIds={cleanIds} /> : null}
      </header>

      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 type-h1" data-testid="timesheets-headline">
          {headline}
        </h1>
        <p className="m-0 max-w-3xl type-body-lg text-fg-muted">
          Clean days match the roster with nothing to check. Flagged days need a decision. Approved
          days on a post become Work Units for billing; pay follows in payroll.
          {review.refreshed ? "" : " Couldn't bring the latest punches in; showing what was saved."}
        </p>
      </div>

      {days.length === 0 ? (
        <EmptyState message="No one has worked a shift in this period yet. Days appear here once shifts start." />
      ) : (canCorrect ? toDecide : openForAll) === 0 &&
        days.every((d) => d.status !== "pending") ? (
        <EmptyState
          illustration={<Illustration name="all-covered" size="empty" decorative />}
          message={`Every day in this period is decided: ${days.filter((d) => d.status === "approved").length} approved.`}
        />
      ) : null}

      {days.length > 0 ? (
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          <section
            aria-label="Timesheet days"
            className="min-w-0 overflow-hidden rounded-xl border border-line"
          >
            <ul className="m-0 list-none p-0" data-testid="timesheet-list">
              {days.map((day) => {
                const on = selected?.id === day.id;
                const flag = headlineFlag(day.exceptions);
                return (
                  <li key={day.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => pick(day.id)}
                      data-testid="timesheet-row"
                      data-status={day.status}
                      className={cn(
                        "flex w-full min-w-0 gap-4 border-0 border-b border-line p-4 text-left text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
                        on
                          ? "bg-surface shadow-[inset_0_0_0_1.5px_var(--signal)]"
                          : "bg-background hover:bg-surface",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate font-semibold">{day.workerName}</span>
                        <span className="text-[13px] break-words text-fg-muted">
                          {where(day)} · {formatShortDay(day.workDate)}
                        </span>
                        {day.needsReview ? (
                          <span className="text-[13px] font-medium" data-testid="review-why">
                            {reviewReasons(day.exceptions, [
                              reviewPunch(day.inPunch),
                              reviewPunch(day.outPunch),
                            ]).join(" · ")}
                          </span>
                        ) : null}
                        {flag ? (
                          <span className="flex flex-wrap gap-1.5">
                            <span className="inline-flex h-6 items-center rounded border border-foreground px-2 text-xs font-medium whitespace-nowrap">
                              {flag}
                            </span>
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="font-display text-lg font-bold tabular-nums">
                          {hours(day)}
                        </span>
                        <Status tone={STATUS_TONE[day.status]}>
                          {day.status === "pending" && day.clean
                            ? "Clean"
                            : LINE_STATUS_TEXT[day.status]}
                        </Status>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {selected ? (
            <section
              ref={detailRef}
              aria-label="Day detail"
              className="flex min-w-0 scroll-mt-4 flex-col gap-4 self-start rounded-xl border border-line p-4 sm:p-5"
              data-testid="timesheet-detail"
            >
              <Detail
                key={selected.id}
                day={selected}
                zone={zone}
                canCorrect={canCorrect}
                canReopen={canReopen}
                canSeeSelfie={canSeeSelfie}
              />
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Detail({
  day,
  zone,
  canCorrect,
  canReopen,
  canSeeSelfie,
}: {
  day: ReviewDay;
  zone: string;
  canCorrect: boolean;
  canReopen: boolean;
  canSeeSelfie: boolean;
}) {
  const [panel, setPanel] = useState<Panel>("none");
  const [approveState, approve] = useActionState<CompanyFormState, FormData>(
    approveTimesheetLineAction,
    null,
  );
  const open = day.status === "pending" || day.status === "disputed";
  const flag = headlineFlag(day.exceptions);
  const decide = open && day.canDecide && canCorrect;
  const reopen = canReopen && day.canReopen;
  const shift =
    day.startsAt && day.endsAt
      ? `${timeIn(day.startsAt, zone)}–${timeIn(day.endsAt, zone)}`
      : "No shift";

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="type-label text-fg-muted" data-testid="detail-work-unit">
          {workUnitText(day)}
        </span>
        <h2 className="m-0 type-h2 break-words">{day.workerName}</h2>
        <span className="text-sm break-words text-fg-muted">
          {where(day)} · {formatShortDay(day.workDate)} · {shift}
        </span>
      </div>
      <p className="m-0 text-[15px]" data-testid="detail-why">
        {flag ? <b>{flag}. </b> : null}
        {why(day)}
      </p>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-muted">Worked</dt>
        <dd className="m-0 tabular-nums" data-testid="detail-minutes">
          {formatMinutes(day.workedMinutes)}
          {day.otMinutes > 0 ? ` + ${formatMinutes(day.otMinutes)} overtime` : ""}
          {day.lateMinutes > 0 ? ` · ${day.lateMinutes} min late` : ""}
          {day.earlyMinutes > 0 ? ` · left ${day.earlyMinutes} min early` : ""}
        </dd>
        <dt className="text-fg-muted">Clock in</dt>
        <dd className="m-0 tabular-nums">{punchLine(day.inPunch, zone)}</dd>
        <dt className="text-fg-muted">Clock out</dt>
        <dd className="m-0 tabular-nums">{punchLine(day.outPunch, zone)}</dd>
        <dt className="text-fg-muted">Distance</dt>
        <dd className="m-0">
          {day.inPunch ? distanceText(day.inPunch.distanceM, day.inPunch.geofence) : "None"}
          {day.outPunch
            ? ` at clock-in; ${distanceText(day.outPunch.distanceM, day.outPunch.geofence)} at clock-out`
            : ""}
        </dd>
        <dt className="text-fg-muted">Device vs server time</dt>
        <dd className="m-0">{deviceVsServer(day.inPunch?.driftSeconds ?? null)}</dd>
        <dt className="text-fg-muted">Method</dt>
        <dd className="m-0">{methodText(day.inPunch?.source ?? null)}</dd>
        <dt className="text-fg-muted">Status</dt>
        <dd className="m-0">
          <Status tone={STATUS_TONE[day.status]}>{LINE_STATUS_TEXT[day.status]}</Status>
          {day.lastDecision && !open ? (
            <span className="block text-[13px] text-fg-muted">
              {DECISION_TEXT[day.lastDecision]}
            </span>
          ) : null}
        </dd>
      </dl>
      {canSeeSelfie && day.inPunch?.hasSelfie ? <SelfieButton punchId={day.inPunch.id} /> : null}

      {decide ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <form action={approve}>
              <input type="hidden" name="lineId" value={day.id} />
              <Button
                type="submit"
                className="h-11 rounded-lg"
                disabled={day.running}
                data-testid="approve-day"
              >
                Approve
              </Button>
            </form>
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-lg"
              aria-expanded={panel === "adjust"}
              onClick={() => setPanel(panel === "adjust" ? "none" : "adjust")}
            >
              Adjust hours
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-lg"
              aria-expanded={panel === "reject"}
              onClick={() => setPanel(panel === "reject" ? "none" : "reject")}
            >
              Reject
            </Button>
          </div>
          {day.running ? (
            <p className="m-0 text-[13px] text-fg-muted">
              This shift hasn&apos;t finished. Approve it once it ends.
            </p>
          ) : null}
          <ResultLine state={approveState} />
          {panel === "adjust" ? <AdjustForm day={day} zone={zone} /> : null}
          {panel === "reject" ? (
            <ReasonForm
              action={rejectTimesheetLineAction}
              lineId={day.id}
              label="Why is this day rejected?"
              submit="Reject day"
              note="The worker is told by inbox and email."
            />
          ) : null}
          <p className="m-0 text-[13px] text-fg-muted">
            Adjusting adds a correction with your reason. The original punches stay on record.
          </p>
        </div>
      ) : open && !day.canDecide ? (
        <p className="m-0 text-[13px] text-fg-muted">
          {canCorrect
            ? "You can't decide this day: it is your own, or the person doesn't report to you."
            : "You can read timesheets but not decide them."}
        </p>
      ) : null}

      {reopen ? (
        <div className="flex flex-col gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11 self-start rounded-lg border-foreground"
            aria-expanded={panel === "reopen"}
            onClick={() => setPanel(panel === "reopen" ? "none" : "reopen")}
            data-testid="reopen-day"
          >
            Reopen
          </Button>
          {panel === "reopen" ? (
            <ReasonForm
              action={reopenTimesheetLineAction}
              lineId={day.id}
              label="Why reopen this day?"
              submit="Reopen day"
              note={
                day.workUnitId
                  ? "Its Work Unit is cancelled; approving again makes a new one."
                  : "The day goes back to Needs decision."
              }
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ResultLine({ state }: { state: CompanyFormState }) {
  if (!state) return null;
  if (!state.ok) return <FormAlert message={state.formError} />;
  return (
    <p className="m-0 text-sm font-medium" role="status" data-testid="decision-result">
      {state.message}
    </p>
  );
}

function ReasonForm({
  action: run,
  lineId,
  label,
  submit,
  note,
}: {
  action: (prev: CompanyFormState, formData: FormData) => Promise<CompanyFormState>;
  lineId: string;
  label: string;
  submit: string;
  note: string;
}) {
  const [state, action, pending] = useActionState<CompanyFormState, FormData>(run, null);
  return (
    <form action={action} className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <input type="hidden" name="lineId" value={lineId} />
      <label className="flex flex-col gap-1.5 text-[13px] font-medium">
        {label}
        <textarea
          name="reason"
          required
          maxLength={500}
          rows={3}
          defaultValue={state?.values?.reason ?? ""}
          className="rounded-lg border border-line bg-background px-3 py-2 text-[15px] font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
      </label>
      <p className="m-0 text-[13px] text-fg-muted">{note}</p>
      <ResultLine state={state} />
      <Button type="submit" className="h-11 rounded-lg" disabled={pending}>
        {pending ? "Saving…" : submit}
      </Button>
    </form>
  );
}

/** "+01:00" for the zone on that day, so a typed local time means the company's clock. */
function zoneOffset(zone: string, local: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${local}:00Z`))
      .find((p) => p.type === "timeZoneName")?.value;
    const match = /GMT([+-]\d{2}:\d{2})/.exec(name ?? "");
    return match?.[1] ?? "+01:00";
  } catch {
    return "+01:00";
  }
}

const KIND_OPTIONS = [
  { value: "set_clock_out", label: "Set the clock-out time" },
  { value: "set_clock_in", label: "Set the clock-in time" },
  { value: "set_minutes", label: "Set the minutes worked" },
  { value: "void_punch", label: "Set a punch aside" },
] as const;

function AdjustForm({ day, zone }: { day: ReviewDay; zone: string }) {
  const [state, action, pending] = useActionState<CompanyFormState, FormData>(
    addTimesheetCorrectionAction,
    null,
  );
  const [kind, setKind] = useState<string>(
    day.exceptions.includes("no_clock_out") ? "set_clock_out" : "set_minutes",
  );
  const [local, setLocal] = useState("");
  // The preview a change in the form makes stale (the next answer clears it).
  const [staleFor, setStaleFor] = useState<CompanyFormState>(null);
  const dirty = staleFor !== null && staleFor === state;
  const ready = !dirty && state?.ok === true && state.values?.confirm === "ready";
  const saved = state?.ok === true && !state.values;
  const punches = [
    day.inPunch
      ? { value: day.inPunch.id, label: `Clock-in at ${timeIn(day.inPunch.recordedAt, zone)}` }
      : null,
    day.outPunch
      ? { value: day.outPunch.id, label: `Clock-out at ${timeIn(day.outPunch.recordedAt, zone)}` }
      : null,
  ].filter((p): p is { value: string; label: string } => p !== null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form
      action={action}
      onChange={() => setStaleFor(state)}
      className="flex flex-col gap-3 rounded-xl border border-line p-3"
      aria-label="Adjust hours"
    >
      <input type="hidden" name="lineId" value={day.id} />
      <input type="hidden" name="confirm" value={ready ? "1" : ""} />
      <SelectField
        label="What to correct"
        name="kind"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        options={KIND_OPTIONS}
        error={errors?.kind}
      />
      {kind === "set_clock_in" || kind === "set_clock_out" ? (
        <label className="flex flex-col gap-1.5 text-[13px] font-medium">
          Time on the company&apos;s clock
          <input
            type="datetime-local"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            className="h-11 rounded-lg border border-line bg-background px-3 text-[15px] font-normal"
            required
          />
          <input
            type="hidden"
            name="correctedAt"
            value={local ? `${local}:00${zoneOffset(zone, local)}` : ""}
          />
          {errors?.correctedAt ? <span className="text-xs">{errors.correctedAt}</span> : null}
        </label>
      ) : null}
      {kind === "set_minutes" ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            Minutes worked
            <input
              name="minutes"
              type="number"
              min={0}
              max={1440}
              required
              defaultValue={state?.values?.minutes ?? String(day.workedMinutes)}
              className="h-11 rounded-lg border border-line bg-background px-3 text-[15px] font-normal tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            Overtime minutes
            <input
              name="otMinutes"
              type="number"
              min={0}
              max={1440}
              defaultValue={state?.values?.otMinutes ?? String(day.otMinutes)}
              className="h-11 rounded-lg border border-line bg-background px-3 text-[15px] font-normal tabular-nums"
            />
          </label>
        </div>
      ) : null}
      {kind === "void_punch" ? (
        <SelectField
          label="Punch to set aside"
          name="punchId"
          defaultValue={state?.values?.punchId ?? ""}
          options={punches}
          placeholder={punches.length === 0 ? "No punches on this day" : "Choose a punch"}
          error={errors?.punchId}
        />
      ) : null}
      <label className="flex flex-col gap-1.5 text-[13px] font-medium">
        Reason
        <textarea
          name="reason"
          required
          maxLength={500}
          rows={2}
          defaultValue={state?.values?.reason ?? ""}
          className="rounded-lg border border-line bg-background px-3 py-2 text-[15px] font-normal"
        />
      </label>
      {state && !state.ok ? <FormAlert message={state.formError} /> : null}
      {ready ? (
        <p className="m-0 rounded-lg bg-surface px-3 py-2 text-sm" data-testid="correction-preview">
          {state.message}
        </p>
      ) : null}
      {saved ? (
        <p className="m-0 text-sm font-medium" role="status" data-testid="correction-saved">
          {state.message}
        </p>
      ) : null}
      <Button type="submit" className="h-11 rounded-lg" disabled={pending}>
        {pending ? "Checking…" : ready ? "Save correction" : "Check the new hours"}
      </Button>
    </form>
  );
}

function SelfieButton({ punchId }: { punchId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        className="h-10 self-start rounded-lg"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await punchSelfieLinkAction({ punchId });
            if (result.ok) {
              window.open(result.url, "_blank", "noopener,noreferrer");
              setMessage(null);
            } else {
              setMessage(
                result.reason === "deleted"
                  ? "The selfie was deleted after 90 days."
                  : "The selfie can't be opened.",
              );
            }
          })
        }
      >
        Open the clock-in selfie
      </Button>
      {message ? <p className="m-0 text-[13px] text-fg-muted">{message}</p> : null}
    </div>
  );
}

function ApproveClean({ lineIds }: { lineIds: string[] }) {
  const [state, action, pending] = useActionState<CleanActionState, FormData>(
    approveCleanTimesheetLinesAction,
    null,
  );
  // The answer the person dismissed (a new answer shows again).
  const [closedFor, setClosedFor] = useState<CleanActionState>(null);
  const closed = closedFor !== null && closedFor === state;
  const preview = !closed ? state?.preview : undefined;
  const n = lineIds.length;
  return (
    <>
      <form action={action}>
        <input type="hidden" name="lineIds" value={lineIds.join(",")} />
        <input type="hidden" name="mode" value="preview" />
        <Button
          type="submit"
          className="h-10 rounded-lg"
          disabled={n === 0 || pending}
          data-testid="approve-clean"
        >
          {n === 0 ? "No clean days" : `Approve ${n} clean`}
        </Button>
      </form>
      {state && !state.ok && !closed ? (
        <FormAlert message={state.formError} className="w-full" />
      ) : null}
      {state?.result && !closed ? (
        <p className="m-0 w-full text-sm font-medium" role="status" data-testid="clean-result">
          {state.message}
        </p>
      ) : null}
      {preview ? (
        <div
          className="flex w-full flex-col gap-3 rounded-xl border border-foreground p-4"
          data-testid="clean-preview"
        >
          <p className="m-0 text-[15px] font-medium">
            Approves {preview.approved.length} {preview.approved.length === 1 ? "day" : "days"}
            {preview.refused.length > 0
              ? `; ${preview.refused.length} left for you to decide one by one.`
              : "."}
          </p>
          {preview.refused.length > 0 ? (
            <ul
              className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm"
              data-testid="clean-refused"
            >
              {preview.refused.map((r) => (
                <li key={r.lineId}>
                  {r.workerName && r.workDate
                    ? `${r.workerName}, ${formatShortDay(r.workDate)}: `
                    : "A day you can't see: "}
                  {CLEAN_REFUSAL_TEXT[r.code]}
                  {r.code === "flagged" && r.exceptions.length > 0
                    ? ` (${exceptionLabels(r.exceptions).join(", ")})`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <form action={action}>
              <input
                type="hidden"
                name="lineIds"
                value={preview.approved.map((a) => a.lineId).join(",")}
              />
              <input type="hidden" name="mode" value="apply" />
              <Button
                type="submit"
                className="h-11 rounded-lg"
                disabled={pending || preview.approved.length === 0}
                data-testid="confirm-clean"
              >
                {pending ? "Approving…" : `Confirm ${preview.approved.length}`}
              </Button>
            </form>
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-lg"
              onClick={() => setClosedFor(state)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
