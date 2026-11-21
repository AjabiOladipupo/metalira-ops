import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

import type { ManagerRole } from "@/lib/roles";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";

import {
  toEntitlementChangeResult,
  toHolidayCopyResult,
  toPresetResult,
  type EntitlementChangeResult,
  type HolidayCopyResult,
  type PresetResult,
} from "./leave-setup-data";
import {
  addHolidaySchema,
  applyPresetSchema,
  copyHolidaysSchema,
  createLeaveTypeSchema,
  entitlementVersionSchema,
  removeHolidaySchema,
  saveLeaveTypeSchema,
  workWeekSchema,
} from "./leave-setup-schemas";

/**
 * Leave setup and the company calendar (slice 4.1): public holidays, the working week, leave
 * types, dated entitlement versions and the two presets. Owner, admin and hr, here and in the
 * database (private.require_leave_setup_role). Every write is one SQL function called as the
 * user, audited by the row triggers; the multi-row ones (copy holidays, apply a preset, a new
 * entitlement version) also log a named event and have a dry run for their preview. Registered
 * in src/server/capabilities/registry.ts. Module: people.
 */

export const LEAVE_SETUP_ROLES = ["owner", "admin", "hr"] as const satisfies readonly ManagerRole[];

/** Every manager reads the holiday list; every member reads leave types (RLS). */
export const CALENDAR_READERS = [
  "owner",
  "admin",
  "hr",
  "finance",
  "ops_manager",
  "line_manager",
] as const satisfies readonly ManagerRole[];

export function canEditLeaveSetup(role: ManagerRole): boolean {
  return (LEAVE_SETUP_ROLES as readonly ManagerRole[]).includes(role);
}

/** Database refusals in plain English. */
export function fromLeaveDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Only an owner, an admin or HR can change leave settings.");
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", `${error.message} Reload the page.`);
  }
  if (error.code === "MLLV5") {
    throw new MutationError("invalid", error.message, { name: error.message });
  }
  if (error.code === "MLHD1") {
    throw new MutationError("invalid", error.message, { date: error.message });
  }
  if (error.code === "MLLV1") {
    throw new MutationError("invalid", error.message, { effectiveFrom: error.message });
  }
  if (/^ML(LV|HD)\d$/.test(error.code) || error.code === "22023" || error.code === "23514") {
    throw new MutationError("invalid", error.message);
  }
  if (error.code === "23P01") {
    throw new MutationError("invalid", "Someone changed these days at the same time. Reload and try again.");
  }
  if (error.code === "23505") {
    throw new MutationError("invalid", "That already exists. Reload the page.");
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

// ---------------------------------------------------------------------------
// Holidays and the working week
// ---------------------------------------------------------------------------

export const addHolidaySpec: MutationSpec<typeof addHolidaySchema, { id: string }> = {
  module: "people",
  schema: addHolidaySchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("add_public_holiday", {
      p_organisation_id: organisationId,
      p_date: data.date,
      p_name: data.name,
    });
    if (error) fromLeaveDbError(error);
    return { id: id! };
  },
};

export const removeHolidaySpec: MutationSpec<typeof removeHolidaySchema, void> = {
  module: "people",
  schema: removeHolidaySchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("remove_public_holiday", {
      p_organisation_id: organisationId,
      p_holiday_id: data.holidayId,
    });
    if (error) fromLeaveDbError(error);
  },
};

export const copyHolidaysSpec: MutationSpec<typeof copyHolidaysSchema, HolidayCopyResult> = {
  module: "people",
  schema: copyHolidaysSchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("copy_public_holidays", {
      p_organisation_id: organisationId,
      p_from_year: data.fromYear,
      p_to_year: data.toYear,
      p_dry_run: false,
    });
    if (error) fromLeaveDbError(error);
    return toHolidayCopyResult(result);
  },
};

export const setWorkWeekSpec: MutationSpec<typeof workWeekSchema, { days: number[] }> = {
  module: "people",
  schema: workWeekSchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: days, error } = await supabase.rpc("set_work_week", {
      p_organisation_id: organisationId,
      p_days: data.days,
    });
    if (error) fromLeaveDbError(error);
    return { days: days ?? data.days };
  },
};

// ---------------------------------------------------------------------------
// Leave types, entitlements and presets
// ---------------------------------------------------------------------------

export const createLeaveTypeSpec: MutationSpec<typeof createLeaveTypeSchema, { id: string }> = {
  module: "people",
  schema: createLeaveTypeSchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("save_leave_type", {
      p_organisation_id: organisationId,
      p_name: data.name,
      p_counting: data.counting,
      p_paid: data.paid,
      p_needs_certificate: data.needsCertificate,
      p_min_service_months: data.minServiceMonths,
      p_status: "active",
      p_days_per_year: data.daysPerYear,
      p_carry_over_cap_days: data.carryOverCapDays ?? undefined,
      p_pay_percent: data.payPercent,
    });
    if (error) fromLeaveDbError(error);
    return { id: id! };
  },
};

export const saveLeaveTypeSpec: MutationSpec<typeof saveLeaveTypeSchema, { id: string }> = {
  module: "people",
  schema: saveLeaveTypeSchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("save_leave_type", {
      p_organisation_id: organisationId,
      p_leave_type_id: data.leaveTypeId,
      p_name: data.name,
      p_counting: data.counting,
      p_paid: data.paid,
      p_needs_certificate: data.needsCertificate,
      p_min_service_months: data.minServiceMonths,
      p_status: data.status,
    });
    if (error) fromLeaveDbError(error);
    return { id: id! };
  },
};

export const addEntitlementVersionSpec: MutationSpec<
  typeof entitlementVersionSchema,
  EntitlementChangeResult
> = {
  module: "people",
  schema: entitlementVersionSchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("add_leave_entitlement_version", {
      p_organisation_id: organisationId,
      p_leave_type_id: data.leaveTypeId,
      p_from: data.effectiveFrom,
      p_days_per_year: data.daysPerYear,
      p_pay_percent: data.payPercent,
      p_carry_over_cap_days: data.carryOverCapDays ?? undefined,
      p_pay_min_service_months: data.payMinServiceMonths ?? undefined,
      p_dry_run: false,
    });
    if (error) fromLeaveDbError(error);
    return toEntitlementChangeResult(result);
  },
};

export const applyPresetSpec: MutationSpec<typeof applyPresetSchema, PresetResult> = {
  module: "people",
  schema: applyPresetSchema,
  roles: LEAVE_SETUP_ROLES,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("apply_leave_preset", {
      p_organisation_id: organisationId,
      p_preset: data.preset,
      p_from: data.effectiveFrom ?? undefined,
      p_dry_run: false,
    });
    if (error) fromLeaveDbError(error);
    return toPresetResult(result);
  },
};
