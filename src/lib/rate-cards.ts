/**
 * Dated rate cards (slice 2.4). Pure: no database, no clock. Isomorphic, because the rate card
 * editor shows the same preview in the browser that the server and the ops agent's confirmation
 * card use (docs/PHASE_2.md 2.4; the database repeats every dating rule in
 * migration 20261119130000_contracts_rate_cards).
 *
 * - Amounts are `bigint` kobo (CLAUDE.md rule 1). They come in as text through `parseNairaToKobo`
 *   and are formatted only at the edge.
 * - Rates are VAT-exclusive (owner decision 3).
 * - A rate line is found by its rate key (role, band, unit), ignoring case, never by id, so a new
 *   version never touches posts (owner decision 5).
 * - No billing arithmetic here: pricing a Work Unit is Phase 6.
 */

import { addDays, formatDate, isWithin } from "@/lib/dates";
import { formatNaira, parseNairaToKobo, roundHalfUp, type Currency, type Kobo } from "@/lib/money";

export const RATE_UNITS = ["shift", "hour", "visit", "month", "job"] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

export const RATE_UNIT_LABELS: Record<RateUnit, string> = {
  shift: "Shift",
  hour: "Hour",
  visit: "Visit",
  month: "Month",
  job: "Job",
};

/** "₦12,500 a shift". */
const PER_UNIT: Record<RateUnit, string> = {
  shift: "a shift",
  hour: "an hour",
  visit: "a visit",
  month: "a month",
  job: "a job",
};

export const STANDARD_BAND = "standard";

/**
 * What a line pays for, which sets its withholding tax (owner's accountant, 19 Nov 2026). Split
 * facility management into service lines and a separate management fee line.
 */
export const SERVICE_TYPES = ["services", "management_fee", "rent_hire", "goods", "other"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  services: "Services",
  management_fee: "Management fee",
  rent_hire: "Rent or hire",
  goods: "Goods",
  other: "Other",
};

/**
 * The WHT rate each service type starts with, in basis points (the database's
 * private.default_wht_rate_bps gives the same): services 2%, management fee 5%, rent or hire 10%,
 * goods 2%, other 2%. A person may change it per line.
 */
export const DEFAULT_WHT_BPS: Record<ServiceType, number> = {
  services: 200,
  management_fee: 500,
  rent_hire: 1000,
  goods: 200,
  other: 200,
};

/** ₦1,000,000,000 in kobo: the largest rate a line takes (the database checks it too). */
export const MAX_RATE_KOBO = 100_000_000_000n;
export const MAX_RATE_LINES = 100;

export interface RateLine {
  role: string;
  /** `standard` when the role has one rate; otherwise Day, Night, Supervisor... */
  band: string;
  unit: RateUnit;
  rateKobo: Kobo;
  currency: Currency;
  /** The line's own overtime rate per hour, or null. */
  otRateKobo: Kobo | null;
  /** 15000 = 1.5×: an entry helper. On hourly lines it gives otRateKobo; elsewhere display only. */
  otMultiplierBps: number | null;
  serviceType: ServiceType;
  /** The WHT the client deducts on this line, on its amount before VAT (Phase 6). */
  whtRateBps: number;
}

export interface RateCardVersion {
  id: string;
  effectiveFrom: string;
  /** Null means until the contract ends. */
  effectiveTo: string | null;
  note: string | null;
  lines: RateLine[];
}

/** Only the dates matter for planning. */
export type DatedVersion = Pick<RateCardVersion, "id" | "effectiveFrom" | "effectiveTo">;

export interface RateKey {
  role: string;
  band: string;
  unit: RateUnit;
}

// ---------------------------------------------------------------------------
// Keys and look-ups
// ---------------------------------------------------------------------------

/**
 * Whitespace a rate key ignores: ASCII spaces and controls, no-break and other Unicode spaces,
 * zero-width space and BOM. The SQL twin `private.rate_key_part` (migration
 * 20261119140000_headcount) uses the same list, so the screens and activation always agree.
 */
const KEY_SPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu;

/**
 * One part of a rate key (role or band) as it is compared: runs of whitespace (Unicode spaces
 * included) become one space, the ends are trimmed and only A–Z are lower-cased. ASCII-only
 * case folding is deterministic in JavaScript and in Postgres whatever the collation:
 * "Agent de sécurité" matches "AGENT DE SéCURITé" but not "AGENT DE SÉCURITÉ".
 */
