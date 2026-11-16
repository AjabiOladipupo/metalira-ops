import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Who may call the scheduled routes under /api/cron: Vercel Cron, which sends
 * `Authorization: Bearer <CRON_SECRET>` when the project has a CRON_SECRET environment variable.
 * Without the variable every call is refused (fail closed). Both sides are hashed before the
 * constant-time compare, so their lengths never leak through timing.
 */
export type CronAccess = "ok" | "unauthorised" | "not_configured";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function checkCronRequest(
  authorization: string | null,
  env: NodeJS.ProcessEnv = process.env,
): CronAccess {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return "not_configured";
  if (!authorization) return "unauthorised";
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`)) ? "ok" : "unauthorised";
}
