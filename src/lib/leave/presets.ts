/**
 * The leave presets (slice 4.1; docs/RULES_NIGERIA.md "Leave presets (Phase 4)"). Pure.
 *
 * Owner decision, 21 Nov 2026: two presets, A "Labour Act minimum" and B "Common private-sector
 * practice"; preset C (public-service aligned) was dropped after review. The figures here match
 * RULES_NIGERIA.md exactly (tests/unit/leave/presets.test.ts compares them) and the database's
 * private.leave_preset_rows (the RLS suite compares those). They are starting values a company
 * edits, never legal advice.
 */

export type PresetId = "A" | "B";

export const PRESET_IDS: readonly PresetId[] = ["A", "B"];

export type LeaveCounting = "working_days" | "calendar_days";

export interface PresetType {
  /** Stable code: applying a preset finds the company's type by it. */
  code: string;
  name: string;
  counting: LeaveCounting;
  paid: boolean;
  needsCertificate: boolean;
  /** Months of service before the type can be requested. */
  minServiceMonths: number;
  daysPerYear: number;
  /** Whole percent of wages paid during the leave (Phase 5 pays it). */
  payPercent: number;
  /** Months of continuous service the pay needs, or null when it needs none. */
  payMinServiceMonths: number | null;
  /** Where the figure came from, shown beside it. */
  sourceLabel: string;
  /** One plain line for the preset card. */
  summary: string;
}

export interface Preset {
  id: PresetId;
  name: string;
  /** Where the preset's figures come from, in one or two sentences. */
  source: string;
  types: readonly PresetType[];
  /** Leave the preset deliberately leaves out, for the card ("No paternity or compassionate"). */
  none: string | null;
}

/** On every preset card and wherever a preset figure is shown. Never presented as advice. */
export const ADVISER_LINE =
  "These are starting values, not legal advice. Confirm them with an adviser.";

export const PRESETS: readonly Preset[] = [
  {
    id: "A",
    name: "Labour Act minimum",
    source:
      "Labour Act, Cap L1 LFN 2004: s.18 and s.16 as summarised by DLA Piper, WageIndicator and Chambers; s.54 read on the jurist.ng mirror, a third-party copy, not the official gazette.",
    none: "No paternity or compassionate leave: the Act gives none.",
    types: [
      {
        code: "annual",
        name: "Annual",
        counting: "working_days",
        paid: true,
        needsCertificate: false,
        minServiceMonths: 12,
        daysPerYear: 6,
        payPercent: 100,
        payMinServiceMonths: null,
        sourceLabel: "Labour Act s.18, as summarised by DLA Piper, WageIndicator and Chambers",
        summary: "6 working days after 12 months' service",
      },
      {
        code: "sick",
        name: "Sick",
        counting: "working_days",
        paid: true,
        needsCertificate: true,
        minServiceMonths: 0,
        daysPerYear: 12,
        payPercent: 100,
        payMinServiceMonths: null,
        sourceLabel: "Labour Act s.16, as summarised by WageIndicator and DLA Piper",
        summary: "Up to 12 paid working days a year, with a medical certificate",
      },
      {
        code: "maternity",
        name: "Maternity",
        counting: "calendar_days",
        paid: true,
        needsCertificate: true,
        minServiceMonths: 0,
        daysPerYear: 84,
        payPercent: 50,
        payMinServiceMonths: 6,
        sourceLabel: "Labour Act s.54(1), text read on the jurist.ng mirror",
        summary:
          "12 weeks, 6 before and 6 after the birth; at least 50% pay after 6 months' service",
      },
    ],
  },
  {
    id: "B",
    name: "Common private-sector practice",
    source:
      "Market practice described by Chambers Employment 2025 (Nigeria), the Payoneer Nigeria leave policy guide and the CXC Nigeria employment guide. Not a statute.",
    none: null,
    types: [
      {
        code: "annual",
        name: "Annual",
        counting: "working_days",
        paid: true,
        needsCertificate: false,
        minServiceMonths: 0,
        daysPerYear: 15,
        payPercent: 100,
        payMinServiceMonths: null,
        sourceLabel: "Common private-sector practice (Payoneer, CXC)",
        summary: "15 working days",
      },
      {
        code: "sick",
        name: "Sick",
        counting: "working_days",
        paid: true,
        needsCertificate: true,
        minServiceMonths: 0,
        daysPerYear: 12,
        payPercent: 100,
        payMinServiceMonths: null,
        sourceLabel: "Labour Act figure, commonly kept (WageIndicator)",
        summary: "12 working days, with a medical certificate",
      },
      {
        code: "maternity",
        name: "Maternity",
        counting: "calendar_days",
        paid: true,
        needsCertificate: true,
        minServiceMonths: 0,
        daysPerYear: 84,
        payPercent: 100,
        payMinServiceMonths: null,
        sourceLabel: "Common private-sector practice (Payoneer, CXC)",
        summary: "12 weeks on full pay",
      },
      {
        code: "paternity",
        name: "Paternity",
        counting: "working_days",
        paid: true,
        needsCertificate: false,
        minServiceMonths: 0,
        daysPerYear: 5,
        payPercent: 100,
        payMinServiceMonths: null,
        sourceLabel: "Common private-sector practice (Payoneer, CXC)",
        summary: "5 working days",
      },
      {
        code: "compassionate",
        name: "Compassionate",
        counting: "working_days",
        paid: true,
        needsCertificate: false,
        minServiceMonths: 0,
        daysPerYear: 3,
        payPercent: 100,
        payMinServiceMonths: null,
        sourceLabel: "Common private-sector practice (CXC)",
        summary: "3 working days",
      },
    ],
  },
];

export function isPresetId(value: unknown): value is PresetId {
  return value === "A" || value === "B";
}

export function findPreset(id: PresetId): Preset {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`No preset ${id}`);
  return preset;
}