export function normaliseKeyPart(text: string): string {
  return text
    .replace(KEY_SPACE, " ")
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The rate key as one comparable string (`normaliseKeyPart` on role and band). */
export function rateKeyId(key: RateKey): string {
  const band = normaliseKeyPart(key.band) || STANDARD_BAND;
  return `${normaliseKeyPart(key.role)}|${band}|${key.unit}`;
}

/** "Guard · Night (shift)", or "Guard (shift)" for the standard band. */
export function formatRateKey(key: RateKey): string {
  const band = key.band.trim().toLowerCase() === STANDARD_BAND ? "" : ` · ${key.band.trim()}`;
  return `${key.role.trim()}${band} (${key.unit})`;
}

export function findRateLine(
  version: Pick<RateCardVersion, "lines"> | null,
  key: RateKey,
): RateLine | null {
  if (!version) return null;
  const id = rateKeyId(key);
  return version.lines.find((line) => rateKeyId(line) === id) ?? null;
}

/** The keys (headcount rows, open posts) that have no line in `version`, each once. */
export function missingRateKeys(
  keys: readonly RateKey[],
  version: Pick<RateCardVersion, "lines"> | null,
): RateKey[] {
  const seen = new Set<string>();
  const missing: RateKey[] = [];
  for (const key of keys) {
    const id = rateKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!findRateLine(version, key)) missing.push(key);
  }
  return missing;
}

