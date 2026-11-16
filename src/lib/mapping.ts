/**
 * Pure, browser-safe rules for mapping (slice 1.6): a worker's department, line manager, site
 * and projects as one snapshot, and what changed between two snapshots, in the words the panel,
 * the audit trail and the line manager's email use. No I/O.
 */

export interface NamedRef {
  id: string;
  name: string;
}

export interface LineManagerSnapshot {
  kind: "worker" | "membership";
  id: string;
  /** Null when a manager-app user has no name on their profile yet. */
  name: string | null;
}

/** The mapping as it stands: every assignment that has not ended by the end of today. */
export interface MappingSnapshot {
  department: NamedRef | null;
  lineManager: LineManagerSnapshot | null;
  sites: NamedRef[];
  projects: NamedRef[];
}

export const EMPTY_MAPPING: MappingSnapshot = {
  department: null,
  lineManager: null,
  sites: [],
  projects: [],
};

export type MappingField = "Department" | "Line manager" | "Site" | "Projects";

export interface MappingChange {
  field: MappingField;
  before: string;
  after: string;
}

/** "Apapa Warehouse 3, Lekki Estate Gate B", or `none` for an empty list. */
export function namesOf(list: readonly NamedRef[], none = "None"): string {
  if (list.length === 0) return none;
  return [...list]
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
    .join(", ");
}

function sameIds(a: readonly NamedRef[], b: readonly NamedRef[]): boolean {
  const left = new Set(a.map((item) => item.id));
  const right = new Set(b.map((item) => item.id));
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function lineManagerName(lm: LineManagerSnapshot | null): string {
  if (!lm) return "Not set";
  return lm.name?.trim() || "A manager";
}

/** The fields that differ between two snapshots, in panel order. Ids decide; names are shown. */
export function mappingChanges(before: MappingSnapshot, after: MappingSnapshot): MappingChange[] {
  const changes: MappingChange[] = [];
  if (before.department?.id !== after.department?.id) {
    changes.push({
      field: "Department",
      before: before.department?.name ?? "Not set",
      after: after.department?.name ?? "Not set",
    });
  }
  if (
    before.lineManager?.kind !== after.lineManager?.kind ||
    before.lineManager?.id !== after.lineManager?.id
  ) {
    changes.push({
      field: "Line manager",
      before: lineManagerName(before.lineManager),
      after: lineManagerName(after.lineManager),
    });
  }
  if (!sameIds(before.sites, after.sites)) {
    changes.push({
      field: "Site",
      before: namesOf(before.sites, "Not set"),
      after: namesOf(after.sites, "Not set"),
    });
  }
  if (!sameIds(before.projects, after.projects)) {
    changes.push({
      field: "Projects",
      before: namesOf(before.projects),
      after: namesOf(after.projects),
    });
  }
  return changes;
}

/** "Site: Lekki Estate Gate B (was Apapa Warehouse 3)". */
export function describeChange(change: MappingChange): string {
  return `${change.field}: ${change.after} (was ${change.before})`;
}
