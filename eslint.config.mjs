import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // M10 B1 (docs/parity/m10.md, "Observability"): server code logs through
  // the pino logger in lib/log only. CLIs (scripts/**, mcp/**), the desktop
  // recorder and tests are exempt; client components already have none.
  {
    files: ["lib/**/*.{ts,tsx}", "app/**/*.{ts,tsx}", "worker/**/*.{ts,tsx}", "instrumentation.ts", "proxy.ts"],
    rules: { "no-console": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees and build outputs that are not part of the app source.
    ".claude/**",
    "desktop-recorder/dist/**",
    "desktop-recorder/release/**",
    // Static design-system showcase (plain browser JS, not app source).
    "design-system/showcase/**",
    "public/ds/**",
  ]),
]);

export default eslintConfig;
