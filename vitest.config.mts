import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Root-level options are shared by every project through `extends: true`.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The npm `server-only` package throws outside the react-server condition. Next enforces
      // the boundary at build time; in unit tests it resolves to an empty module instead.
      "server-only": fileURLToPath(new URL("./tests/stubs/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          // Docker-free: runs in the CI "check" job with `pnpm test`.
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx", "src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          // Needs the local Supabase stack: `pnpm db:start`, then `pnpm test:rls`.
          name: "rls",
          include: ["tests/rls/**/*.test.ts"],
          globalSetup: ["tests/rls/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