/** Keys that appear more than once in `lines`; a version takes each key once. */
export function duplicateRateKeys(lines: readonly RateKey[]): RateKey[] {
  const first = new Map<string, RateKey>();
  const duplicates: RateKey[] = [];
  for (const line of lines) {
    const id = rateKeyId(line);
    const earlier = first.get(id);
    // Named as first written, so the message matches what the person sees at the top.
    if (earlier) duplicates.push(earlier);
    else first.set(id, line);
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Dating
// ---------------------------------------------------------------------------

function byStart<T extends DatedVersion>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

/**
 * The version in force on `date`, or null. Pass the contract's end date: a version left open
 * (`effectiveTo` null) still ends with the contract, so nothing is in force after it.
 */
export function rateCardInForce<T extends DatedVersion>(
  versions: readonly T[],
  date: string,
  contractEndDate: string | null = null,
): T | null {
  if (contractEndDate !== null && date > contractEndDate) return null;
  return versions.find((v) => isWithin(date, v.effectiveFrom, v.effectiveTo)) ?? null;
}

export type VersionState = "scheduled" | "in_force" | "ended";

/** Where a version stands on `today`. */
export function versionState(version: DatedVersion, today: string): VersionState {
  if (version.effectiveFrom > today) return "scheduled";
  if (version.effectiveTo !== null && version.effectiveTo < today) return "ended";
  return "in_force";
}

/**
 * Whether a version may still be changed. On a draft contract nothing has used the card, so
 * anything goes (the draft card is replaced whole). Once the contract is live, only a version
 * that hasn't started may change (cancelled and added again); one in force or in the past is
 * frozen except for closing its end date.
 */
export function versionIsFrozen(
  version: DatedVersion,
  today: string,
  contractStatus: ContractStatusLike,
): boolean {
  if (contractStatus === "draft") return false;
  return version.effectiveFrom <= today;
}

export type ContractStatusLike = "draft" | "active" | "ended";

export interface ContractDates {
  status: ContractStatusLike;
  startDate: string;
  endDate: string | null;
}

export type VersionPlan =
  | {
      ok: true;
      /** The version that ends the day before the new one starts. */
      closes: {
        id: string;
        effectiveFrom: string;
        effectiveToBefore: string | null;
        effectiveToAfter: string;
      };
      /** The new version. It ends where the closed one used to end. */
      starts: { effectiveFrom: string; effectiveTo: string | null };
    }
  | { ok: false; reason: string };

/**
 * "Change rates from `from`": the version to close the day before and the new one, or the reason
 * the database will refuse it. The same rules as `add_rate_card_version` (and the WHT rates):
 * - there is a version already (the first one is saved with the draft card);
 * - nothing starts on `from` or later (cancel that version first);
 * - on a live contract `from` is today or later (backdating waits for Phase 6);
 * - `from` sits inside the contract's dates.
 */
export function planNewVersion(
  versions: readonly DatedVersion[],
  from: string,
  today: string,
  contract: ContractDates,
): VersionPlan {
  if (contract.status === "ended") {
    return { ok: false, reason: "This contract has ended and its rates can't change." };
  }
  const sorted = byStart(versions);
  const latest = sorted[sorted.length - 1];
  if (!latest) {
    return { ok: false, reason: "This contract has no rate card yet. Add the first one." };
  }
  if (sorted.some((v) => v.effectiveFrom >= from)) {
    return {
      ok: false,
      reason: "A rate card from this date or later already exists. Cancel it first.",
    };
  }
  if (contract.status !== "draft" && from < today) {
    return { ok: false, reason: "A rate change starts today or later." };
  }
  if (from < contract.startDate || (contract.endDate !== null && from > contract.endDate)) {
    return { ok: false, reason: "The new rates must start inside the contract's dates." };
  }
  return {
    ok: true,
    closes: {
      id: latest.id,
      effectiveFrom: latest.effectiveFrom,
      effectiveToBefore: latest.effectiveTo,
      effectiveToAfter: addDays(from, -1),
    },
    starts: { effectiveFrom: from, effectiveTo: latest.effectiveTo },
  };
}

export type CancelPlan =
  | {
      ok: true;
      /** The version before it, reopened to where the cancelled one ended. */
      reopens: { id: string; effectiveToAfter: string | null } | null;
    }
  | { ok: false; reason: string };

/** Taking back a version: only the latest, and on a live contract only before it starts. */
export function planCancelVersion(
  versions: readonly DatedVersion[],
  id: string,
  today: string,
  contract: Pick<ContractDates, "status">,
): CancelPlan {
  const sorted = byStart(versions);
  const index = sorted.findIndex((v) => v.id === id);
  const target = sorted[index];
  if (!target) return { ok: false, reason: "That rate card wasn't found." };
  if (index !== sorted.length - 1) {
    return {
      ok: false,
      reason: "A later rate change is scheduled after this one. Cancel that one first.",
    };
  }
  const previous = sorted[index - 1] ?? null;
  if (contract.status === "ended") {
    return { ok: false, reason: "This contract has ended and its rates can't change." };
  }
  if (contract.status !== "draft") {
    if (target.effectiveFrom <= today) {
      return { ok: false, reason: "This rate card is already in force and can't be cancelled." };
    }
    if (!previous) {
      return { ok: false, reason: "A live contract needs a rate card. Add the new one first." };
    }
  }
  return {
    ok: true,
    reopens: previous ? { id: previous.id, effectiveToAfter: target.effectiveTo } : null,
  };
}

// ---------------------------------------------------------------------------
// Typed input
// ---------------------------------------------------------------------------

/** One rate line as typed in the editor: every value is text. */
export interface RateLineInput {
  role: string;
  band: string;
  unit: string;
  rate: string;
  otRate: string;
  otMultiplier: string;
  serviceType: string;
  /** Percent text, like "2" or "7.5"; blank takes the service type's default. */
  whtRate: string;
}

export type ParsedRateLine =
  { ok: true; line: RateLine } | { ok: false; field: keyof RateLineInput; message: string };

const PLAIN_TEXT = /^[^\u0000-\u001f\u007f-\u009f<>]*$/u;

function plainField(
  value: string,
  label: string,
  max: number,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, message: `Enter the ${label.toLowerCase()}` };
  if (trimmed.length > max)
    return { ok: false, message: `${label} must be ${max} characters or fewer` };
  if (!PLAIN_TEXT.test(trimmed) || /:\/\/|www\./i.test(trimmed)) {
    return { ok: false, message: `${label} must be plain text` };
  }
  return { ok: true, value: trimmed };
}

/** A naira amount above zero and up to ₦1bn, as kobo; null when the text isn't one. */
export function parseRateKobo(text: string): Kobo | null {
  let kobo: Kobo;
  try {
    kobo = parseNairaToKobo(text);
  } catch {
    return null;
  }
  return kobo > 0n && kobo <= MAX_RATE_KOBO ? kobo : null;
}

const MULTIPLIER = /^(\d)(?:\.(\d{1,2}))?\s*[x×]?$/i;

/** "1.5", "1.5x" or "1.5×" as basis points (15000); null outside 1.0× to 3.0× or when unreadable. */
export function parseMultiplierBps(text: string): number | null {
  const match = MULTIPLIER.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const bps = whole * 10_000 + fraction * 100;
  return bps >= 10_000 && bps <= 30_000 ? bps : null;
}

/** 15000 as "1.5×"; 12500 as "1.25×"; 20000 as "2×". */
export function formatMultiplier(bps: number): string {
  const whole = Math.trunc(bps / 10_000);
  const rest = (bps % 10_000).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}${rest ? `.${rest}` : ""}×`;
}

/** "5", "7.5" or "7.5%" as basis points (500, 750); null outside 0% to 20% or when unreadable. */
export function parsePercentBps(text: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps <= 2000 ? bps : null;
}

/** 500 as "5%"; 750 as "7.5%"; 0 as "0%". */
export function formatPercentBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${rest ? `.${rest}` : ""}%`;
}

