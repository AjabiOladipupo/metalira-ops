import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { appServerEnv } from "./tests/e2e/helpers/server-env";

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Public Supabase settings for the app under test. Uses NEXT_PUBLIC_SUPABASE_* when set,
 * otherwise reads the local stack (`pnpm db:start`) through `supabase status`. With neither,
 * the app builds without Supabase and the specs that need it skip themselves.
 */
function supabasePublicEnv(): Record<string, string> {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
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
    const url = status.API_URL;
    const key = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
    return url && key
      ? { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }
      : {};
  } catch {
    return {};
  }
}

// Set once in the main process; test workers inherit it, so they skip the status call.
Object.assign(process.env, supabasePublicEnv());

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    {
      name: "mobile-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  // Tests run against a production build so first-visit compile time never causes timeouts.
  // Locally, an already running server on the same port (e.g. `pnpm dev`) is reused.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm build && pnpm start --port ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        // Email links in tests must come back to this server, whatever the port. Worker sign-in
        // needs server-only settings too (tests/e2e/helpers/server-env.ts).
        env: {
          NEXT_PUBLIC_APP_URL: baseURL,
          ...appServerEnv(process.env.NEXT_PUBLIC_SUPABASE_URL),
        },
      },
});
