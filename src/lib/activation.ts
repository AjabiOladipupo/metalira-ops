/**
 * Contract activation (slice 2.7), pure and isomorphic: the checklist and preview the contract
 * page shows before "Activate contract", the plain-English list of a database refusal, and the
 * expansion of roster requirements into required shifts (the same rules as
 * `private.required_shifts`, for tests and screens).
 *
 * The database is the authority: `activate_contract` runs the same checks inside its
 * transaction and refuses with MLCT codes. This preview only says what will happen.
 */

import { addDays, formatDate, isWithin } from "./dates";
import {
  crossesMidnight,
  durationMinutes,
  formatDays,
  formatHours,
  headcountIsPriced,
  headcountRateKey,
  headcountRequired,
  isoWeekday,
  postLabel,
  type HeadcountLine,
} from "./headcount";
import {
  formatRateKey,
  missingRateKeys,
  rateCardInForce,
  type RateCardVersion,
} from "./rate-cards";

export type ActivationCode =
  "MLCT1" | "MLCT2" | "MLCT3" | "MLCT4" | "MLCT5" | "MLCT6" | "MLCT7" | "MLCT8" | "MLCT9";

export const ACTIVATION_CODES: readonly ActivationCode[] = [
  "MLCT1",
  "MLCT2",
  "MLCT3",
  "MLCT4",
  "MLCT5",
  "MLCT6",
  "MLCT7",
  "MLCT8",
  "MLCT9",
];

/** What each checklist line is about, in the order the dialog shows them. */
export const CHECK_LABELS: Record<ActivationCode, string> = {
  MLCT1: "Contract is a draft",
  MLCT2: "Billing contact",
  MLCT3: "Sites with a geofence",
  MLCT8: "Client and sites in use",
  MLCT4: "Rate card on the go-live date",
  MLCT5: "A rate for every headcount row",
  MLCT9: "Service type and WHT on every rate line",
  MLCT6: "Headcount",
  MLCT7: "Go-live date",
};

export interface ActivationIssue {
  code: ActivationCode;
  message: string;
}

export interface ActivationCheck {
  code: ActivationCode;
  label: string;
  ok: boolean;
  /** Why it fails, in plain English; empty when ok. */
  messages: string[];
}

export interface ActivationSite {
  id: string;
  name: string;
  archived: boolean;
  hasGeofence: boolean;
}

export interface ActivationInput {
  contract: {
    status: "draft" | "active" | "ended";
    type: string;
    startDate: string;
    endDate: string | null;
  };
  /** The company's today (`private.org_today`). */
  today: string;
  /** Null: the later of the start date and today, as the database chooses. */
  goLiveDate?: string | null;
  clientArchived: boolean;
  hasBillingContact: boolean;
  sites: readonly ActivationSite[];
  /** Oldest first. */
  versions: readonly RateCardVersion[];
  headcount: readonly HeadcountLine[];
}

export interface PlannedPost {
  headcountId: string;
  siteId: string;
  siteName: string;
  name: string;
  days: string;
  hours: string;
  requiredCount: number;
}

