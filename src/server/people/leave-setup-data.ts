import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { LAGOS_TIME_ZONE, todayIn } from "@/lib/dates";
import {
  DEFAULT_WORK_DAYS,
  formatWorkDays,
  normaliseWorkDays,
  versionOn,
  type EntitlementValues,
  type EntitlementVersion,
} from "@/lib/leave/entitlements";
import type { LeaveCounting, PresetId } from "@/lib/leave/presets";
import type { Database, Json } from "@/types/db";

/**
 * Reads for leave setup and the company calendar (slice 4.1), under RLS as the signed-in member,
 * and the dry runs behind the confirm steps. The dry runs call the same SQL functions as the
 * writes with `p_dry_run`, so a preview and the change can't disagree.
 */

type Client = SupabaseClient<Database>;

export interface LeaveTypeRow {
  id: string;
  code: string;
  name: string;
  counting: LeaveCounting;
  paid: boolean;
  needsCertificate: boolean;
  minServiceMonths: number;
  preset: PresetId | null;
  sourceLabel: string | null;
  status: "active" | "retired";
  /** Oldest first. */
  versions: EntitlementVersion[];
}

export interface LeaveSetup {
  today: string;
  workDays: number[];
  types: LeaveTypeRow[];
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
  removedAt: string | null;
}

