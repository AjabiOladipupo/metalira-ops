/**
 * Server-only settings for the app under test (playwright.config.ts `webServer.env`). Kept under
 * tests/ because they name server secrets, which app code outside src/server/ never does
 * (tests/unit/secret-key-boundary.test.ts, pii-key-boundary.test.ts).
 *
 * - SUPABASE_SECRET_KEY: the LOCAL stack's own key (a fixed development value), only when the
 *   app is built against that local stack. Worker sign-in and invite links need it.
 * - PII_ENCRYPTION_KEY: a throwaway key for PIN hashing, unless the environment sets one.
 * - METALIRA_TEST_BANK_LOOKUP: the app runs as a production build, which would refuse account
 *   name lookups without provider keys; this lets it use the deterministic test resolver
 *   (slice 2.3b). Ignored on Vercel production.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function localSecretKey(appSupabaseUrl: string | undefined): Record<string, string> {
  if (!appSupabaseUrl) return {};
  try {
    if (!LOCAL_HOSTS.has(new URL(appSupabaseUrl).hostname)) return {};
  } catch {
    return {};
  }
  const cli = path.join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");
  if (!existsSync(cli)) return {};
  try {
    const out = execFileSync(process.execPath, [cli, "status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    });
    const status = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string | undefined>;
    const secret = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
    return status.API_URL === appSupabaseUrl && secret ? { SUPABASE_SECRET_KEY: secret } : {};
  } catch {
    return {};
  }
}

export function appServerEnv(appSupabaseUrl: string | undefined): Record<string, string> {
  // Only the main process starts the web server; test workers load the config too.
  if (process.env.TEST_WORKER_INDEX !== undefined) return {};
  return {
    ...localSecretKey(appSupabaseUrl),
    PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY ?? randomBytes(32).toString("base64"),
    METALIRA_TEST_BANK_LOOKUP: "1",
  };
}
