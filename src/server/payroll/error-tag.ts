/**
 * An error as the payroll logs record it (slice 5.8): its name and, when it has one, its short
 * code (a Postgres SQLSTATE or our MLxx refusal), never its message, which can carry a period, a
 * company or a figure.
 */
export function errorTag(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown error";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,12}$/.test(code) ? `${name} (${code})` : name;
}
