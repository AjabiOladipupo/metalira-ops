import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

// The secret-key admin client may only be imported from src/server/ (CLAUDE.md
// rule 2). tests/** is a deliberate exception: the RLS suite builds its own
// secret-key client against the local stack.
const adminClientImport = {
  group: ["@/server/supabase/admin", "**/server/supabase/admin"],
  message: "The secret-key client is server-only: import it only from src/server/.",
};

// Shared UI and isomorphic helpers must never pull in server modules.
const serverModuleImport = {
  group: ["@/server/*", "**/server/*"],
  message: "src/components and src/lib run in the browser too: keep src/server imports out.",
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [adminClientImport] }],
    },
  },
  {
    // Flat config replaces rule options per matching block, so this block
    // repeats the admin-client pattern. Extend this array; do not add a second
    // no-restricted-imports block for the same files.
    files: ["src/components/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [adminClientImport, serverModuleImport] }],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "docs/**",
    "next-env.d.ts",
    "src/types/db.ts",
  ]),
]);
