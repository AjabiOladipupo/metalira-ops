import { maskPii, type PiiField } from "@/lib/mask";

/**
 * Guards personal data in validator results against accidental logging (CLAUDE.md rule 9).
 *
 * The guarded object keeps its real values for code that reads the fields (to encrypt them),
 * but gains two non-enumerable hooks that return a copy masked with `maskPii`:
 * - `toJSON`, used by `JSON.stringify`, Sentry's event serialiser and React's server-to-client
 *   serialiser;
 * - `util.inspect.custom`, used by `console.log` and `util.inspect` in Node.
 *
 * Non-enumerable, so equality checks, `Object.keys` and spreads ignore them. A spread copy loses
 * the guard, which is why callers read the fields they need instead of logging copies.
 */

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

type Inspect = (value: unknown, options: unknown) => string;

/** Adds the masking hooks to `target` in place and returns it. */
export function guardPersonalData<T extends object>(
  target: T,
  fields: Partial<Record<keyof T & string, PiiField>>,
): T {
  const masked = (): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const [key, field] of Object.entries(fields) as [string, PiiField][]) {
      const value = copy[key];
      if (typeof value === "string" && value !== "") copy[key] = maskPii(field, value);
    }
    return copy;
  };
  Object.defineProperty(target, "toJSON", { value: masked, enumerable: false });
  Object.defineProperty(target, INSPECT, {
    value: (_depth: number, options: unknown, inspect: Inspect) => inspect(masked(), options),
    enumerable: false,
  });
  return target;
}