/** One typed line as a rate line, or the first problem with it. */
export function parseRateLine(input: RateLineInput): ParsedRateLine {
  const role = plainField(input.role, "Role", 80);
  if (!role.ok) return { ok: false, field: "role", message: role.message };
  const bandText = input.band.trim() === "" ? STANDARD_BAND : input.band;
  const band = plainField(bandText, "Band", 40);
  if (!band.ok) return { ok: false, field: "band", message: band.message };
  if (!(RATE_UNITS as readonly string[]).includes(input.unit)) {
    return { ok: false, field: "unit", message: "Choose what the rate is per" };
  }
  const rateKobo = parseRateKobo(input.rate);
  if (rateKobo === null) {
    return {
      ok: false,
      field: "rate",
      message: "Enter a rate above ₦0 and up to ₦1,000,000,000, like 12,500",
    };
  }
  let otRateKobo: Kobo | null = null;
  if (input.otRate.trim() !== "") {
    otRateKobo = parseRateKobo(input.otRate);
    if (otRateKobo === null) {
      return {
        ok: false,
        field: "otRate",
        message: "Enter the overtime rate per hour, like 1,600",
      };
    }
  }
  let otMultiplierBps: number | null = null;
  if (input.otMultiplier.trim() !== "") {
    otMultiplierBps = parseMultiplierBps(input.otMultiplier);
    if (otMultiplierBps === null) {
      return {
        ok: false,
        field: "otMultiplier",
        message: "Enter overtime as 1 to 3 times, like 1.5",
      };
    }
  }
  // What bills is the overtime rate per hour; the multiplier only helps enter it. On an hourly
  // line it works the rate out (rounded half up, once), and a typed rate must agree with it. On
  // any other unit a multiplier can't make an hourly rate: the rate is needed and the multiplier
  // is kept for display only.
  if (otMultiplierBps !== null) {
    if (input.unit === "hour") {
      const worked = overtimeFromMultiplier(rateKobo, otMultiplierBps);
      if (worked > MAX_RATE_KOBO) {
        return {
          ok: false,
          field: "otMultiplier",
          message: "That overtime comes to more than ₦1,000,000,000 an hour",
        };
      }
      if (otRateKobo !== null && otRateKobo !== worked) {
        return {
          ok: false,
          field: "otRate",
          message: `The overtime rate doesn't match the multiplier (${formatRate(worked)} an hour). Clear one of them`,
        };
      }
      otRateKobo = worked;
    } else if (otRateKobo === null) {
      return {
        ok: false,
        field: "otRate",
        message: "Enter the overtime rate per hour. A multiplier alone works only on hourly lines",
      };
    }
  }
  const serviceType = (input.serviceType.trim() || "services") as ServiceType;
  if (!(SERVICE_TYPES as readonly string[]).includes(serviceType)) {
    return { ok: false, field: "serviceType", message: "Choose what the line pays for" };
  }
  let whtRateBps = DEFAULT_WHT_BPS[serviceType];
  if (input.whtRate.trim() !== "") {
    const parsed = parsePercentBps(input.whtRate);
    if (parsed === null) {
      return { ok: false, field: "whtRate", message: "Enter WHT from 0 to 20%, like 2" };
    }
    whtRateBps = parsed;
  }
  return {
    ok: true,
    line: {
      role: role.value,
      band: band.value,
      unit: input.unit as RateUnit,
      rateKobo,
      currency: "NGN",
      otRateKobo,
      otMultiplierBps,
      serviceType,
      whtRateBps,
    },
  };
}

/**
 * An hourly line's overtime rate from its multiplier: rate × bps / 10000, rounded half up once
 * (RULES_NIGERIA "Rounding"). 1,250,050 kobo at 1.5× gives 1,875,075 kobo.
 */
export function overtimeFromMultiplier(rateKobo: Kobo, bps: number): Kobo {
  return roundHalfUp(rateKobo * BigInt(bps), 10_000n);
}

