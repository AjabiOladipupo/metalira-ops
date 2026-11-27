import { z } from "zod";

import { formatDate } from "./dates";
import { namesOf, type MappingSnapshot } from "./mapping";

/**
 * Pure, browser-safe pieces of the People list's bulk mapping (slice U.3): the shape the database
 * returns (public.bulk_map_workers, a dry run for the preview, the real run for the confirm) and
 * the words the preview shows per person. The rules themselves live in the single mapping save
 * (public.save_worker_mapping), which the database runs for each person; nothing here decides
 * what changes. No I/O.
 */

export const BULK_MAP_LIMIT = 200;
export const BULK_MAP_PROJECT_LIMIT = 50;

export const BULK_MAP_MODES = ["replace", "add"] as const;
export type BulkMapMode = (typeof BULK_MAP_MODES)[number];

export const BULK_MAP_MODE_TEXT: Record<BulkMapMode, { label: string; hint: string }> = {
  replace: {
    label: "Replace",
    hint: "They work only at this site and these projects from their next shift. Their other site and project assignments close.",
  },
  add: {
    label: "Add",
    hint: "Their current projects stay and these are added. Someone already at another site can't be added; choose Replace to move them.",
  },
};

const namedRef = z.object({ id: z.string(), name: z.string() });

const snapshotSchema = z
  .object({
    department: namedRef.nullable(),
    line_manager: z
      .object({
        kind: z.enum(["worker", "membership"]),
        id: z.string(),
        name: z.string().nullable(),
      })
      .nullable(),
    sites: z.array(namedRef),
    projects: z.array(namedRef),
  })
  .transform((s): MappingSnapshot => ({
    department: s.department,
    lineManager: s.line_manager,
    sites: s.sites,
    projects: s.projects,
  }));

const refusalSchema = z.object({
  worker_id: z.string(),
  name: z.string().nullable(),
  staff_id: z.string().nullable(),
  reason: z.string(),
});

/** A shift at a client's site someone came off when mapped to an office (slice 6.11). */
export const releasedShiftSchema = z.object({
  assignment_id: z.string(),
  shift_date: z.iso.date(),
  site_id: z.string(),
  site_name: z.string().nullable(),
});

/** "Comes off 3 shifts at Apapa Gate from 28 Nov 2026", or null when none. */
export function releasedShiftsText(
  released: readonly { shift_date: string; site_name: string | null }[],
): string | null {
  if (released.length === 0) return null;
  const sites = [...new Set(released.map((r) => r.site_name ?? "a client's site"))].sort();
  const first = [...released].map((r) => r.shift_date).sort()[0]!;
  const n = released.length;
  return `Comes off ${n.toLocaleString("en-NG")} ${n === 1 ? "shift" : "shifts"} at ${sites.join(", ")} from ${formatDate(first)}`;
}

/** What public.bulk_map_workers returns. */
export const bulkMapResultSchema = z.object({
  dry_run: z.boolean(),
  mode: z.enum(BULK_MAP_MODES),
  selected: z.number(),
  changed: z.number(),
  people: z.array(
    z.object({
      worker_id: z.string(),
      name: z.string(),
      staff_id: z.string().nullable(),
      changed: z.boolean(),
      assignments_changed: z.boolean(),
      effective_from: z.iso.date(),
      before: snapshotSchema,
      after: snapshotSchema,
      // Slice 6.11: shifts at clients' sites they come off when mapped to an office.
      released_shifts: z.array(releasedShiftSchema).default([]),
    }),
  ),
  refusals: z.array(refusalSchema),
});

export type BulkMapResult = z.infer<typeof bulkMapResultSchema>;

/** One person in the preview: their site and projects now and after, or why they can't move. */
export interface BulkMapRow {
  workerId: string;
  name: string | null;
  staffId: string | null;
  before: { sites: string; projects: string } | null;
  after: { sites: string; projects: string } | null;
  /** The day the new site and project rows start (the single save's next shift), or null. */
  effectiveFrom: string | null;
  /** False when they are already mapped exactly so. */
  changed: boolean;
  refusal: string | null;
  /** Slice 6.11: the client shifts they come off when mapped to an office, or null. */
  releasedShifts?: string | null;
}

const sitesText = (s: MappingSnapshot) => namesOf(s.sites, "No site");
const projectsText = (s: MappingSnapshot) => namesOf(s.projects, "No projects");

/** The preview rows: refused people first (they block the confirm), then everyone by name. */
export function bulkMapRows(result: BulkMapResult): BulkMapRow[] {
  const refused: BulkMapRow[] = result.refusals.map((r) => ({
    workerId: r.worker_id,
    name: r.name,
    staffId: r.staff_id,
    before: null,
    after: null,
    effectiveFrom: null,
    changed: false,
    refusal: r.reason,
  }));
  const mapped: BulkMapRow[] = result.people.map((p) => ({
    workerId: p.worker_id,
    name: p.name,
    staffId: p.staff_id,
    before: { sites: sitesText(p.before), projects: projectsText(p.before) },
    after: { sites: sitesText(p.after), projects: projectsText(p.after) },
    effectiveFrom: p.assignments_changed ? p.effective_from : null,
    changed: p.changed,
    refusal: null,
    releasedShifts: releasedShiftsText(p.released_shifts),
  }));
  const byName = (a: BulkMapRow, b: BulkMapRow) =>
    (a.name ?? "~").localeCompare(b.name ?? "~", "en", { sensitivity: "base" }) ||
    (a.staffId ?? "").localeCompare(b.staffId ?? "");
  return [...refused.sort(byName), ...mapped.sort(byName)];
}

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;

/** The line above the preview list. */
export function bulkMapSummary(rows: readonly BulkMapRow[], siteName: string): string {
  const refused = rows.filter((r) => r.refusal).length;
  if (refused > 0) {
    return `${people(refused)} of ${rows.length} can't be mapped, so nobody will be. Take them out of the selection, or choose Replace, and preview again.`;
  }
  const changing = rows.filter((r) => r.changed).length;
  if (changing === 0) {
    return rows.length === 1
      ? "This person is already mapped this way."
      : `All ${rows.length.toLocaleString("en-NG")} people are already mapped this way.`;
  }
  const unchanged = rows.length - changing;
  return `Maps ${people(changing)} to ${siteName}${unchanged > 0 ? `; ${people(unchanged)} already mapped this way` : ""}.`;
}

/** "From 26 Nov 2026", "No change" or the refusal, for one row. */
export function bulkMapWhen(row: BulkMapRow): string {
  if (row.refusal) return row.refusal;
  if (!row.changed) return "No change";
  return row.effectiveFrom ? `From ${formatDate(row.effectiveFrom)}` : "From now";
}
