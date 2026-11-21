import "server-only";

import { formatDate } from "@/lib/dates";
import { formatLeaveDays, formatLeavePay } from "@/lib/leave/entitlements";
import { formatOpenedShifts } from "@/lib/leave/roster";
import { ADVISER_LINE, findPreset } from "@/lib/leave/presets";
import { formatShortDay } from "@/lib/roster";
import {
  previewApplyPreset,
  previewCopyHolidays,
  previewEntitlementVersion,
  type EntitlementChangeResult,
  type HolidayCopyResult,
  type PresetResult,
} from "@/server/people/leave-setup-data";
import type {
  applyPresetSchema,
  copyHolidaysSchema,
  entitlementVersionSchema,
} from "@/server/people/leave-setup-schemas";

import { previewHrDecision, type HrDecisionResult } from "@/server/people/leave-data";
import type { decideLeaveSchema } from "@/server/people/leave-request-schemas";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * Previews for leave setup's multi-row writes (slice 4.1). Each runs the SQL function's own dry
 * run, so the confirm step shows exactly what the change does. No personal data is involved.
 */

const holidays = (n: number) => `${n} ${n === 1 ? "holiday" : "holidays"}`;

export function describeHolidayCopy(result: HolidayCopyResult): CapabilityPreview {
  const copied = result.copied.length;
  const skipped = result.skipped.length;
  let summary: string;
  if (copied === 0 && skipped === 0) {
    summary = `${result.fromYear} has no holidays, so nothing is copied into ${result.toYear}.`;
  } else {
    summary = `Copies ${holidays(copied)} from ${result.fromYear} into ${result.toYear}`;
    summary += skipped > 0 ? `; ${skipped} can't be copied.` : ".";
    summary += " Check the dates of moveable holidays after copying.";
  }
  return {
    summary,
    changes: [
      ...result.copied.map((c) => ({ label: formatDate(c.date), after: c.name })),
      ...result.skipped.map((s) => ({
        label: formatDate(s.date),
        before: s.name,
        after: `Not copied: ${s.reason}`,
      })),
    ],
  };
}

export const previewHolidayCopy: PreviewFn<typeof copyHolidaysSchema> = async ({
  supabase,
  organisationId,
  data,
}) => describeHolidayCopy(await previewCopyHolidays(supabase, organisationId, data.fromYear, data.toYear));

export function describePresetResult(result: PresetResult): CapabilityPreview {
  const preset = findPreset(result.preset);
  const created = result.types.filter((t) => t.action === "create").length;
  const versioned = result.types.filter((t) => t.action === "version").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`adds ${created} leave ${created === 1 ? "type" : "types"}`);
  if (versioned > 0) {
    parts.push(
      `changes the days of ${versioned} from ${formatDate(result.effectiveFrom)}`,
    );
  }
  const action = parts.length > 0 ? parts.join(" and ") : "changes no days";
  const kept =
    result.kept.length > 0
      ? ` Your other ${result.kept.length === 1 ? "type stays" : `${result.kept.length} types stay`} as they are.`
      : "";
  return {
    summary: `Preset ${preset.id}, ${preset.name}: ${action}.${kept} ${ADVISER_LINE}`,
    changes: [
      ...result.types.map((t) => {
        const after = `${formatLeaveDays(t.after.daysPerYear, t.after.counting)} · ${formatLeavePay(t.after.payPercent > 0, t.after.payPercent, t.after.payMinServiceMonths)}`;
        if (t.action === "create") return { label: t.name, after: `New: ${after}` };
        if (t.action === "unchanged") {
          return { label: t.name, after: t.detailsChanged ? `Same days; rules updated` : "No change" };
        }
        return {
          label: t.name,
          before: t.before ? formatLeaveDays(t.before.daysPerYear, t.after.counting) : undefined,
          after: `${after} from ${formatDate(t.after.effectiveFrom)}`,
        };
      }),
      ...result.kept.map((k) => ({ label: k.name, after: "Kept as it is" })),
    ],
  };
}

export const previewPreset: PreviewFn<typeof applyPresetSchema> = async ({
  supabase,
  organisationId,
  data,
}) =>
  describePresetResult(
    await previewApplyPreset(supabase, organisationId, data.preset, data.effectiveFrom),
  );

export function describeEntitlementChange(result: EntitlementChangeResult): CapabilityPreview {
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"} a year`;
  if (result.unchanged) {
    return {
      summary: `${result.name} already has ${days(result.after.daysPerYear)} from ${formatDate(result.effectiveFrom)}. Nothing changes.`,
      changes: [],
    };
  }
  const from = formatDate(result.effectiveFrom);
  const summary = result.before
    ? `${result.name} changes from ${days(result.before.daysPerYear)} to ${days(result.after.daysPerYear)} from ${from}. Earlier days stay as they were.`
    : `${result.name} gets ${days(result.after.daysPerYear)} from ${from}.`;
  return {
    summary,
    changes: [
      {
        label: `${result.name} from ${from}`,
        before: result.before ? days(result.before.daysPerYear) : undefined,
        after: `${days(result.after.daysPerYear)} · ${result.after.payPercent}% pay`,
      },
      ...result.replaces.map((r) => ({
        label: `Scheduled from ${formatDate(r.effectiveFrom)}`,
        before: days(r.daysPerYear),
        after: "Replaced by this change",
      })),
    ],
  };
}

export const previewEntitlement: PreviewFn<typeof entitlementVersionSchema> = async ({
  supabase,
  organisationId,
  data,
}) => describeEntitlementChange(await previewEntitlementVersion(supabase, organisationId, data));

// ---------------------------------------------------------------------------
// Slice 4.4: HR's final decision on a leave request
// ---------------------------------------------------------------------------

/** What HR's decision does, from public.decide_leave_hr's dry run. No names or reasons. */
export function describeHrDecision(result: HrDecisionResult): CapabilityPreview {
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  if (result.status !== "approved") {
    return {
      summary: "Declines the request. The balance stays as it is and the worker is told why.",
      changes: [{ label: "Request", before: "With HR", after: "Declined" }],
    };
  }
  // Slice 4.5: the shifts the approval opens, each one listed; they go back to uncovered.
  const opened = result.openShifts;
  const shifts =
    opened.length > 0
      ? ` ${formatOpenedShifts(opened)}; they go back to uncovered and ops is emailed.`
      : "";
  return {
    summary: `Approves ${days(result.days)}: the balance goes from ${result.balanceBefore} to ${result.balanceAfter}.${shifts}${result.payBelowService ? " Below the service the pay needs: Phase 5 pays it as unpaid." : ""}`,
    changes: [
      { label: "Request", before: "With HR", after: "Approved" },
      {
        label: "Balance",
        before: days(result.balanceBefore),
        after: days(result.balanceAfter),
      },
      ...opened.map((s) => ({
        label: `${s.postName}, ${formatShortDay(s.shiftDate)}`,
        before: "Assigned",
        after: `Uncovered${s.siteName ? ` at ${s.siteName}` : ""}`,
      })),
    ],
  };
}

export const previewHrLeaveDecision: PreviewFn<typeof decideLeaveSchema> = async ({
  supabase,
  organisationId,
  data,
}) => describeHrDecision(await previewHrDecision(supabase, organisationId, data));
