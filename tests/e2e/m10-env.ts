/**
 * Shared setup for the M10 core-flow and bot specs (docs/parity/m10.md,
 * A3/A4): the seed's env file (E2E_M10_ENV_FILE, default
 * `.secrets/e2e-m10.env`, never printed), sign-in by cookie, the local-only
 * guard, meeting status polling and the axe scan with its report.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import AxeBuilder from "@axe-core/playwright"
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test"

import { loadSuiteEnv } from "../../scripts/e2e/env-file"
import { assertLocal } from "../../scripts/e2e/local-guard"

export const env = loadSuiteEnv("m10")
export const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000"
export const ORIGIN = { origin: BASE_URL }
export const MEDIA_FILE = path.join("tests", "fixtures", "e2e", "media", "he-en-30s.wav")
export const OUT = path.join("test-results", "m10")

export function assertLocalBaseUrl(): void {
  assertLocal(BASE_URL, "E2E_BASE_URL")
}

export type M10Principal = "owner" | "member" | "w2"

const SESSIONS: Record<M10Principal, { session?: string; workspace?: string }> = {
  owner: { session: env.E2E_M10_OWNER_SESSION, workspace: env.E2E_M10_W1_WORKSPACE_ID },
  member: { session: env.E2E_M10_MEMBER_SESSION, workspace: env.E2E_M10_W1_WORKSPACE_ID },
  w2: { session: env.E2E_M10_W2_SESSION, workspace: env.E2E_M10_W2_WORKSPACE_ID },
}

export async function signIn(context: BrowserContext, who: M10Principal, locale: "he" | "en" = "he"): Promise<void> {
  const { session, workspace } = SESSIONS[who]

  test.skip(!session, `E2E env is missing the ${who} session (run npm run m10:e2e-seed)`)
  await context.clearCookies()
  await context.addCookies([
    { name: "meetsum_session", value: session as string, url: BASE_URL },
    ...(workspace ? [{ name: "meetsum_workspace", value: workspace, url: BASE_URL }] : []),
    { name: "meetsum_locale", value: locale, url: BASE_URL },
  ])
}

type MeetingStatus = { status?: string; title?: string }

export async function meetingStatus(request: APIRequestContext, meetingId: string): Promise<{ http: number; meeting?: MeetingStatus }> {
  const response = await request.get(`/api/meetings/${encodeURIComponent(meetingId)}`)

  if (!response.ok()) return { http: response.status() }
  return { http: response.status(), meeting: ((await response.json()) as { meeting?: MeetingStatus }).meeting }
}

/** Polls the meeting until `completed`; fails fast on `failed`. */
export async function waitForCompleted(request: APIRequestContext, meetingId: string, timeoutMs = 120_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const { meeting } = await meetingStatus(request, meetingId)

        if (meeting?.status === "failed") throw new Error(`meeting ${meetingId} failed processing (see e2e-logs/worker.log)`)
        return meeting?.status
      },
      { timeout: timeoutMs, intervals: [1_000, 2_000, 3_000] }
    )
    .toBe("completed")
}

/**
 * Clicks `target` until `opened` is visible: under `next dev` a click that
 * lands before hydration is lost (seen in the local m6/m9 runs).
 */
export async function clickUntilVisible(target: Locator, opened: Locator, timeout = 30_000): Promise<void> {
  await expect(async () => {
    if (!(await opened.isVisible())) await target.click()
    await expect(opened).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout })
}

/** `aria-valuenow` of the player scrubber (whole seconds). */
export async function playerSeconds(page: Page): Promise<number> {
  // The player's scrubber (components/player/scrubber.tsx, an explicit
  // role=slider with aria-valuenow), not the volume <input type=range> that
  // precedes it at the inbox breakpoint and carries no aria-valuenow.
  return Number(await page.locator('[role="slider"][aria-valuenow]').first().getAttribute("aria-valuenow"))
}

/** Seconds from a "… m:ss" label (citation chips, timecodes). */
export function secondsFromLabel(label: string | null): number | undefined {
  const match = /(\d+):(\d{2})(?::(\d{2}))?\s*$/.exec(label ?? "")

  if (!match) return undefined
  return match[3] !== undefined ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : Number(match[1]) * 60 + Number(match[2])
}

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true })
}

type AxeFinding = { surface: string; rule: string; impact: string; nodes: number }

function allowlist(): Array<{ surface: string; rule: string; reason: string }> {
  try {
    const parsed = JSON.parse(readFileSync("scripts/axe-allowlist.json", "utf8")) as { entries?: Array<{ surface: string; rule: string; reason: string }> }

    return (parsed.entries ?? []).filter((entry) => entry.reason?.trim())
  } catch {
    return []
  }
}

const findings: AxeFinding[] = []

/**
 * axe on the current page: serious/critical findings outside
 * scripts/axe-allowlist.json fail the step; all go to the report.
 */
export async function scanA11y(page: Page, surface: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const allow = allowlist()
  const found = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .filter((violation) => !allow.some((entry) => entry.rule === violation.id && (entry.surface === surface || entry.surface === "*")))
    .map((violation) => ({ surface, rule: violation.id, impact: violation.impact ?? "", nodes: violation.nodes.length }))

  findings.push(...found)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(path.join(OUT, "a11y-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 2)}\n`)
  expect.soft(found, `serious/critical axe violations on ${surface} (see ${OUT}/a11y-report.json)`).toEqual([])
}
