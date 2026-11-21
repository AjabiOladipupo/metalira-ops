/**
 * Slice 4.1: the leave presets in src/lib/leave/presets.ts match docs/RULES_NIGERIA.md "Leave
 * presets (Phase 4)" exactly (its "App values" tables), there are two of them (owner decision,
 * 21 Nov 2026: preset C dropped), and every preset carries the adviser line. The database's
 * private.leave_preset_rows is compared with the same file in tests/rls/leave-setup.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ADVISER_LINE, PRESETS, PRESET_IDS, findPreset, isPresetId } from "@/lib/leave/presets";

const rules = readFileSync(path.join(process.cwd(), "docs", "RULES_NIGERIA.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const section = rules.slice(rules.indexOf("## Leave presets (Phase 4)"));

/** Rows of the "App values, preset X:" table, keyed like presets.ts. */
function appValues(id: string) {
  const start = section.indexOf(`App values, preset ${id}:`);
  expect(start, `App values table for preset ${id}`).toBeGreaterThan(-1);
  const after = section.slice(start).split("\n").slice(1);
  const table: string[] = [];
  for (const raw of after) {
    const line = raw.trim();
    if (line.startsWith("|")) table.push(line);
    else if (table.length > 0) break;
  }
  return table.slice(2).map((row) => {
    const c = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(c).toHaveLength(9);
    return {
      code: c[0],
      name: c[1],
      counting: c[2],
      daysPerYear: Number(c[3]),
      paid: c[4] === "yes",
      payPercent: Number(c[5]),
      minServiceMonths: Number(c[6]),
      payMinServiceMonths: c[7] === "-" ? null : Number(c[7]),
      needsCertificate: c[8] === "yes",
    };
  });
}

describe("leave presets", () => {
  it("offers exactly presets A and B", () => {
    expect(PRESET_IDS).toEqual(["A", "B"]);
    expect(PRESETS.map((p) => p.id)).toEqual(["A", "B"]);
    expect(isPresetId("C")).toBe(false);
    expect(section).toContain('Preset C ("Public-service aligned") was dropped by the owner');
    expect(section).not.toMatch(/^### Preset C/m);
  });

  it.each(["A", "B"] as const)("preset %s matches RULES_NIGERIA.md's app values", (id) => {
    const fromCode = findPreset(id).types.map((t) => ({
      code: t.code,
      name: t.name,
      counting: t.counting,
      daysPerYear: t.daysPerYear,
      paid: t.paid,
      payPercent: t.payPercent,
      minServiceMonths: t.minServiceMonths,
      payMinServiceMonths: t.payMinServiceMonths,
      needsCertificate: t.needsCertificate,
    }));
    expect(fromCode).toEqual(appValues(id));
  });

  it("names each preset as the doc does", () => {
    expect(section).toContain('### Preset A, "Labour Act minimum"');
    expect(section).toContain('### Preset B, "Common private-sector practice"');
    expect(findPreset("A").name).toBe("Labour Act minimum");
    expect(findPreset("B").name).toBe("Common private-sector practice");
  });

  it("carries the adviser line and a source on every preset and figure", () => {
    expect(ADVISER_LINE).toBe(
      "These are starting values, not legal advice. Confirm them with an adviser.",
    );
    expect(section).toContain(ADVISER_LINE);
    for (const preset of PRESETS) {
      expect(preset.source.length).toBeGreaterThan(20);
      for (const t of preset.types) {
        expect(t.sourceLabel.length, `${preset.id} ${t.code}`).toBeGreaterThan(5);
        expect(t.sourceLabel).not.toMatch(/(:\/\/|www\.|[<>])/);
        expect(t.sourceLabel.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("keeps preset A's statutory figures (Labour Act s.18, s.16, s.54)", () => {
    const a = Object.fromEntries(findPreset("A").types.map((t) => [t.code, t]));
    expect(Object.keys(a)).toEqual(["annual", "sick", "maternity"]);
    expect(a.annual).toMatchObject({ daysPerYear: 6, minServiceMonths: 12 });
    expect(a.sick).toMatchObject({ daysPerYear: 12, needsCertificate: true });
    expect(a.maternity).toMatchObject({
      counting: "calendar_days",
      daysPerYear: 84,
      payPercent: 50,
      payMinServiceMonths: 6,
      minServiceMonths: 0,
    });
    expect(section).toContain("https://jurist.ng/labour_act/sec-54");
    expect(section).toContain("s. 54(4)");
  });
});
