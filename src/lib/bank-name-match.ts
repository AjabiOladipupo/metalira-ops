/**
 * Comparing the account name the bank network returns with the name we expect (slice 2.3b).
 * Pure and browser-safe, so the form, the server and the approver's card all give the same
 * answer from the same inputs.
 *
 * Results:
 * - `match`: accept.
 * - `near`: show both names; the requester must give a reason (10 characters or more), which the
 *   approver sees.
 * - `no_match`: refused. The account belongs to someone else, or the details are wrong.
 *
 * Companies: compared with the legal name and the trading name (the best of them). Case,
 * punctuation, "&"/"and" and company suffixes are normalised (LTD/LIMITED, NIG/NIGERIA,
 * SVCS/SERVICES, ENT/ENTERPRISES, CO/COMPANY, INTL/INTERNATIONAL...). Legal-form words (LIMITED,
 * PLC, NIGERIA, COMPANY...) are ignored; generic business words (SERVICES, VENTURES, GLOBAL...)
 * count for little; the distinctive words decide.
 *
 * Workers: the first and last name, in any order (bank records often put the surname first),
 * with middle names allowed on the bank's side. Titles (MR, MRS, ALHAJI, CHIEF...) are ignored.
 * A shortened or slightly misspelt name, or an initial, gives `near`; a name that shares only
 * one of the two names gives `no_match`.
 */

export type NameMatchResult = "match" | "near" | "no_match";

export interface NameMatch {
  result: NameMatchResult;
  /** 0 to 1: how much of the names agree. For display and tests, not for decisions. */
  score: number;
  /** The expected name that compared best (shown next to the bank's name). */
  expected: string;
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

/** Upper case, accents removed, "&" as AND, punctuation as spaces, apostrophes dropped. */
export function normaliseName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function nameTokens(name: string): string[] {
  const normal = normaliseName(name);
  return normal ? normal.split(" ") : [];
}

/** Abbreviations banks and registries use, mapped to one spelling. */
const COMPANY_SYNONYMS: Readonly<Record<string, string>> = {
  LTD: "LIMITED",
  LIM: "LIMITED",
  LMTD: "LIMITED",
  NIG: "NIGERIA",
  NIGERIAN: "NIGERIA",
  NG: "NIGERIA",
  ENT: "ENTERPRISES",
  ENTS: "ENTERPRISES",
  ENTERPRISE: "ENTERPRISES",
  ENTERPRIZE: "ENTERPRISES",
  SVCS: "SERVICES",
  SVC: "SERVICES",
  SERV: "SERVICES",
  SERVS: "SERVICES",
  SERVICE: "SERVICES",
  CO: "COMPANY",
  COY: "COMPANY",
  INTL: "INTERNATIONAL",
  INTERNATL: "INTERNATIONAL",
  INT: "INTERNATIONAL",
  VENT: "VENTURES",
  VENTURE: "VENTURES",
  GLB: "GLOBAL",
  GLOB: "GLOBAL",
  MGT: "MANAGEMENT",
  MGMT: "MANAGEMENT",
  TECH: "TECHNOLOGY",
  TECHNOLOGIES: "TECHNOLOGY",
  INC: "INCORPORATED",
  CORP: "CORPORATION",
  INDS: "INDUSTRIES",
  IND: "INDUSTRIES",
  NIGLTD: "NIGERIA LIMITED",
  INVESTMENT: "INVESTMENTS",
  RESOURCE: "RESOURCES",
  SOLUTION: "SOLUTIONS",
  CONCEPT: "CONCEPTS",
  ASSOCIATE: "ASSOCIATES",
};

/** Legal-form and filler words: ignored when comparing company names. */
const COMPANY_IGNORED = new Set([
  "LIMITED",
  "PLC",
  "NIGERIA",
  "COMPANY",
  "INCORPORATED",
  "CORPORATION",
  "LLC",
  "AND",
  "THE",
  "OF",
  "RC",
  "BN",
]);

/** Generic business words: they count, but far less than the distinctive ones. */
const COMPANY_GENERIC = new Set([
  "SERVICES",
  "ENTERPRISES",
  "VENTURES",
  "GLOBAL",
  "INTERNATIONAL",
  "RESOURCES",
  "SOLUTIONS",
  "INVESTMENTS",
  "CONCEPTS",
  "ASSOCIATES",
  "INDUSTRIES",
  "MANAGEMENT",
  "TECHNOLOGY",
  "GROUP",
  "HOLDINGS",
  "NETWORKS",
  "PARTNERS",
  "SYSTEMS",
  "TRADING",
  "MULTI",
  "INTEGRATED",
]);

const GENERIC_WEIGHT = 0.25;

/** Titles and honorifics: never part of a worker's name on the record. */
const TITLES = new Set([
  "MR",
  "MRS",
  "MS",
  "MISS",
  "MASTER",
  "DR",
  "ENGR",
  "ENG",
  "CHIEF",
  "PROF",
  "ALH",
  "ALHAJI",
  "ALHAJA",
  "ALHAJIA",
  "HAJIA",
  "HAJI",
  "PASTOR",
  "REV",
  "BARR",
  "HON",
  "SIR",
  "MALAM",
  "MALLAM",
  "OTUNBA",
  "PRINCE",
  "PRINCESS",
  "ARC",
  "PHARM",
  "DEACON",
  "DCNS",
  "EVANG",
  "ELDER",
]);

function companyTokens(name: string): string[] {
  return nameTokens(name)
    .flatMap((token) => (COMPANY_SYNONYMS[token] ?? token).split(" "))
    .filter((token) => !COMPANY_IGNORED.has(token));
}

// ---------------------------------------------------------------------------
// Token comparison
// ---------------------------------------------------------------------------

/** Levenshtein distance, stopping early once it passes `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

/**
 * How well two single words agree: 1 exact; 0.75 a small misspelling or one contained in the
 * other ("SEUN" in "OLUWASEUN", a name cut short by the bank); 0.5 an initial; 0 otherwise.
 */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 1) return long.startsWith(short) ? 0.5 : 0;
  if (short.length >= 4 && long.includes(short)) return 0.75;
  if (short.length >= 3 && long.startsWith(short)) return 0.75;
  const allowed = long.length >= 8 ? 2 : long.length >= 4 ? 1 : 0;
  if (allowed > 0 && editDistance(a, b, allowed) <= allowed) return 0.75;
  return 0;
}

