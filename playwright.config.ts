import { defineConfig } from "@playwright/test"

/**
 * Browser e2e (docs/parity/m6.md, Acceptance #13). There is no `webServer`:
 * the operator starts Postgres/Redis and the app, then runs
 * `npm run test:e2e` with `E2E_BASE_URL` pointing at it.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
})
