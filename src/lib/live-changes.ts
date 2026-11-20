/**
 * Changes to a live contract (slice 2.8), pure and isomorphic: the date planning and previews the
 * Posts tab's confirm steps show (and the ops agent's cards), with the same rules and messages
 * as the SQL functions `change_post_requirement`, `add_post` and `close_post` (migration
 * 20261119160000). The database is the authority and checks everything again.
 */

import { addDays, formatDate } from "./dates";
import {
  durationMinutes,
  formatDays,
  formatHours,
  headcountIsPriced,
  headcountRateKey,
  minutesOf,
  parseHeadcountInput,
  postLabel,
  type HeadcountUnit,
} from "./headcount";
import {
  formatRateKey,
  normaliseKeyPart,
  rateCardInForce,
  rateKeyId,
  type DatedVersion,
  type RateKey,
} from "./rate-cards";

/** A rate card version by its keys only (no amounts, so it can cross to the browser). */
export interface RateKeyVersion extends DatedVersion {
  lines: readonly RateKey[];
}

export type LiveChangeCode =
  | "MLPC1"
  | "MLPC2"
  | "MLPC3"
  | "MLPC4"
  | "MLPC5"
  | "MLPC6"
  | "MLPC7"
  | "MLPC8"
  | "MLPC9";

export interface LiveContract {
  status: "draft" | "active" | "ended";
  type: string;
  goLiveDate: string | null;
  endDate: string | null;
  endReason: string | null;
}

export interface RequirementValues {
  /** ISO weekdays, 1 = Monday. */
  daysOfWeek: readonly number[];
  /** "18:00". */
  startTime: string;
  endTime: string;
  requiredCount: number;
}