/** Best one-to-one pairing of `want` words with `have` words (greedy on similarity). */
function pairUp(want: readonly string[], have: readonly string[]): number[] {
  const scores = want.map(() => 0);
  const pairs: { w: number; h: number; s: number }[] = [];
  want.forEach((w, wi) =>
    have.forEach((h, hi) => {
      const s = tokenSimilarity(w, h);
      if (s > 0) pairs.push({ w: wi, h: hi, s });
    }),
  );
  pairs.sort((x, y) => y.s - x.s);
  const usedW = new Set<number>();
  const usedH = new Set<number>();
  for (const { w, h, s } of pairs) {
    if (usedW.has(w) || usedH.has(h)) continue;
    usedW.add(w);
    usedH.add(h);
    scores[w] = s;
  }
  return scores;
}

const round = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

function compareCompany(bankName: string, expected: string): Omit<NameMatch, "expected"> {
  const have = companyTokens(bankName);
  const want = companyTokens(expected);
  if (have.length === 0 || want.length === 0) return { result: "no_match", score: 0 };

  // "SHIELDGUARDS" and "SHIELD GUARDS": the same words run together.
  const joined = (tokens: string[]) => tokens.filter((t) => !COMPANY_GENERIC.has(t)).join("");
  if (joined(have) !== "" && joined(have) === joined(want)) {
    // The distinctive words agree. Generic words may be dropped by the bank ("ADEBAYO FACILITY
    // LTD" for "Adebayo Facility Services Ltd"), but a different one ("...VENTURES" for
    // "...SERVICES") can be another business with a similar name.
    const genericOf = (tokens: string[]) => new Set(tokens.filter((t) => COMPANY_GENERIC.has(t)));
    const g1 = genericOf(have);
    const g2 = genericOf(want);
    const subset = (a: Set<string>, b: Set<string>) => [...a].every((t) => b.has(t));
    if (subset(g1, g2) && subset(g2, g1)) return { result: "match", score: 1 };
    if (subset(g1, g2) || subset(g2, g1)) return { result: "match", score: 0.95 };
    return { result: "near", score: 0.8 };
  }

  const weight = (t: string) => (COMPANY_GENERIC.has(t) ? GENERIC_WEIGHT : 1);
  const wantScores = pairUp(want, have);
  const haveScores = pairUp(have, want);
  const total = (tokens: string[]) => tokens.reduce((sum, t) => sum + weight(t), 0);
  const got = (tokens: string[], scores: number[]) =>
    tokens.reduce((sum, t, i) => sum + weight(t) * (scores[i] ?? 0), 0);
  // How much of each name the other covers; the weaker side decides.
  const coverWant = got(want, wantScores) / total(want);
  const coverHave = got(have, haveScores) / total(have);
  const score = Math.min(coverWant, coverHave);

  const distinctive = (tokens: string[], scores: number[]) =>
    tokens.flatMap((t, i) => (COMPANY_GENERIC.has(t) ? [] : [scores[i] ?? 0]));
  const wantDistinct = distinctive(want, wantScores);
  const haveDistinct = distinctive(have, haveScores);
  const allExact = [...wantDistinct, ...haveDistinct].every((s) => s === 1);
  const anyDistinctive = [...wantDistinct, ...haveDistinct].some((s) => s > 0);

  if (allExact && wantDistinct.length > 0 && score >= 0.85) {
    return { result: "match", score: round(score) };
  }
  if (anyDistinctive && score >= 0.5) return { result: "near", score: round(score) };
  return { result: "no_match", score: round(score) };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Words that make an account look like a business, not a person's own account. */
const BUSINESS_WORDS = new Set(
  [...COMPANY_GENERIC, ...COMPANY_IGNORED].filter((w) => w.length > 3),
);

function personTokens(name: string): string[] {
  return nameTokens(name).filter((t) => !TITLES.has(t));
}

export interface PersonName {
  firstName: string;
  lastName: string;
}

function comparePerson(bankName: string, person: PersonName): Omit<NameMatch, "expected"> {
  const have = personTokens(bankName);
  const first = personTokens(person.firstName);
  const last = personTokens(person.lastName);
  if (have.length === 0 || first.length === 0 || last.length === 0) {
    return { result: "no_match", score: 0 };
  }

  // A double-barrelled surname may come as one word or two: "OKAFOR-EZE", "OKAFOREZE".
  const lastJoined = last.join("");
  const haveForLast =
    last.length > 1 && have.includes(lastJoined)
      ? [...have.filter((t) => t !== lastJoined), ...last]
      : have;

  const want = [...first, ...last];
  const scores = pairUp(want, haveForLast);
  const firstScores = scores.slice(0, first.length);
  const lastScores = scores.slice(first.length);
  const best = (list: number[]) => Math.max(0, ...list);
  const firstScore = best(firstScores);
  const lastScore = best(lastScores);

  const matched = scores.filter((s) => s > 0).length;
  const extras = haveForLast.length - matched;
  const businessLike = have.some((t) => BUSINESS_WORDS.has(COMPANY_SYNONYMS[t] ?? t));
  const score = round((firstScore + lastScore) / 2);

  if (scores.every((s) => s === 1) && extras <= 2 && !businessLike) {
    return { result: "match", score: 1 };
  }
  // Both names present, at least one of them exactly or both nearly (an initial counts only
  // next to an exact name).
  if (firstScore >= 0.5 && lastScore >= 0.5 && firstScore + lastScore >= 1.5) {
    return { result: "near", score };
  }
  return { result: "no_match", score };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const RANK: Record<NameMatchResult, number> = { match: 2, near: 1, no_match: 0 };

/**
 * The bank's name against the company's legal and trading names (blank ones skipped). The best
 * of them counts.
 */
export function matchCompanyName(
  bankName: string,
  companyNames: readonly (string | null | undefined)[],
): NameMatch {
  const names = [...new Set(companyNames.map((n) => n?.trim() ?? "").filter(Boolean))];
  let best: NameMatch = { result: "no_match", score: 0, expected: names[0] ?? "" };
  for (const expected of names) {
    const m = compareCompany(bankName, expected);
    if (RANK[m.result] > RANK[best.result] || (m.result === best.result && m.score > best.score)) {
      best = { ...m, expected };
    }
  }
  return best;
}

/** The bank's name against a worker's first and last name, in any order. */
export function matchPersonName(bankName: string, person: PersonName): NameMatch {
  const expected = `${person.firstName.trim()} ${person.lastName.trim()}`.trim();
  return { ...comparePerson(bankName, person), expected };
}

/** Shortest reason accepted for a near match. */
export const NEAR_REASON_MIN = 10;

/** Labels for the three results, as the screens show them. */
export const NAME_MATCH_LABEL: Record<NameMatchResult | "not_checked", string> = {
  match: "Name matches",
  near: "Close match",
  no_match: "Name doesn't match",
  not_checked: "Not checked",
};
