/**
 * Who could cover an uncovered shift (slice 3.2). Pure and isomorphic: the server picks the top
 * suggestion for each card in the Uncovered tray, and the browser ranks everyone in the picker.
 *
 * The rules (shown under the tray):
 * - A worker who has left, hasn't started, is on approved leave that day (slice 4.5: `leave`
 *   spans from public.roster_leave), is already on this shift or is on an overlapping shift is not
 *   suggested: the database would refuse them anyway. The picker lists them as "can't be
 *   assigned" with the reason ("On leave 4 to 6 Nov").
 * - Leave still waiting for a decision that day is never a block: the worker is marked
 *   ("Leave waiting for a decision 4 to 6 Nov") and ranks after everyone without it.
 * - Everyone else may be assigned. These are flags only, never blocks:
 *   - mapped to the site that day (worker_assignments in force) ranks first; "Relief pool" (no
 *     site mapping that day) next; "Not mapped to this site" last;
 *   - this week's scheduled hours against the company standard (standard_shift_minutes ×
 *     work_days_per_week): "within 4 h of the weekly standard" when this shift brings them within
 *     4 hours of it, "over the weekly standard" when it takes them past it; those rank lower.
 * - Then fewer hours this week first, then name.
 *
 * Reasons read like the prototype: "Off Saturday · 36 h this week", "Relief pool · 0 h this week".
 * Names and staff IDs are the only personal data used.
 */

import { leaveOn, onLeaveLabel, pendingLeaveLabel, type LeaveSpan } from "./leave/roster";
import { dayLabel, formatHoursTotal, formatShortDay, minutesBetween, timeIn } from "./roster";

/** Four hours: the margin for "within 4 h of the weekly standard". */
export const NEAR_STANDARD_MINUTES = 240;

export interface CandidateWorker {
  id: string;
  staffId: string;
  firstName: string;
  lastName: string;
  startDate: string;
  endDate: string | null;
  /** status = 'ended'. */
  ended: boolean;
  /** Site mappings (worker_assignments with a site), by date. */
  mappings: readonly { siteId: string; from: string; to: string | null }[];
}

/** An assignment the worker already has (any site), for overlaps and the week's hours. */
export interface BookedShift {
  workerId: string;
  shiftId: string;
  postName: string;
  date: string;
  startsAt: string;
  endsAt: string;
}

/** The shift to fill. */
export interface ShiftSlot {
  postId: string;
  siteId: string;
  /** The day the shift starts. */
  date: string;
  startsAt: string;
  endsAt: string;
  /** The Monday of its week. */
  weekStart: string;
}

export interface SuggestionOptions {
  /** standard_shift_minutes × work_days_per_week. */
  weeklyStandardMinutes: number;
  timeZone: string;
  /** Approved and pending leave (slice 4.5, public.roster_leave). */
  leave?: readonly LeaveSpan[];
  /** Extra "on leave" check beside `leave` (tests and callers without spans). */
  onLeave?: (workerId: string, date: string) => boolean;
}

export type SuggestionFlag =
  "not_mapped" | "relief_pool" | "near_standard" | "over_standard" | "leave_pending";

export interface Suggestion {
  workerId: string;
  name: string;
  firstName: string;
  staffId: string;
  /** Mapped to this site on the day. */
  mapped: boolean;
  /** Minutes already scheduled this week, before this shift. */
  weekMinutes: number;
  /** False when the worker can't take this shift; `blocked` says why. */
  eligible: boolean;
  blocked: string | null;
  flags: SuggestionFlag[];
  /** "Off Saturday · 36 h this week". */
  reason: string;
}

/** No extra leave check. */
export const noLeave = (): boolean => false;

