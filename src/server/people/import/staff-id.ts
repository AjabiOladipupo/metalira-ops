/**
 * Staff IDs for rows that leave `employee_id` blank (owner decision 2: keep the company's IDs,
 * generate only where blank).
 *
 * The company's pattern is the most common "prefix + zero-padded number" shape among the IDs
 * already in the account and in the file (for example `AFS-0042`). New IDs continue after the
 * highest number in that shape. With no IDs anywhere, the default is `EMP-0001`.
 */

/**
 * A staff ID is the worker's sign-in identifier (company code + staff ID + PIN, owner decision
 * 4) and appears in emails and on printed invite sheets, so it is a strict ASCII token: a letter
 * or digit, then up to 39 letters, digits, dots, underscores, slashes or dashes. No spaces,
 * `@`, `<`, `://`, control characters or formula characters at the start.
 */
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;

/**
 * NFKC-normalises a staff ID (fullwidth `ＡＦＳ-００４２` becomes `AFS-0042`) and checks it.
 * Returns the normalised ID, or null when it isn't an acceptable staff ID.
 */
export function normaliseStaffId(raw: string): string | null {
  const value = raw.normalize("NFKC").trim();
  return STAFF_ID.test(value) ? value : null;
}

/** Comparison key for staff IDs: the same normalisation, ignoring case. */
export function staffIdKey(id: string): string {
  return id.normalize("NFKC").trim().toLowerCase();
}

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

  const taken = new Set(takenIds.map(staffIdKey));
  const out: string[] = [];
  let next = best.max + 1n;
  while (out.length < count) {
    const candidate = `${best.prefix}${next.toString().padStart(best.width, "0")}`;
    if (!taken.has(staffIdKey(candidate))) {
      out.push(candidate);
      taken.add(staffIdKey(candidate));
    }
    next += 1n;
  }
  return out;
}
