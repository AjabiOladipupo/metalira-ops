/**
 * Staff IDs for workers added without one (owner decision 2: keep the company's own IDs and
 * generate only where blank).
 *
 * The company's pattern is the most common "prefix + zero-padded number" shape among the IDs
 * it already has (for example `AFS-0042`); ties go to the shape seen first. New IDs continue
 * after the highest number in that shape and skip any ID already taken, ignoring case. With no
 * numbered IDs at all, the default is `EMP-0001`.
 *
 * Pure: the caller passes the IDs already in use. The same rules are used by the people import
 * (slice 1.4), so a file and a form agree on what comes next.
 */

const NUMBERED_ID = /^(.*?)(\d+)$/;

interface Pattern {
  prefix: string;
  width: number;
  count: number;
  max: bigint;
  firstSeen: number;
}

export const DEFAULT_STAFF_ID_PREFIX = "EMP-";

/** The next `count` free staff IDs in the company's pattern. */
export function generateStaffIds(
  takenIds: readonly string[],
  count: number,
  defaultPrefix = DEFAULT_STAFF_ID_PREFIX,
): string[] {
  const patterns = new Map<string, Pattern>();
  takenIds.forEach((id, order) => {
    const match = NUMBERED_ID.exec(id.trim());
    if (!match) return;
    const prefix = match[1] ?? "";
    const digits = match[2] ?? "";
    const key = `${prefix.toUpperCase()}\u0000${digits.length}`;
    const value = BigInt(digits);
    const pattern = patterns.get(key);
    if (pattern) {
      pattern.count += 1;
      if (value > pattern.max) pattern.max = value;
    } else {
      patterns.set(key, { prefix, width: digits.length, count: 1, max: value, firstSeen: order });
    }
  });

  let best: Pattern = { prefix: defaultPrefix, width: 4, count: 0, max: 0n, firstSeen: -1 };
  for (const pattern of patterns.values()) {
    if (
      pattern.count > best.count ||
      (pattern.count === best.count && pattern.firstSeen < best.firstSeen)
    ) {
      best = pattern;
    }
  }

  const taken = new Set(takenIds.map((id) => id.trim().toUpperCase()));
  const out: string[] = [];
  let next = best.max + 1n;
  while (out.length < count) {
    const candidate = `${best.prefix}${next.toString().padStart(best.width, "0")}`;
    if (!taken.has(candidate.toUpperCase())) {
      out.push(candidate);
      taken.add(candidate.toUpperCase());
    }
    next += 1n;
  }
  return out;
}

/** The next free staff ID in the company's pattern. */
export function nextStaffId(takenIds: readonly string[]): string {
  const [id] = generateStaffIds(takenIds, 1);
  if (!id) throw new Error("generateStaffIds returned nothing");
  return id;
}
