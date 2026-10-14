/**
 * Shared setup for the M9 browser specs (docs/parity/m9.md C4): the seed's
 * env file (E2E_ENV_FILE, default `.secrets/e2e-m9.env`, never printed),
 * test sign-in by cookie, and the local-only guard (security check 9).
 */
import { test, type BrowserContext } from "@playwright/test"

import { loadSuiteEnv } from "../../scripts/e2e/env-file"

/** E2E_M9_ENV_FILE, then E2E_ENV_FILE, then .secrets/e2e-m9.env (scripts/e2e/env-file.ts). */
export function loadM9Env(): Record<string, string> {
  return loadSuiteEnv("m9")
}

export const env = loadM9Env()

export const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000"

/** The specs only ever drive a local app. */
export function assertLocalBaseUrl(): void {
  const host = new URL(BASE_URL).hostname

  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("E2E_BASE_URL must point at localhost")
  }
}

export type M9Principal = "owner" | "admin" | "member" | "w2" | "fresh"

const SESSIONS: Record<M9Principal, { session?: string; workspace?: string }> = {
  owner: { session: env.E2E_M9_OWNER_SESSION, workspace: env.E2E_M9_W1_WORKSPACE_ID },
  admin: { session: env.E2E_M9_ADMIN_SESSION, workspace: env.E2E_M9_W1_WORKSPACE_ID },
  member: { session: env.E2E_M9_MEMBER_SESSION, workspace: env.E2E_M9_W1_WORKSPACE_ID },
  w2: { session: env.E2E_M9_W2_SESSION, workspace: env.E2E_M9_W2_WORKSPACE_ID },
  fresh: { session: env.E2E_M9_FRESH_SESSION, workspace: env.E2E_M9_W3_WORKSPACE_ID },
}

export async function signIn(context: BrowserContext, who: M9Principal, locale?: "he" | "en"): Promise<void> {
  const { session, workspace } = SESSIONS[who]

  test.skip(!session, `E2E env is missing the ${who} session (run npm run m9:e2e-seed)`)
  await context.clearCookies()
  await context.addCookies([
    { name: "meetsum_session", value: session as string, url: BASE_URL },
    ...(workspace ? [{ name: "meetsum_workspace", value: workspace, url: BASE_URL }] : []),
    ...(locale ? [{ name: "meetsum_locale", value: locale, url: BASE_URL }] : []),
  ])
}
