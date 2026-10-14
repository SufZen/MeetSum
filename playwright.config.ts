import { defineConfig } from "@playwright/test"

/**
 * Browser e2e (docs/parity/m6.md, Acceptance #13; m10.md, "E2E in CI").
 * There is no `webServer`: the operator (or .github/workflows/e2e.yml)
 * starts Postgres/Redis/MinIO, the fake providers, the worker and the app,
 * then runs `npx playwright test --project=<suite>` with `E2E_BASE_URL`
 * pointing at it. One project per CI matrix job; each needs its own seeded,
 * otherwise empty database (the seeds overlap).
 *
 *   core     m10 core flow (upload → transcript → summary → Ask → share) + bot webhooks
 *   m6       search and Ask
 *   m8       integrations against the fake providers
 *   m9       polish + the RTL screenshot matrix and axe report
 *   m9-prod  production-build checks (service worker, error pages, manifest)
 */
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "core", testMatch: /m10-(core-flow|bot)\.spec\.ts$/ },
    { name: "m6", testMatch: /m6-search-ask\.spec\.ts$/ },
    { name: "m8", testMatch: /m8-integrations\.spec\.ts$/ },
    { name: "m9", testMatch: /m9-(polish|screenshots)\.spec\.ts$/ },
    { name: "m9-prod", testMatch: /m9-prod\.spec\.ts$/ },
  ],
})
