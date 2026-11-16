/**
 * Guards personal data in validator results against accidental logging (CLAUDE.md rule 9).
 *
 * The guarded object keeps its real values for code that reads the fields (to encrypt them),
 * but gains two non-enumerable hooks that return a masked copy:
 * - `toJSON`, used by `JSON.stringify`, Sentry's event serialiser and React's server-to-client
 *   serialiser;
 * - `util.inspect.custom`, used by `console.log` and `util.inspect` in Node.
 *
 * Non-enumerable, so equality checks, `Object.keys` and spreads ignore them. A spread copy loses
 * the guard, which is why callers read the fields they need instead of logging copies.
 */

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** `•••• 6789` for a bank account number; `••••` for everything else. */
function mask(value: unknown, showLast4: boolean): unknown {
  if (typeof value !== "string" || value === "") return value;
  return showLast4 && value.length >= 8 ? `•••• ${value.slice(-4)}` : "••••";
}

type Inspect = (value: unknown, options: unknown) => string;

/**
 * Adds the masking hooks to `target` in place and returns it. `keys` are masked fully,
 * `last4Keys` keep their last four characters (bank account numbers, as the UI shows them).
 */
export function guardPersonalData<T extends object>(
  target: T,
  keys: readonly (keyof T & string)[],
  last4Keys: readonly (keyof T & string)[] = [],
): T {
  const masked = (): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const key of keys) copy[key] = mask(copy[key], false);
    for (const key of last4Keys) copy[key] = mask(copy[key], true);
    return copy;
  };
  Object.defineProperty(target, "toJSON", { value: masked, enumerable: false });
  Object.defineProperty(target, INSPECT, {
    value: (_depth: number, options: unknown, inspect: Inspect) => inspect(masked(), options),
    enumerable: false,
  });
  return target;
}
