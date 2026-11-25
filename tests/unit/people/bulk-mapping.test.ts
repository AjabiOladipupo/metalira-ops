import { describe, expect, it } from "vitest";

import {
  BULK_MAP_MODE_TEXT,
  bulkMapResultSchema,
  bulkMapRows,
  bulkMapSummary,
  bulkMapWhen,
} from "@/lib/bulk-mapping";

/**
 * Slice U.3: the preview of "Map to site and project" is built from what the database's dry run
 * returns (public.bulk_map_workers, which runs the single mapping save for each person). These
 * check the rows and words built from it, for Replace and Add results.
 */

const apapa = { id: "site-apapa", name: "Apapa Gate" };
const lekki = { id: "site-lekki", name: "Lekki Estate" };
const night = { id: "proj-night", name: "Night patrol" };
const day = { id: "proj-day", name: "Day patrol" };
const dept = { id: "dept-1", name: "Security services" };
const lm = { kind: "membership", id: "m-1", name: "Kola Adebayo" };

function snapshot(sites: { id: string; name: string }[], projects: { id: string; name: string }[]) {
  return { department: dept, line_manager: lm, sites, projects };
}

function person(
  name: string,
  before: ReturnType<typeof snapshot>,
  after: ReturnType<typeof snapshot>,
  changed = true,
) {
  return {
    worker_id: `w-${name}`,
    name,
    staff_id: `ST-${name.slice(0, 3)}`,
    changed,
    assignments_changed: changed,
    effective_from: "2026-11-26",
    before,
    after,
  };
}

describe("bulk mapping preview", () => {
  it("Replace: lists each person's site and projects now and after, from the next shift", () => {
    const result = bulkMapResultSchema.parse({
      dry_run: true,
      mode: "replace",
      selected: 2,
      changed: 2,
      people: [
        person("Bola Ade", snapshot([lekki], [day]), snapshot([apapa], [night])),
        person("Ada Obi", snapshot([], []), snapshot([apapa], [night])),
      ],
      refusals: [],
    });
    const rows = bulkMapRows(result);
    expect(rows.map((r) => r.name)).toEqual(["Ada Obi", "Bola Ade"]);
    expect(rows[0]).toMatchObject({
      before: { sites: "No site", projects: "No projects" },
      after: { sites: "Apapa Gate", projects: "Night patrol" },
      effectiveFrom: "2026-11-26",
      refusal: null,
    });
    expect(rows[1]).toMatchObject({
      before: { sites: "Lekki Estate", projects: "Day patrol" },
      after: { sites: "Apapa Gate", projects: "Night patrol" },
    });
    expect(bulkMapWhen(rows[1]!)).toBe("From 26 Nov 2026");
    expect(bulkMapSummary(rows, "Apapa Gate")).toBe("Maps 2 people to Apapa Gate.");
    // The snapshot's line manager reads as the email and audit expect it.
    expect(result.people[0]!.after.lineManager).toEqual(lm);
  });

  it("Add: keeps current projects; someone at another site is refused and blocks the batch", () => {
    const result = bulkMapResultSchema.parse({
      dry_run: true,
      mode: "add",
      selected: 3,
      changed: 1,
      people: [
        person("Chika Eze", snapshot([apapa], [day]), snapshot([apapa], [day, night])),
        person("Dayo Ola", snapshot([apapa], [night]), snapshot([apapa], [night]), false),
      ],
      refusals: [
        {
          worker_id: "w-elsewhere",
          name: "Emeka Nna",
          staff_id: "ST-Eme",
          reason:
            "Works at Lekki Estate. A person works at one site, so choose Replace to move them.",
        },
      ],
    });
    const rows = bulkMapRows(result);
    // Refused people first, so the reason is the first thing read.
    expect(rows.map((r) => r.name)).toEqual(["Emeka Nna", "Chika Eze", "Dayo Ola"]);
    expect(rows[0]).toMatchObject({ before: null, after: null, changed: false });
    expect(bulkMapWhen(rows[0]!)).toMatch(/^Works at Lekki Estate\./);
    expect(rows[1]!.after).toEqual({ sites: "Apapa Gate", projects: "Day patrol, Night patrol" });
    expect(bulkMapWhen(rows[2]!)).toBe("No change");
    expect(bulkMapSummary(rows, "Apapa Gate")).toBe(
      "1 person of 3 can't be mapped, so nobody will be. Take them out of the selection, or choose Replace, and preview again.",
    );
    // Without the refusal: one maps, one is already mapped this way.
    expect(bulkMapSummary(rows.slice(1), "Apapa Gate")).toBe(
      "Maps 1 person to Apapa Gate; 1 person already mapped this way.",
    );
    expect(bulkMapSummary(rows.slice(2), "Apapa Gate")).toBe(
      "This person is already mapped this way.",
    );
  });

  it("refuses a result it doesn't recognise", () => {
    expect(() =>
      bulkMapResultSchema.parse({
        dry_run: true,
        mode: "move",
        selected: 0,
        changed: 0,
        people: [],
        refusals: [],
      }),
    ).toThrow();
  });

  it("says what each mode does in plain words", () => {
    expect(BULK_MAP_MODE_TEXT.replace.label).toBe("Replace");
    expect(BULK_MAP_MODE_TEXT.add.label).toBe("Add");
    for (const text of Object.values(BULK_MAP_MODE_TEXT)) {
      expect(text.hint).not.toMatch(/[!]/);
    }
  });
});