/** The line as the editor shows it: amounts as plain naira text ("12500", "12500.50"). */
export function toRateLineInput(line: RateLine): RateLineInput {
  return {
    role: line.role,
    band: line.band.toLowerCase() === STANDARD_BAND ? "" : line.band,
    unit: line.unit,
    rate: koboToInput(line.rateKobo),
    otRate: line.otRateKobo === null ? "" : koboToInput(line.otRateKobo),
    otMultiplier:
      line.otMultiplierBps === null ? "" : formatMultiplier(line.otMultiplierBps).replace("×", ""),
    serviceType: line.serviceType,
    whtRate: formatPercentBps(line.whtRateBps).replace("%", ""),
  };
}

function koboToInput(kobo: Kobo): string {
  const naira = (kobo / 100n).toString();
  const rest = kobo % 100n;
  return rest === 0n ? naira : `${naira}.${rest.toString().padStart(2, "0")}`;
}

/** What the database functions take: amounts as strings of whole kobo, never numbers. */
export interface RateLinePayload {
  role: string;
  band: string;
  unit: RateUnit;
  rate_kobo: string;
  ot_rate_kobo: string | null;
  ot_multiplier_bps: number | null;
  service_type: ServiceType;
  wht_rate_bps: number;
}

export function toRateLinePayload(line: RateLine): RateLinePayload {
  return {
    role: line.role,
    band: line.band,
    unit: line.unit,
    rate_kobo: line.rateKobo.toString(),
    ot_rate_kobo: line.otRateKobo === null ? null : line.otRateKobo.toString(),
    ot_multiplier_bps: line.otMultiplierBps,
    service_type: line.serviceType,
    wht_rate_bps: line.whtRateBps,
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** ₦12,500 for whole naira; ₦12,500.50 when there are kobo. */
export function formatRate(kobo: Kobo): string {
  return kobo % 100n === 0n ? formatNaira(kobo, { whole: true }) : formatNaira(kobo);
}

function bandWord(line: Pick<RateLine, "band">): string {
  return line.band.trim().toLowerCase() === STANDARD_BAND ? "" : line.band.trim().toLowerCase();
}

/** "WHT 2%". */
export function formatWht(line: Pick<RateLine, "whtRateBps">): string {
  return `WHT ${formatPercentBps(line.whtRateBps)}`;
}

/** "₦12,500 a shift". */
export function formatLineRate(line: Pick<RateLine, "rateKobo" | "unit">): string {
  return `${formatRate(line.rateKobo)} ${PER_UNIT[line.unit]}`;
}

/** "₦1,600 an hour" (what bills), or "None". A multiplier never stands without its rate. */
export function formatOvertime(line: Pick<RateLine, "otRateKobo">): string {
  return line.otRateKobo === null ? "None" : `${formatRate(line.otRateKobo)} an hour`;
}

/**
 * One line for the setup table and the client page, as on the Setup board:
 * "₦12,500 day · ₦15,000 night shift · overtime ₦1,600 an hour · WHT 2%".
 * - Each line is its rate and band (the role too when the card has more than one role); a run of
 *   lines with the same unit names the unit once, after its last line.
 * - Overtime the lines share is said once at the end ("overtime ₦1,600 an hour"); overtime
 *   that differs is said on each line.
 * - WHT the same way: "WHT 2%" once at the end when every line shares it, else on each line.
 */
export function formatRateSummary(lines: readonly RateLine[]): string {
  if (lines.length === 0) return "No rates yet";
  const roles = new Set(lines.map((l) => l.role.trim().toLowerCase()));
  const overtime = lines.map((l) => formatOvertime(l));
  const shared = overtime.every((o) => o === overtime[0]);
  const sharedWht = lines.every((l) => l.whtRateBps === lines[0]?.whtRateBps);

  const parts = lines.map((line, i) => {
    const label = [roles.size > 1 ? line.role.trim().toLowerCase() : "", bandWord(line)]
      .filter(Boolean)
      .join(" ");
    const next = lines[i + 1];
    const unit = !next || next.unit !== line.unit ? unitWord(line.unit, label !== "") : "";
    const extras = [
      !shared && overtime[i] !== "None" ? `overtime ${overtime[i]}` : "",
      !sharedWht ? formatWht(line) : "",
    ].filter(Boolean);
    const tail = extras.length ? ` (${extras.join(", ")})` : "";
    return [formatRate(line.rateKobo), label, unit].filter(Boolean).join(" ") + tail;
  });
  if (shared && overtime[0] !== "None") parts.push(`overtime ${overtime[0]}`);
  if (sharedWht && lines[0]) parts.push(formatWht(lines[0]));
  return parts.join(" · ");
}

/** After a band ("night shift") the unit is a noun; on its own it reads "a shift". */
function unitWord(unit: RateUnit, afterLabel: boolean): string {
  return afterLabel ? unit : PER_UNIT[unit];
}

// ---------------------------------------------------------------------------
// Preview of a change (Lira groundwork 3)
// ---------------------------------------------------------------------------

export interface LineChange {
  key: RateKey;
  kind: "added" | "removed" | "changed";
  before: RateLine | null;
  after: RateLine | null;
}

/** Which lines a new version adds, removes or changes against `before`, by rate key. */
export function diffRateLines(
  before: readonly RateLine[] | null,
  after: readonly RateLine[],
): { changes: LineChange[]; unchanged: number } {
  const old = new Map((before ?? []).map((line) => [rateKeyId(line), line]));
  const changes: LineChange[] = [];
  let unchanged = 0;
  for (const line of after) {
    const id = rateKeyId(line);
    const previous = old.get(id) ?? null;
    old.delete(id);
    if (!previous) {
      changes.push({ key: line, kind: "added", before: null, after: line });
    } else if (
      previous.rateKobo !== line.rateKobo ||
      previous.otRateKobo !== line.otRateKobo ||
      previous.otMultiplierBps !== line.otMultiplierBps ||
      previous.serviceType !== line.serviceType ||
      previous.whtRateBps !== line.whtRateBps
    ) {
      changes.push({ key: line, kind: "changed", before: previous, after: line });
    } else {
      unchanged += 1;
    }
  }
  for (const line of old.values()) {
    changes.push({ key: line, kind: "removed", before: line, after: null });
  }
  return { changes, unchanged };
}

function describeLine(line: RateLine): string {
  const ot = formatOvertime(line);
  return `${formatLineRate(line)}${ot === "None" ? "" : `, overtime ${ot}`}, ${formatWht(line)}`;
}

export interface RateChangePreview {
  ok: boolean;
  /** One sentence, numbers first. */
  summary: string;
  changes: { label: string; before?: string; after: string }[];
}

function pluralLines(n: number): string {
  return `${n} ${n === 1 ? "line" : "lines"}`;
}

/**
 * What "Change rates from `from`" will do: the version it closes, the one it starts and the
 * lines that change. The screen's confirm step and the ops agent's confirmation card show this.
 */
export function previewRateChange(
  versions: readonly RateCardVersion[],
  from: string,
  today: string,
  contract: ContractDates,
  lines: readonly RateLine[],
): RateChangePreview {
  const plan = planNewVersion(versions, from, today, contract);
  if (!plan.ok) return { ok: false, summary: plan.reason, changes: [] };
  const closing = versions.find((v) => v.id === plan.closes.id) ?? null;
  const diff = diffRateLines(closing?.lines ?? null, lines);
  const changes: RateChangePreview["changes"] = [
    {
      label: "Current rates",
      before: plan.closes.effectiveToBefore
        ? `Until ${formatDate(plan.closes.effectiveToBefore)}`
        : "No end date",
      after: `End on ${formatDate(plan.closes.effectiveToAfter)}`,
    },
    {
      label: "New rates",
      after: `From ${formatDate(plan.starts.effectiveFrom)}${
        plan.starts.effectiveTo ? ` to ${formatDate(plan.starts.effectiveTo)}` : ""
      }`,
    },
  ];
  for (const change of diff.changes) {
    const label = formatRateKey(change.key);
    if (change.kind === "added" && change.after) {
      changes.push({ label, before: "Not on the card", after: describeLine(change.after) });
    } else if (change.kind === "removed" && change.before) {
      changes.push({ label, before: describeLine(change.before), after: "Removed" });
    } else if (change.before && change.after) {
      changes.push({
        label,
        before: describeLine(change.before),
        after: describeLine(change.after),
      });
    }
  }
  const changed = diff.changes.length;
  return {
    ok: true,
    summary: `Changes ${pluralLines(changed)} from ${formatDate(from)}; ${pluralLines(
      diff.unchanged,
    )} ${diff.unchanged === 1 ? "stays" : "stay"} the same. The current rates end on ${formatDate(
      plan.closes.effectiveToAfter,
    )}.`,
    changes,
  };
}