async function companyCalendar(
  supabase: Client,
  organisationId: string,
): Promise<{ today: string; workDays: number[] }> {
  const { data, error } = await supabase
    .from("organisations")
    .select("timezone, default_work_days")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the company calendar (${error.code})`);
  return {
    today: todayIn(data?.timezone ?? LAGOS_TIME_ZONE),
    workDays: normaliseWorkDays(data?.default_work_days ?? []) ?? [...DEFAULT_WORK_DAYS],
  };
}

/** The company's leave types with their entitlement versions, active first, then by name. */
export async function loadLeaveSetup(supabase: Client, organisationId: string): Promise<LeaveSetup> {
  const [calendar, types, versions] = await Promise.all([
    companyCalendar(supabase, organisationId),
    supabase
      .from("leave_types")
      .select(
        "id, code, name, counting, paid, needs_certificate, min_service_months, preset, source_label, status",
      )
      .eq("organisation_id", organisationId),
    supabase
      .from("leave_entitlements")
      .select(
        "id, leave_type_id, effective_from, effective_to, days_per_year, carry_over_cap_days, pay_percent, pay_min_service_months",
      )
      .eq("organisation_id", organisationId)
      .order("effective_from"),
  ]);
  if (types.error) throw new Error(`Could not load the leave types (${types.error.code})`);
  if (versions.error) {
    throw new Error(`Could not load the leave entitlements (${versions.error.code})`);
  }
  const byType = new Map<string, EntitlementVersion[]>();
  for (const v of versions.data) {
    const list = byType.get(v.leave_type_id) ?? [];
    list.push({
      id: v.id,
      effectiveFrom: v.effective_from,
      effectiveTo: v.effective_to,
      daysPerYear: v.days_per_year,
      carryOverCapDays: v.carry_over_cap_days,
      payPercent: v.pay_percent,
      payMinServiceMonths: v.pay_min_service_months,
    });
    byType.set(v.leave_type_id, list);
  }
  const rows: LeaveTypeRow[] = types.data.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    counting: t.counting === "calendar_days" ? "calendar_days" : "working_days",
    paid: t.paid,
    needsCertificate: t.needs_certificate,
    minServiceMonths: t.min_service_months,
    preset: t.preset === "A" || t.preset === "B" ? t.preset : null,
    sourceLabel: t.source_label,
    status: t.status === "retired" ? "retired" : "active",
    versions: byType.get(t.id) ?? [],
  }));
  rows.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
  return { today: calendar.today, workDays: calendar.workDays, types: rows };
}

/** The version in force today, else the first scheduled one. */
export function currentVersion(type: LeaveTypeRow, today: string): EntitlementVersion | null {
  return versionOn(type.versions, today) ?? type.versions.find((v) => v.effectiveFrom > today) ?? null;
}

/** A year's holidays: the live ones by date, and the removed ones (kept, never deleted). */
export async function loadHolidays(
  supabase: Client,
  organisationId: string,
  year: number,
): Promise<{ live: Holiday[]; removed: Holiday[] }> {
  const { data, error } = await supabase
    .from("public_holidays")
    .select("id, holiday_date, name, removed_at")
    .eq("organisation_id", organisationId)
    .gte("holiday_date", `${year}-01-01`)
    .lte("holiday_date", `${year}-12-31`)
    .order("holiday_date");
  if (error) throw new Error(`Could not load the holidays (${error.code})`);
  const rows = data.map((h) => ({
    id: h.id,
    date: h.holiday_date,
    name: h.name,
    removedAt: h.removed_at,
  }));
  return { live: rows.filter((h) => !h.removedAt), removed: rows.filter((h) => h.removedAt) };
}

/** The company's calendar settings: today and the working week. */
export async function loadCalendar(
  supabase: Client,
  organisationId: string,
): Promise<{ today: string; workDays: number[] }> {
  return companyCalendar(supabase, organisationId);
}

// ---------------------------------------------------------------------------
// Results of the multi-row functions (and their dry runs)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: Json | unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  throw new Error("Unexpected result shape from the database");
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map((v) => asObject(v)) : [];
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function toValues(value: unknown): EntitlementValues | null {
  if (value === null || value === undefined) return null;
  const o = asObject(value);
  return {
    daysPerYear: num(o.days_per_year),
    carryOverCapDays: numOrNull(o.carry_over_cap_days),
    payPercent: num(o.pay_percent),
    payMinServiceMonths: numOrNull(o.pay_min_service_months),
  };
}

export interface HolidayCopyResult {
  fromYear: number;
  toYear: number;
  dryRun: boolean;
  copied: { date: string; name: string }[];
  skipped: { date: string; name: string; reason: string }[];
}

export function toHolidayCopyResult(value: Json): HolidayCopyResult {
  const o = asObject(value);
  return {
    fromYear: num(o.from_year),
    toYear: num(o.to_year),
    dryRun: o.dry_run === true,
    copied: asArray(o.copied).map((c) => ({ date: str(c.date), name: str(c.name) })),
    skipped: asArray(o.skipped).map((s) => ({
      date: str(s.date),
      name: str(s.name),
      reason: str(s.reason),
    })),
  };
}

export interface EntitlementChangeResult {
  leaveTypeId: string;
  name: string;
  effectiveFrom: string;
  first: boolean;
  unchanged: boolean;
  before: EntitlementValues | null;
  after: EntitlementValues;
  replaces: { effectiveFrom: string; daysPerYear: number }[];
}

export function toEntitlementChangeResult(value: Json): EntitlementChangeResult {
  const o = asObject(value);
  return {
    leaveTypeId: str(o.leave_type_id),
    name: str(o.name),
    effectiveFrom: str(o.effective_from),
    first: o.first === true,
    unchanged: o.unchanged === true,
    before: toValues(o.before),
    after: toValues(o.after)!,
    replaces: asArray(o.replaces).map((r) => ({
      effectiveFrom: str(r.effective_from),
      daysPerYear: num(r.days_per_year),
    })),
  };
}

export interface PresetTypeResult {
  code: string;
  name: string;
  action: "create" | "version" | "unchanged";
  detailsChanged: boolean;
  before: EntitlementValues | null;
  after: EntitlementValues & { counting: LeaveCounting; effectiveFrom: string };
}

export interface PresetResult {
  preset: PresetId;
  effectiveFrom: string;
  dryRun: boolean;
  types: PresetTypeResult[];
  kept: { code: string; name: string }[];
}

export function toPresetResult(value: Json): PresetResult {
  const o = asObject(value);
  return {
    preset: o.preset === "A" ? "A" : "B",
    effectiveFrom: str(o.effective_from),
    dryRun: o.dry_run === true,
    types: asArray(o.types).map((t) => {
      const after = asObject(t.after);
      const action = t.action === "create" || t.action === "version" ? t.action : "unchanged";
      return {
        code: str(t.code),
        name: str(t.name),
        action,
        detailsChanged: t.details_changed === true,
        before: toValues(t.before),
        after: {
          ...toValues(after)!,
          counting: after.counting === "calendar_days" ? "calendar_days" : "working_days",
          effectiveFrom: str(after.effective_from),
        },
      };
    }),
    kept: asArray(o.kept).map((k) => ({ code: str(k.code), name: str(k.name) })),
  };
}

/** apply_leave_preset as a dry run: what applying the preset would do. */
export async function previewApplyPreset(
  supabase: Client,
  organisationId: string,
  preset: PresetId,
  effectiveFrom: string | null,
): Promise<PresetResult> {
  const { data, error } = await supabase.rpc("apply_leave_preset", {
    p_organisation_id: organisationId,
    p_preset: preset,
    p_from: effectiveFrom ?? undefined,
    p_dry_run: true,
  });
  if (error) throw error;
  return toPresetResult(data);
}

/** copy_public_holidays as a dry run. */
export async function previewCopyHolidays(
  supabase: Client,
  organisationId: string,
  fromYear: number,
  toYear: number,
): Promise<HolidayCopyResult> {
  const { data, error } = await supabase.rpc("copy_public_holidays", {
    p_organisation_id: organisationId,
    p_from_year: fromYear,
    p_to_year: toYear,
    p_dry_run: true,
  });
  if (error) throw error;
  return toHolidayCopyResult(data);
}

/** add_leave_entitlement_version as a dry run. */
export async function previewEntitlementVersion(
  supabase: Client,
  organisationId: string,
  input: {
    leaveTypeId: string;
    effectiveFrom: string;
    daysPerYear: number;
    carryOverCapDays: number | null;
    payPercent: number;
    payMinServiceMonths: number | null;
  },
): Promise<EntitlementChangeResult> {
  const { data, error } = await supabase.rpc("add_leave_entitlement_version", {
    p_organisation_id: organisationId,
    p_leave_type_id: input.leaveTypeId,
    p_from: input.effectiveFrom,
    p_days_per_year: input.daysPerYear,
    p_pay_percent: input.payPercent,
    p_carry_over_cap_days: input.carryOverCapDays ?? undefined,
    p_pay_min_service_months: input.payMinServiceMonths ?? undefined,
    p_dry_run: true,
  });
  if (error) throw error;
  return toEntitlementChangeResult(data);
}

// ---------------------------------------------------------------------------
// Summary (Lira groundwork)
// ---------------------------------------------------------------------------

export interface LeaveSetupSummary {
  workWeek: string;
  holidaysThisYear: number;
  holidaysNextYear: number;
  types: {
    name: string;
    code: string;
    status: "active" | "retired";
    counting: LeaveCounting;
    daysPerYear: number | null;
    payPercent: number | null;
    preset: PresetId | null;
    scheduled: { effectiveFrom: string; daysPerYear: number }[];
  }[];
}

/** Leave types with today's days, scheduled changes, the working week and holiday counts. */
export async function loadLeaveSetupSummary(
  supabase: Client,
  organisationId: string,
): Promise<LeaveSetupSummary> {
  const setup = await loadLeaveSetup(supabase, organisationId);
  const year = Number(setup.today.slice(0, 4));
  const [thisYear, nextYear] = await Promise.all([
    loadHolidays(supabase, organisationId, year),
    loadHolidays(supabase, organisationId, year + 1),
  ]);
  return {
    workWeek: formatWorkDays(setup.workDays),
    holidaysThisYear: thisYear.live.length,
    holidaysNextYear: nextYear.live.length,
    types: setup.types.map((t) => {
      const now = versionOn(t.versions, setup.today);
      return {
        name: t.name,
        code: t.code,
        status: t.status,
        counting: t.counting,
        daysPerYear: now?.daysPerYear ?? null,
        payPercent: now?.payPercent ?? null,
        preset: t.preset,
        scheduled: t.versions
          .filter((v) => v.effectiveFrom > setup.today)
          .map((v) => ({ effectiveFrom: v.effectiveFrom, daysPerYear: v.daysPerYear })),
      };
    }),
  };
}