function within(date: string, from: string, to: string | null): boolean {
  return from <= date && (to === null || date <= to);
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

/** Every worker, ranked for the slot: eligible first, best first. */
export function rankCandidates(
  slot: ShiftSlot,
  candidates: readonly CandidateWorker[],
  booked: readonly BookedShift[],
  options: SuggestionOptions,
): Suggestion[] {
  const onLeave = options.onLeave ?? noLeave;
  const spans = options.leave ?? [];
  const weekEndDate = (() => {
    const d = new Date(`${slot.weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  })();
  const slotMinutes = minutesBetween(slot.startsAt, slot.endsAt);
  const day = dayLabel(slot.date);

  const byWorker = new Map<string, BookedShift[]>();
  for (const b of booked) {
    const list = byWorker.get(b.workerId) ?? [];
    list.push(b);
    byWorker.set(b.workerId, list);
  }

  const ranked = candidates.map((worker) => {
    const name = `${worker.firstName} ${worker.lastName}`;
    const mine = byWorker.get(worker.id) ?? [];
    const weekMinutes = mine
      .filter((b) => b.date >= slot.weekStart && b.date <= weekEndDate)
      .reduce((sum, b) => sum + minutesBetween(b.startsAt, b.endsAt), 0);
    const siteMappings = worker.mappings.filter((m) => within(slot.date, m.from, m.to));
    const mapped = siteMappings.some((m) => m.siteId === slot.siteId);
    const reliefPool = siteMappings.length === 0;
    const sameDay = mine.some((b) => b.date === slot.date);

    const away = leaveOn(spans, worker.id, slot.date, "approved");
    let blocked: string | null = null;
    if (worker.ended && (worker.endDate === null || worker.endDate < slot.date)) {
      blocked = "Has left the company";
    } else if (worker.endDate !== null && worker.endDate < slot.date) {
      blocked = `Leaves on ${formatShortDay(worker.endDate)}`;
    } else if (worker.startDate > slot.date) {
      blocked = `Starts on ${formatShortDay(worker.startDate)}`;
    } else if (away) {
      blocked = onLeaveLabel(away);
    } else if (onLeave(worker.id, slot.date)) {
      blocked = "On leave";
    } else {
      const clash = mine.find((b) => overlaps(b.startsAt, b.endsAt, slot.startsAt, slot.endsAt));
      if (clash) {
        blocked =
          clash.date === slot.date && Date.parse(clash.startsAt) === Date.parse(slot.startsAt)
            ? `Already on ${clash.postName} then`
            : `Double-booked: ${clash.postName} ${formatShortDay(clash.date)} ${timeIn(clash.startsAt, options.timeZone)}–${timeIn(clash.endsAt, options.timeZone)}`;
      }
    }

    const flags: SuggestionFlag[] = [];
    if (!mapped) flags.push(reliefPool ? "relief_pool" : "not_mapped");
    const after = weekMinutes + slotMinutes;
    const standard = options.weeklyStandardMinutes;
    if (after > standard) flags.push("over_standard");
    else if (standard - after < NEAR_STANDARD_MINUTES) flags.push("near_standard");
    const pending = leaveOn(spans, worker.id, slot.date, "pending");
    if (pending) flags.push("leave_pending");

    const where = mapped
      ? sameDay
        ? "Mapped here"
        : `Off ${day.long}`
      : reliefPool
        ? "Relief pool"
        : "Not mapped to this site";
    const parts = [where, `${formatHoursTotal(weekMinutes)} this week`];
    if (flags.includes("over_standard")) parts.push("over the weekly standard with this shift");
    else if (flags.includes("near_standard")) parts.push("within 4 h of the weekly standard");
    if (pending) parts.push(pendingLeaveLabel(pending));

    const suggestion: Suggestion = {
      workerId: worker.id,
      name,
      firstName: worker.firstName,
      staffId: worker.staffId,
      mapped,
      weekMinutes,
      eligible: blocked === null,
      blocked,
      flags,
      reason: parts.join(" · "),
    };
    const placeRank = mapped ? 0 : reliefPool ? 1 : 2;
    const hoursRank = flags.includes("over_standard") ? 2 : flags.includes("near_standard") ? 1 : 0;
    return { suggestion, placeRank, hoursRank, pendingRank: pending ? 1 : 0 };
  });

  ranked.sort(
    (a, b) =>
      Number(b.suggestion.eligible) - Number(a.suggestion.eligible) ||
      a.pendingRank - b.pendingRank ||
      a.placeRank - b.placeRank ||
      a.hoursRank - b.hoursRank ||
      a.suggestion.weekMinutes - b.suggestion.weekMinutes ||
      a.suggestion.name.localeCompare(b.suggestion.name) ||
      a.suggestion.staffId.localeCompare(b.suggestion.staffId),
  );
  return ranked.map((r) => r.suggestion);
}

/** The best eligible worker for the slot, or null when nobody is free. */
export function topSuggestion(
  slot: ShiftSlot,
  candidates: readonly CandidateWorker[],
  booked: readonly BookedShift[],
  options: SuggestionOptions,
): Suggestion | null {
  const [first] = rankCandidates(slot, candidates, booked, options);
  return first && first.eligible ? first : null;
}

/** Search the picker by name or staff ID (case-insensitive, every word must match). */
export function matchesSearch(
  suggestion: Pick<Suggestion, "name" | "staffId">,
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${suggestion.name} ${suggestion.staffId}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}