export interface ActivationPlan {
  goLiveDate: string;
  ready: boolean;
  checks: ActivationCheck[];
  issues: ActivationIssue[];
  posts: PlannedPost[];
  /** "Creates 4 posts and 4 roster requirements from 1 Dec 2026." */
  summary: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function list(names: readonly string[]): string {
  return [...names].sort((a, b) => a.localeCompare(b)).join(", ");
}

/** The default go-live date: the later of the contract's start and the company's today. */
export function defaultGoLiveDate(startDate: string, today: string): string {
  return startDate > today ? startDate : today;
}

/**
 * The checklist and preview for "Activate contract", with the same checks and messages as
 * `activate_contract` (migration 20261119150000).
 */
export function planActivation(input: ActivationInput): ActivationPlan {
  const { contract, today } = input;
  const goLive = input.goLiveDate ?? defaultGoLiveDate(contract.startDate, today);
  const issues: ActivationIssue[] = [];
  const add = (code: ActivationCode, message: string) => issues.push({ code, message });

  if (contract.status === "ended") add("MLCT1", "This contract has ended and can't be activated.");

  if (goLive < contract.startDate) add("MLCT7", "The go-live date is before the contract starts.");
  if (goLive < today) add("MLCT7", "The go-live date is in the past.");
  if (contract.endDate !== null && contract.endDate < goLive) {
    add("MLCT7", "The contract ends before the go-live date.");
  }

  if (!input.hasBillingContact) {
    add("MLCT2", "The client has no billing contact. Add one with an email address.");
  }

  if (input.clientArchived) add("MLCT8", "The client is archived. Restore it first.");
  const archived = input.sites.filter((s) => s.archived).map((s) => s.name);
  if (archived.length > 0) {
    add("MLCT8", `Archived sites: ${list(archived)}. Restore them or take them off the contract.`);
  }

  if (input.sites.length === 0) add("MLCT3", "The contract has no sites. Add at least one.");
  const noFence = input.sites.filter((s) => !s.hasGeofence).map((s) => s.name);
  if (noFence.length > 0) {
    add("MLCT3", `No geofence at ${list(noFence)}. Set one on each site.`);
  }

  const version = rateCardInForce(input.versions, goLive);
  if (!version) {
    add("MLCT4", `No rate card is in force on ${formatDate(goLive)}.`);
  } else if (headcountIsPriced(contract.type)) {
    const missing = missingRateKeys(input.headcount.map(headcountRateKey), version);
    if (missing.length > 0) {
      add(
        "MLCT5",
        `No rate for ${missing.map(formatRateKey).join(", ")}. Add it to the rate card.`,
      );
    }
  }

  if (headcountRequired(contract.type) && input.headcount.length === 0) {
    add("MLCT6", "A manned-post contract needs headcount. Add the posts first.");
  }

  const order = Object.keys(CHECK_LABELS) as ActivationCode[];
  const checks: ActivationCheck[] = order
    .filter((code) => code !== "MLCT1" || contract.status === "ended")
    .map((code) => {
      const messages = issues.filter((i) => i.code === code).map((i) => i.message);
      return { code, label: CHECK_LABELS[code], ok: messages.length === 0, messages };
    });

  const siteName = new Map(input.sites.map((s) => [s.id, s.name]));
  const posts: PlannedPost[] = input.headcount.map((line) => ({
    headcountId: line.id,
    siteId: line.siteId,
    siteName: siteName.get(line.siteId) ?? "a site",
    name: postLabel(line),
    days: formatDays(line.daysOfWeek),
    hours: formatHours(line),
    requiredCount: line.requiredCount,
  }));

  const ready = issues.length === 0 && contract.status === "draft";
  const summary =
    contract.status === "active"
      ? "This contract is live."
      : `Creates ${plural(posts.length, "post", "posts")} and ${plural(
          posts.length,
          "roster requirement",
          "roster requirements",
        )} from ${formatDate(goLive)}.`;
  return { goLiveDate: goLive, ready, checks, issues, posts, summary };
}

function isActivationCode(value: unknown): value is ActivationCode {
  return typeof value === "string" && (ACTIVATION_CODES as readonly string[]).includes(value);
}

/**
 * The items of an `activate_contract` refusal: its DETAIL is a JSON list of `{code, message}`.
 * Falls back to the one message when the detail is missing or odd.
 */
export function activationIssuesFromDb(error: {
  code: string;
  message: string;
  details?: string | null;
}): ActivationIssue[] {
  try {
    const parsed: unknown = JSON.parse(error.details ?? "");
    if (Array.isArray(parsed)) {
      const items = parsed.flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null) return [];
        const { code, message } = item as { code?: unknown; message?: unknown };
        return isActivationCode(code) && typeof message === "string" ? [{ code, message }] : [];
      });
      if (items.length > 0) return items;
    }
  } catch {
    // Not JSON: use the message.
  }
  return isActivationCode(error.code) ? [{ code: error.code, message: error.message }] : [];
}

// ---------------------------------------------------------------------------
// Required shifts (mirrors private.required_shifts)
// ---------------------------------------------------------------------------

export interface RosterPost {
  id: string;
  name: string;
  openedOn: string;
  /** The last day staffed, or null while open. */
  closedOn: string | null;
}

export interface RosterRequirement {
  id: string;
  postId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  daysOfWeek: readonly number[];
  /** "18:00" or "18:00:00". */
  startTime: string;
  endTime: string;
  requiredCount: number;
}

export interface RequiredShift {
  requirementId: string;
  postId: string;
  postName: string;
  /** The day the shift starts (a night shift belongs to it). */
  date: string;
  /** Wall-clock start, `YYYY-MM-DDTHH:MM`, in the company's time zone. */
  startsAt: string;
  /** Wall-clock end; the next day when the shift crosses midnight. */
  endsAt: string;
  requiredCount: number;
}

