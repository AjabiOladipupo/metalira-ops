/**
 * Business type and module switches (slice 3.0). Isomorphic: the nav, the setup wizard, the
 * Modules settings form and the worker app read these; the database repeats every rule
 * (migration 20261120100000_business_type_modules).
 */

export const BUSINESS_TYPES = [
  {
    id: "workforce",
    label: "We run staff at client sites",
    hint: "Guards, cleaners, field teams or outsourced staff on rosters.",
  },
  {
    id: "services",
    label: "We deliver services or projects to clients",
    hint: "Agencies, consultants, freelancers and sole proprietors who invoice clients.",
  },
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number]["id"];

export const BUSINESS_TYPE_IDS = BUSINESS_TYPES.map((t) => t.id) as [
  BusinessType,
  ...BusinessType[],
];

export function isBusinessType(value: unknown): value is BusinessType {
  return value === "workforce" || value === "services";
}

export const MODULES = [
  {
    id: "shifts",
    name: "Shifts",
    body: "Rosters, clock-in on the worker app and live attendance.",
  },
  {
    id: "people",
    name: "People",
    body: "Your employees, their teams, leave and timesheets.",
  },
  {
    id: "payroll",
    name: "Payroll",
    body: "Monthly pay runs, payslips and the bank file for your bank.",
  },
] as const;

export type ModuleId = (typeof MODULES)[number]["id"];

export type Modules = Record<ModuleId, boolean>;

export const ALL_MODULES_ON: Modules = { shifts: true, people: true, payroll: true };

export function moduleName(id: ModuleId): string {
  return MODULES.find((m) => m.id === id)?.name ?? id;
}

/** The switches a new company of this type starts with (and gets again if setup changes type). */
export function defaultModules(type: BusinessType): Modules {
  const on = type === "workforce";
  return { shifts: on, people: on, payroll: on };
}

/** Why a set of switches can't be saved, in the database's words, or null when it can. */
export function modulesProblem(modules: Modules): string | null {
  if (modules.payroll && !modules.people) {
    return "Payroll needs People. Turn People on, or turn Payroll off.";
  }
  if (modules.shifts && !modules.people) {
    return "Shifts need People. Turn People on, or turn Shifts off.";
  }
  return null;
}

/** Modules on in `before` and off in `after`, in MODULES order. */
export function modulesTurnedOff(before: Modules, after: Modules): ModuleId[] {
  return MODULES.map((m) => m.id).filter((id) => before[id] && !after[id]);
}

/** Modules off in `before` and on in `after`, in MODULES order. */
export function modulesTurnedOn(before: Modules, after: Modules): ModuleId[] {
  return MODULES.map((m) => m.id).filter((id) => !before[id] && after[id]);
}

function list(ids: ModuleId[]): string {
  const names = ids.map(moduleName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * One sentence, numbers first, saying what a change of switches does: the Modules form's confirm
 * step and the capability preview both show it.
 */
export function describeModulesChange(before: Modules, after: Modules): string {
  const off = modulesTurnedOff(before, after);
  const on = modulesTurnedOn(before, after);
  if (off.length === 0 && on.length === 0) return "Nothing changes.";
  const parts: string[] = [];
  if (off.length > 0) {
    parts.push(
      `Turns off ${off.length} ${off.length === 1 ? "part" : "parts"}: ${list(off)}. Their pages leave the menu and nothing is deleted; turning ${off.length === 1 ? "it" : "them"} back on shows everything again.`,
    );
  }
  if (on.length > 0) {
    parts.push(`Turns on ${on.length} ${on.length === 1 ? "part" : "parts"}: ${list(on)}.`);
  }
  return parts.join(" ");
}
