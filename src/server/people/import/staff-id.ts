/**
 * Staff IDs for rows that leave `employee_id` blank (owner decision 2: keep the company's IDs,
 * generate only where blank).
 *
 * The company's pattern is the most common "prefix + zero-padded number" shape among the IDs
 * already in the account and in the file (for example `AFS-0042`). New IDs continue after the
 * highest number in that shape. With no IDs anywhere, the default is `EMP-0001`.
 */

const NUMBERED_ID = /^(.*?)(\d+)$/;

interface Pattern {
  prefix: string;
  width: number;
  count: number;
  max: bigint;
  firstSeen: number;
}

export function generateStaffIds(
  takenIds: readonly string[],
  count: number,
  defaultPrefix = "EMP-",
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