/** The days from `from` to `to` inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

export const MAX_SHIFT_RANGE_DAYS = 62;

/**
 * One shift per post and date from `from` to `to` (62 days at most): the requirement in force
 * that day, when the weekday is one of its days and the post is open that day, and the contract
 * is live on it (`contract.goLiveDate` to `contract.endDate`).
 */
export function expandRequiredShifts(args: {
  posts: readonly RosterPost[];
  requirements: readonly RosterRequirement[];
  from: string;
  to: string;
  contract?: { goLiveDate: string | null; endDate: string | null };
}): RequiredShift[] {
  const { from, to } = args;
  if (to < from) throw new RangeError("The from date is after the to date.");
  const days = datesBetween(from, to);
  if (days.length > MAX_SHIFT_RANGE_DAYS) throw new RangeError("Ask for 62 days or fewer.");
  const posts = new Map(args.posts.map((p) => [p.id, p]));
  const shifts: RequiredShift[] = [];
  for (const date of days) {
    if (args.contract) {
      const { goLiveDate, endDate } = args.contract;
      if (goLiveDate !== null && date < goLiveDate) continue;
      if (endDate !== null && date > endDate) continue;
    }
    const weekday = isoWeekday(date);
    for (const r of args.requirements) {
      const post = posts.get(r.postId);
      if (!post) continue;
      if (!isWithin(date, r.effectiveFrom, r.effectiveTo)) continue;
      if (!isWithin(date, post.openedOn, post.closedOn)) continue;
      if (!r.daysOfWeek.includes(weekday)) continue;
      const start = r.startTime.slice(0, 5);
      const end = r.endTime.slice(0, 5);
      const endDate = crossesMidnight(start, end) ? addDays(date, 1) : date;
      shifts.push({
        requirementId: r.id,
        postId: post.id,
        postName: post.name,
        date,
        startsAt: `${date}T${start}`,
        endsAt: `${endDate}T${end}`,
        requiredCount: r.requiredCount,
      });
    }
  }
  return shifts.sort((a, b) =>
    a.startsAt === b.startsAt
      ? a.postName.localeCompare(b.postName)
      : a.startsAt < b.startsAt
        ? -1
        : 1,
  );
}

/** Person-shifts and hours over a set of required shifts. */
export function summariseRequiredShifts(shifts: readonly RequiredShift[]): {
  shifts: number;
  personShifts: number;
  personMinutes: number;
} {
  let personShifts = 0;
  let personMinutes = 0;
  for (const s of shifts) {
    personShifts += s.requiredCount;
    personMinutes += s.requiredCount * durationMinutes(s.startsAt.slice(11), s.endsAt.slice(11));
  }
  return { shifts: shifts.length, personShifts, personMinutes };
}

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------

export interface EndPlanInput {
  status: "draft" | "active" | "ended";
  goLiveDate: string | null;
  endDate: string | null;
  endReason: string | null;
  today: string;
  endOn: string;
  openPosts: number;
}

/** What "End contract" will do, or why it can't. */
export function planEndContract(
  input: EndPlanInput,
): { ok: true; summary: string } | { ok: false; reason: string } {
  if (input.status !== "active") return { ok: false, reason: "Only a live contract can be ended." };
  if (input.endReason !== null) {
    return input.endDate === input.endOn
      ? { ok: true, summary: `Already ending on ${formatDate(input.endOn)}. Nothing changes.` }
      : {
          ok: false,
          reason: `This contract is already ending on ${formatDate(input.endDate ?? input.endOn)}.`,
        };
  }
  if (input.endOn < input.today) {
    return { ok: false, reason: "The last day of service can't be in the past." };
  }
  if (input.goLiveDate !== null && input.endOn < input.goLiveDate) {
    return { ok: false, reason: "The last day of service can't be before the go-live date." };
  }
  if (input.endDate !== null && input.endOn > input.endDate) {
    return {
      ok: false,
      reason: `The contract already ends on ${formatDate(input.endDate)}. It can end earlier, not later.`,
    };
  }
  return {
    ok: true,
    summary: `Closes ${plural(input.openPosts, "post", "posts")}, their roster requirements and the rate card on ${formatDate(input.endOn)}. The contract ends after that day.`,
  };
}
