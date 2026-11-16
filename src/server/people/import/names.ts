/**
 * Name matching for departments, clients, projects and sites.
 *
 * Two names are the same when they match after `nameKey` (case, spacing and punctuation
 * ignored). Two names are "near" (a likely typo) when they have the same words and every
 * differing word is a long word one or two letters off. Short words and numbers must match
 * exactly, so "Apapa Warehouse 3" is not near "Apapa Warehouse 5" and "Gate A" is not near
 * "Gate B", while "Coastline Logistic" is near "Coastline Logistics".
 */

export function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
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
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

function wordsNear(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  if (a.length < 4 || b.length < 4) return false;
  const allowed = Math.min(a.length, b.length) >= 8 ? 2 : 1;
  return editDistance(a, b, allowed) <= allowed;
}

/** True when two different names look like one is a typo of the other. */
export function namesNear(a: string, b: string): boolean {
  const keyA = nameKey(a);
  const keyB = nameKey(b);
  if (keyA === keyB || keyA === "" || keyB === "") return false;
  if (keyA.replace(/ /g, "") === keyB.replace(/ /g, "")) return true; // "Coast line" / "Coastline"
  const wordsA = keyA.split(" ");
  const wordsB = keyB.split(" ");
  if (wordsA.length !== wordsB.length) return false;
  return wordsA.every((word, index) => wordsNear(word, wordsB[index] ?? ""));
}

export interface KnownName {
  id: string;
  name: string;
}

export type NameResolution =
  | { kind: "existing"; id: string; name: string }
  | { kind: "new"; name: string }
  /** Probably a typo of `suggestion`: held back with a "Match to …" fix. */
  | { kind: "near"; suggestion: string };

/**
 * Resolves the names used in one scope (for example all client names, or the site names under
 * one client) against existing records and against each other.
 *
 * - A name matching an existing record (by `nameKey`) resolves to it.
 * - A name near an existing record is a likely typo of it.
 * - Among new names, the one used on most rows in a group of near names is kept (ties: the
 *   first seen); the others are likely typos of it. Spelling variants of one key (case,
 *   spacing) use the first spelling seen.
 */
export function resolveNames(
  used: readonly { name: string; count: number }[],
  existing: readonly KnownName[],
): Map<string, NameResolution> {
  const result = new Map<string, NameResolution>();
  const existingByKey = new Map<string, KnownName>();
  for (const record of existing) {
    const key = nameKey(record.name);
    if (!existingByKey.has(key)) existingByKey.set(key, record);
  }

  // Merge spelling variants of the same key, keeping the first spelling and summing counts.
  const byKey = new Map<string, { name: string; count: number; order: number }>();
  used.forEach(({ name, count }, order) => {
    const key = nameKey(name);
    const seen = byKey.get(key);
    if (seen) seen.count += count;
    else byKey.set(key, { name, count, order });
  });

  const newNames: { key: string; name: string; count: number; order: number }[] = [];
  for (const [key, entry] of byKey) {
    const match = existingByKey.get(key);
    if (match) {
      result.set(key, { kind: "existing", id: match.id, name: match.name });
      continue;
    }
    const nearExisting = existing.find((record) => namesNear(entry.name, record.name));
    if (nearExisting) {
      result.set(key, { kind: "near", suggestion: nearExisting.name });
      continue;
    }
    newNames.push({ key, ...entry });
  }

  // Most used first; ties keep file order.
  newNames.sort((a, b) => b.count - a.count || a.order - b.order);
  const kept: { name: string }[] = [];
  for (const entry of newNames) {
    const canonical = kept.find((keptName) => namesNear(entry.name, keptName.name));
    if (canonical) {
      result.set(entry.key, { kind: "near", suggestion: canonical.name });
    } else {
      kept.push(entry);
      result.set(entry.key, { kind: "new", name: entry.name });
    }
  }
  return result;
}