export interface PostVersion extends RequirementValues {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface LivePost {
  id: string;
  name: string;
  status: "open" | "closed";
  openedOn: string;
  /** The last day staffed, or null while open. */
  closedOn: string | null;
}

export type Refusal = { ok: false; code: LiveChangeCode; reason: string };

function refuse(code: LiveChangeCode, reason: string): Refusal {
  return { ok: false, code, reason };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The contract checks every change starts with (`private.lock_live_contract`). */
function contractRefusal(contract: LiveContract, today: string): Refusal | null {
  if (contract.status === "draft") {
    return refuse("MLPC1", "This contract isn't live yet. Change its headcount instead.");
  }
  if (contract.status !== "active" || (contract.endDate !== null && contract.endDate < today)) {
    return refuse("MLPC1", "This contract has ended and can't change.");
  }
  return null;
}

/** A date a change applies from (`private.check_live_change_date`). */
function dateRefusal(contract: LiveContract, today: string, from: string): Refusal | null {
  if (from < today) return refuse("MLPC2", "A change to a live contract starts today or later.");
  if (contract.goLiveDate !== null && from < contract.goLiveDate) {
    return refuse(
      "MLPC2",
      `The contract goes live on ${formatDate(contract.goLiveDate)}. Choose that day or later.`,
    );
  }
  if (contract.endDate !== null && from > contract.endDate) {
    return refuse(
      "MLPC2",
      `The contract ends on ${formatDate(contract.endDate)}. Choose that day or earlier.`,
    );
  }
  return null;
}

/** Sorted days, each once, as the database stores them. */
export function normaliseDays(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

function quarterHour(time: string): boolean {
  const minutes = minutesOf(time);
  return minutes !== null && minutes % 15 === 0;
}

/** Days, hours and people (`private.check_requirement_values`). */
export function valuesRefusal(values: RequirementValues): Refusal | null {
  const days = values.daysOfWeek;
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    return refuse("MLPC8", "Choose at least one day.");
  }
  if (minutesOf(values.startTime) === null || minutesOf(values.endTime) === null) {
    return refuse("MLPC8", "Choose the start and end times.");
  }
  if (!quarterHour(values.startTime) || !quarterHour(values.endTime)) {
    return refuse("MLPC8", "Times are on the quarter hour.");
  }
  if (!Number.isInteger(values.requiredCount) || values.requiredCount < 1 || values.requiredCount > 200) {
    return refuse("MLPC8", "People required is 1 to 200.");
  }
  return null;
}

export interface WeekCounts {
  /** Shifts (or visits) a week: one per day the post runs. */
  shifts: number;
  /** People times shifts. */
  personShifts: number;
  /** People times hours, in minutes. */
  personMinutes: number;
}

/** A week of one requirement. */
export function weekOf(values: RequirementValues): WeekCounts {
  const shifts = normaliseDays(values.daysOfWeek).length;
  const personShifts = shifts * values.requiredCount;
  return {
    shifts,
    personShifts,
    personMinutes: personShifts * durationMinutes(values.startTime, values.endTime),
  };
}

const NO_WEEK: WeekCounts = { shifts: 0, personShifts: 0, personMinutes: 0 };

/** "14 person-shifts (168 h) a week". */
export function formatWeek(week: WeekCounts): string {
  const hours = week.personMinutes / 60;
  const shown = Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0$/, "");
  return `${plural(week.personShifts, "person-shift", "person-shifts")} (${shown} h) a week`;
}

/** "Every day 18:00–06:00 (next day) × 2". */
export function describeValues(values: RequirementValues): string {
  return `${formatDays(normaliseDays(values.daysOfWeek))} ${formatHours(values)} × ${values.requiredCount}`;
}

function sameValues(a: RequirementValues, b: RequirementValues): boolean {
  const da = normaliseDays(a.daysOfWeek);
  const db = normaliseDays(b.daysOfWeek);
  return (
    da.length === db.length &&
    da.every((d, i) => d === db[i]) &&
    a.startTime.slice(0, 5) === b.startTime.slice(0, 5) &&
    a.endTime.slice(0, 5) === b.endTime.slice(0, 5) &&
    a.requiredCount === b.requiredCount
  );
}

function versionInForce(versions: readonly PostVersion[], date: string): PostVersion | null {
  return (
    versions.find(
      (v) => v.effectiveFrom <= date && (v.effectiveTo === null || v.effectiveTo >= date),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Change headcount from a date
// ---------------------------------------------------------------------------

export type RequirementChangePlan =
  | {
      ok: true;
      /** The version in force on `from`, closing the day before (null when it is replaced). */
      closes: { id: string; effectiveFrom: string; effectiveToAfter: string } | null;
      /** A version that hasn't started and starts on `from`: removed and replaced. */
      replaces: { id: string } | null;
      starts: { effectiveFrom: string; effectiveTo: string | null };
      before: RequirementValues;
      after: RequirementValues;
      week: { before: WeekCounts; after: WeekCounts; personShiftsDifference: number };
      /** "Gate A · Night: 1 → 2 people from 7 Dec 2026. 7 → 14 person-shifts a week." */
      summary: string;
    }
  | Refusal;

/**
 * "Change headcount from `from`": the version to close the day before (or replace) and the new
 * one, with the weekly difference, or the reason `change_post_requirement` will refuse it.
 * `versions` are the post's requirements, any order.
 */
export function planRequirementChange(args: {
  contract: LiveContract;
  post: LivePost;
  versions: readonly PostVersion[];
  today: string;
  from: string;
  next: RequirementValues;
}): RequirementChangePlan {
  const { contract, post, today, from } = args;
  const next = { ...args.next, daysOfWeek: normaliseDays(args.next.daysOfWeek) };
  const blocked = contractRefusal(contract, today) ?? dateRefusal(contract, today, from);
  if (blocked) return blocked;
  if (from < post.openedOn) {
    return refuse(
      "MLPC2",
      `This post opens on ${formatDate(post.openedOn)}. Change it from that day or later.`,
    );
  }
  if (post.closedOn !== null && from > post.closedOn) {
    return refuse(
      "MLPC6",
      `This post closes after ${formatDate(post.closedOn)}. Changes after that day can't be made.`,
    );
  }
  const invalid = valuesRefusal(next);
  if (invalid) return invalid;
  const later = args.versions
    .filter((v) => v.effectiveFrom > from)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0];
  if (later) {
    return refuse(
      "MLPC3",
      `A change is already scheduled from ${formatDate(later.effectiveFrom)}. Choose that day or later.`,
    );
  }
  const current = versionInForce(args.versions, from);
  if (!current) return refuse("MLPC2", `This post has no requirement on ${formatDate(from)}.`);
  if (sameValues(current, next)) {
    return refuse("MLPC9", `Nothing changes: the post already needs that from ${formatDate(from)}.`);
  }
  if (current.effectiveFrom === from && from <= today) {
    return refuse("MLPC2", "This post's requirement started today. Change it from tomorrow.");
  }
  const replaced = current.effectiveFrom === from;
  const before = weekOf(current);
  const after = weekOf(next);
  const people =
    current.requiredCount === next.requiredCount
      ? `${plural(next.requiredCount, "person", "people")}`
      : `${current.requiredCount} → ${plural(next.requiredCount, "person", "people")}`;
  const hours = sameValues({ ...current, requiredCount: 1 }, { ...next, requiredCount: 1 })
    ? ""
    : `, ${describeValues(next).replace(/ × \d+$/, "")}`;
  return {
    ok: true,
    closes: replaced
      ? null
      : { id: current.id, effectiveFrom: current.effectiveFrom, effectiveToAfter: addDays(from, -1) },
    replaces: replaced ? { id: current.id } : null,
    starts: { effectiveFrom: from, effectiveTo: current.effectiveTo },
    before: current,
    after: next,
    week: { before, after, personShiftsDifference: after.personShifts - before.personShifts },
    summary: `${post.name}: ${people}${hours} from ${formatDate(from)}. ${before.personShifts} → ${formatWeek(after)}.`,
  };
}

// ---------------------------------------------------------------------------
// Add a post
// ---------------------------------------------------------------------------

export interface NewPostInput extends RequirementValues {
  siteId: string;
  postName: string;
  role: string;
  band: string;
  unit: HeadcountUnit;
  from: string;
}

export interface PostSite {
  id: string;
  name: string;
  /** Already on the contract. */
  onContract: boolean;
  archived: boolean;
  hasGeofence: boolean;
}

export type AddPostPlan =
  | {
      ok: true;
      name: string;
      siteName: string;
      siteAdded: boolean;
      /** Closed with the contract on its end date when the contract is already ending. */
      closesOn: string | null;
      week: WeekCounts;
      /** "Adds Gate C · Night at Apapa Warehouse 3 from 7 Dec 2026: every day 18:00–06:00 × 1." */
      summary: string;
    }
  | Refusal;

/** "Add post": the new post, or the reason `add_post` will refuse it. */
export function planAddPost(args: {
  contract: LiveContract;
  today: string;
  input: NewPostInput;
  site: PostSite | null;
  /** Ask to add a site that isn't on the contract yet. */
  addSite: boolean;
  clientArchived?: boolean;
  /** The names of the open posts at the chosen site. */
  openPostNames: readonly string[];
  /** The contract's rate card versions, any order (a RateCardVersion fits). */
  rates: readonly RateKeyVersion[];
}): AddPostPlan {
  const { contract, today, input, site } = args;
  const blocked = contractRefusal(contract, today) ?? dateRefusal(contract, today, input.from);
  if (blocked) return blocked;
  const invalid = valuesRefusal(input);
  if (invalid) return invalid;
  const role = input.role.trim();
  if (role.length === 0 || role.length > 80) {
    return refuse("MLPC8", "Name the role (80 characters or fewer, plain text).");
  }
  if (input.band.trim().length > 40) {
    return refuse("MLPC8", "Keep the band to 40 characters of plain text.");
  }
  if (input.postName.trim().length > 80) {
    return refuse("MLPC8", "Keep the post name to 80 characters of plain text.");
  }
  if (!site) return refuse("MLPC5", "That site wasn't found.");
  if (!site.onContract) {
    if (!args.addSite) {
      return refuse("MLPC5", `${site.name} isn't on this contract. Add it with the post.`);
    }
    if (args.clientArchived) return refuse("MLPC5", "The client is archived. Restore it first.");
    if (site.archived) return refuse("MLPC5", `${site.name} is archived. Restore it first.`);
    if (!site.hasGeofence) {
      return refuse("MLPC5", `No geofence at ${site.name}. Set one on the site first.`);
    }
  } else if (site.archived) {
    return refuse("MLPC5", `${site.name} is archived. Restore it first.`);
  }
  const line = { postName: input.postName.trim() || null, role, band: input.band.trim() || "standard" };
  const name = postLabel(line);
  const nameKey = normaliseKeyPart(name);
  if (args.openPostNames.some((n) => normaliseKeyPart(n) === nameKey)) {
    return refuse("MLPC8", `There's already an open post called ${name} at ${site.name}.`);
  }
  if (!rateCardInForce(args.rates, input.from)) {
    return refuse("MLPC4", `No rate card is in force on ${formatDate(input.from)}.`);
  }
  if (headcountIsPriced(contract.type)) {
    const key = headcountRateKey({ role, band: line.band, unit: input.unit });
    const versions = [...args.rates]
      .filter(
        (v) =>
          (v.effectiveTo === null || v.effectiveTo >= input.from) &&
          (contract.endDate === null || v.effectiveFrom <= contract.endDate),
      )
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    for (const v of versions) {
      const id = rateKeyId(key);
      if (!v.lines.some((line) => rateKeyId(line) === id)) {
        const on = v.effectiveFrom > input.from ? v.effectiveFrom : input.from;
        const when = on === input.from ? "" : ` from ${formatDate(on)}`;
        return refuse(
          "MLPC4",
          `No rate for ${formatRateKey(key)}${when}. Add it to the rate card first.`,
        );
      }
    }
  }
  const closesOn = contract.endReason !== null ? contract.endDate : null;
  const added = site.onContract ? "" : ` (adds ${site.name} to the contract)`;
  return {
    ok: true,
    name,
    siteName: site.name,
    siteAdded: !site.onContract,
    closesOn,
    week: weekOf(input),
    summary: `Adds ${name} at ${site.name}${added} from ${formatDate(input.from)}: ${describeValues(input)}.${closesOn ? ` It closes with the contract after ${formatDate(closesOn)}.` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Close a post
// ---------------------------------------------------------------------------

export type ClosePostPlan =
  | {
      ok: true;
      /** Versions that would start after the last day: removed (none has started). */
      cancels: string[];
      /** Versions running past the last day: they end on it. */
      closes: string[];
      neverStaffed: boolean;
      week: { before: WeekCounts; after: WeekCounts };
      /** "Closes Gate A · Night after 7 Dec 2026 (its last day staffed)." */
      summary: string;
    }
  | Refusal;

/** "Close post": what closes and is removed, or the reason `close_post` will refuse it. */
export function planClosePost(args: {
  contract: LiveContract;
  post: LivePost;
  versions: readonly PostVersion[];
  today: string;
  lastDay: string;
  reason: string;
}): ClosePostPlan {
  const { contract, post, today, lastDay } = args;
  const blocked = contractRefusal(contract, today);
  if (blocked) return blocked;
  if (post.status === "closed") {
    return refuse("MLPC6", `This post already closes after ${formatDate(post.closedOn ?? lastDay)}.`);
  }
  if (lastDay < today) return refuse("MLPC2", "The last day can't be in the past.");
  if (lastDay < addDays(post.openedOn, -1)) {
    return refuse(
      "MLPC2",
      `This post opens on ${formatDate(post.openedOn)}. Its last day can't be before that.`,
    );
  }
  if (contract.endDate !== null && lastDay >= contract.endDate) {
    return refuse(
      "MLPC2",
      `The contract ends on ${formatDate(contract.endDate)}, and the post closes with it. Choose an earlier day.`,
    );
  }
  const reason = args.reason.trim();
  if (reason.length === 0) return refuse("MLPC7", "Say why.");
  if (reason.length > 500) return refuse("MLPC7", "Keep it to 500 characters of plain text.");
  const cancels = args.versions.filter((v) => v.effectiveFrom > lastDay).map((v) => v.id);
  const closes = args.versions
    .filter((v) => v.effectiveFrom <= lastDay && (v.effectiveTo === null || v.effectiveTo > lastDay))
    .map((v) => v.id);
  const inForce = versionInForce(args.versions, today > post.openedOn ? today : post.openedOn);
  const neverStaffed = lastDay < post.openedOn;
  return {
    ok: true,
    cancels,
    closes,
    neverStaffed,
    week: { before: inForce ? weekOf(inForce) : NO_WEEK, after: NO_WEEK },
    summary: neverStaffed
      ? `Closes ${post.name} before it opens on ${formatDate(post.openedOn)}: it is never staffed.`
      : `Closes ${post.name} after ${formatDate(lastDay)} (its last day staffed).${cancels.length ? ` ${plural(cancels.length, "scheduled change is", "scheduled changes are")} removed.` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Typed input
// ---------------------------------------------------------------------------

export interface RequirementInput {
  days: string[];
  startTime: string;
  endTime: string;
  requiredCount: string;
}

export type ParsedRequirement =
  | { ok: true; values: RequirementValues }
  | { ok: false; errors: Partial<Record<keyof RequirementInput, string>> };

const PLACEHOLDER_SITE = "00000000-0000-4000-8000-000000000000";

/** Days, hours and people as typed, with the headcount editor's rules and messages. */
export function parseRequirementInput(input: RequirementInput): ParsedRequirement {
  const parsed = parseHeadcountInput({
    ...input,
    siteId: PLACEHOLDER_SITE,
    postName: "",
    role: "Post",
    band: "",
    unit: "shift",
    notes: "",
  });
  if (!parsed.ok) {
    const { days, startTime, endTime, requiredCount } = parsed.errors;
    const errors = Object.fromEntries(
      Object.entries({ days, startTime, endTime, requiredCount }).filter(([, v]) => v),
    ) as Partial<Record<keyof RequirementInput, string>>;
    return { ok: false, errors };
  }
  const { daysOfWeek, startTime, endTime, requiredCount } = parsed.line;
  return { ok: true, values: { daysOfWeek, startTime, endTime, requiredCount } };
}
