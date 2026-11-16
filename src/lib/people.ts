import { isWithin } from "@/lib/dates";
import type { Kobo } from "@/lib/money";
import type { Database } from "@/types/db";

/**
 * Pure, browser-safe rules for the People screens (slice 1.5): labels, the mapping status, the
 * line-manager choice, and how a pay version reads. No I/O.
 */

export type EmploymentType = Database["public"]["Enums"]["employment_type"];
export type PayType = Database["public"]["Enums"]["pay_type"];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  permanent: "Permanent",
  contract: "Contract",
  casual: "Casual",
  daily: "Daily",
};

export const PAY_TYPE_LABELS: Record<PayType, string> = {
  monthly: "Monthly",
  daily: "Daily",
  hourly: "Hourly",
};

export function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`;
}

/** Two initials for an avatar: "Musa Ibrahim" gives "MI". */
export function initials(person: { firstName: string; lastName: string }): string {
  return `${person.firstName.charAt(0)}${person.lastName.charAt(0)}`.toUpperCase();
}

/**
 * Mapped means the worker has a department, a line manager and a site (docs/PHASE_1.md 1.6).
 * Projects are optional: not every worker's hours count toward a client project.
 */
export function isMapped(worker: {
  departmentId: string | null;
  hasLineManager: boolean;
  siteIds: readonly string[];
}): boolean {
  return worker.departmentId !== null && worker.hasLineManager && worker.siteIds.length > 0;
}

// ---------------------------------------------------------------------------
// Line manager choice
// ---------------------------------------------------------------------------

/**
 * A line manager is a worker or a manager-app user who is not a worker (owner decision 3). One
 * select holds both, so each option's value carries its kind: `w:<worker id>` or
 * `m:<membership id>`. An empty value means no line manager.
 */
export type LineManagerRef =
  { kind: "worker"; id: string } | { kind: "membership"; id: string } | null;

export function encodeLineManager(ref: LineManagerRef): string {
  if (!ref) return "";
  return `${ref.kind === "worker" ? "w" : "m"}:${ref.id}`;
}

/** The two columns a line-manager choice writes; anything unrecognised clears both. */
export function decodeLineManager(value: string | null | undefined): {
  lineManagerWorkerId: string | null;
  lineManagerMembershipId: string | null;
} {
  const trimmed = (value ?? "").trim();
  if (trimmed.startsWith("w:") && trimmed.length > 2) {
    return { lineManagerWorkerId: trimmed.slice(2), lineManagerMembershipId: null };
  }
  if (trimmed.startsWith("m:") && trimmed.length > 2) {
    return { lineManagerWorkerId: null, lineManagerMembershipId: trimmed.slice(2) };
  }
  return { lineManagerWorkerId: null, lineManagerMembershipId: null };
}

// ---------------------------------------------------------------------------
// Pay versions
// ---------------------------------------------------------------------------

export interface PayAmounts {
  payType: PayType;
  basic: Kobo | null;
  housing: Kobo | null;
  transport: Kobo | null;
  otherAllowances: Kobo | null;
  dailyRate: Kobo | null;
  hourlyRate: Kobo | null;
}

/**
 * The headline amount of a pay version: monthly gross (basic plus allowances), the daily rate
 * or the hourly rate. Exact bigint kobo.
 */
export function payHeadline(rate: PayAmounts): Kobo {
  switch (rate.payType) {
    case "monthly":
      return (
        (rate.basic ?? 0n) +
        (rate.housing ?? 0n) +
        (rate.transport ?? 0n) +
        (rate.otherAllowances ?? 0n)
      );
    case "daily":
      return rate.dailyRate ?? 0n;
    case "hourly":
      return rate.hourlyRate ?? 0n;
  }
}

/** What the headline amount is per: "a month", "a day", "an hour". */
export const PAY_PERIOD: Record<PayType, string> = {
  monthly: "a month",
  daily: "a day",
  hourly: "an hour",
};

export type PayVersionState = "current" | "scheduled" | "ended";

/** Whether a version is in force today, starts later, or has ended. */
export function payVersionState(
  version: { effectiveFrom: string; effectiveTo: string | null },
  today: string,
): PayVersionState {
  if (version.effectiveFrom > today) return "scheduled";
  return isWithin(today, version.effectiveFrom, version.effectiveTo) ? "current" : "ended";
}

/** The version in force on `today`, if any. */
export function currentPayVersion<T extends { effectiveFrom: string; effectiveTo: string | null }>(
  versions: readonly T[],
  today: string,
): T | null {
  return versions.find((v) => payVersionState(v, today) === "current") ?? null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Case-insensitive match on full name or staff ID. A blank query matches everyone. */
export function matchesPeopleSearch(
  person: { firstName: string; lastName: string; staffId: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return true;
  return (
    fullName(person).toLowerCase().includes(q) ||
    `${person.lastName} ${person.firstName}`.toLowerCase().includes(q) ||
    person.staffId.toLowerCase().includes(q)
  );
}
