import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The npm `server-only` package throws outside the react-server condition. Next enforces
      // the boundary at build time; in unit tests it resolves to an empty module instead.
      "server-only": fileURLToPath(new URL("./tests/stubs/empty.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/rls/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
