import "server-only";

import { MODULES, describeModulesChange, type Modules } from "@/lib/modules";
import type { modulesSchema } from "@/server/identity/company";

import type { PreviewFn } from "./types";

/**
 * Preview for switching parts of the app on or off (slice 3.0). The same sentence the Modules
 * form's confirm step shows (`describeModulesChange`); the database checks everything again.
 */
export const previewSetModules: PreviewFn<typeof modulesSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const { data: row, error } = await supabase
    .from("organisations")
    .select("shifts_enabled, people_enabled, payroll_enabled")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the company: ${error.message}`);
  if (!row) return { summary: "That company wasn't found.", changes: [] };
  const before: Modules = {
    shifts: row.shifts_enabled,
    people: row.people_enabled,
    payroll: row.payroll_enabled,
  };
  const after: Modules = { shifts: data.shifts, people: data.people, payroll: data.payroll };
  const onOff = (on: boolean) => (on ? "On" : "Off");
  return {
    summary: describeModulesChange(before, after),
    changes: MODULES.filter((m) => before[m.id] !== after[m.id]).map((m) => ({
      label: m.name,
      before: onOff(before[m.id]),
      after: onOff(after[m.id]),
    })),
  };
};
