/**
 * M6 Search & AskMeetSum browser e2e (docs/parity/m6.md, Acceptance #13).
 *
 * Prerequisites (run by the orchestrator, no keys needed):
 *   docker compose up postgres redis        # pgvector image (or plain postgres:16 for @lexical)
 *   npm run db:migrate && npm run search:e2e-seed
 *   app running with NODE_ENV=development, MEETSUM_EMBEDDING_PROVIDER=hash,
 *   MEETSUM_LLM_REPLAY_DIR=tests/fixtures/ask/replay
 *   E2E_BASE_URL=http://localhost:3000 npm run test:e2e
 *
 * The seed (B9) writes test credentials and ids to `E2E_ENV_FILE`
 * (default `.secrets/e2e.env`, gitignored). This spec reads these keys:
 *   E2E_W1_OWNER_SESSION, E2E_W1_MEMBER_SESSION, E2E_W2_OWNER_SESSION
 *     `meetsum_session` cookie values for the three seeded users
 *   E2E_W1_WORKSPACE_ID, E2E_W2_WORKSPACE_ID   (optional, `meetsum_workspace` cookie)
 *   E2E_BUDGET_MEETING_ID   the W1 meeting whose transcript contains "והתקציב"
 *   E2E_ROOM_NAME           a W1 room that contains that meeting
 *   E2E_PRIVATE_MEETING_ID, E2E_PRIVATE_TERM   W1 owner's private meeting and a term only it contains
 *   E2E_COLLIDING_TERM, E2E_W2_MEETING_ID      a term in both workspaces and the W2 meeting with it
 *
 * Degraded run (step 10): the tests tagged @lexical run against plain
 * postgres:16 with E2E_EXPECT_LEXICAL=1 and then expect the lexical badge.
 *   npx playwright test -g @lexical
 */
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test"

import { loadSuiteEnv } from "../../scripts/e2e/env-file"

// E2E_M6_ENV_FILE, then E2E_ENV_FILE, then .secrets/e2e.env (scripts/e2e/env-file.ts).
const env = loadSuiteEnv("m6")
/** The he Ask title carries a U+2060 word joiner before "MeetSum" (lib/i18n/m6/ask.ts). */
const HE_ASK_REGION = /שאלות ל-\u2060?MeetSum/
const EXPECT_LEXICAL = env.E2E_EXPECT_LEXICAL === "1"
const BUDGET_TERM = "תקציב"
const BUDGET_SURFACE = "והתקציב"

type Principal = "w1Owner" | "w1Member" | "w2Owner"

const SESSIONS: Record<Principal, { session?: string; workspace?: string }> = {
  w1Owner: { session: env.E2E_W1_OWNER_SESSION, workspace: env.E2E_W1_WORKSPACE_ID },
  w1Member: { session: env.E2E_W1_MEMBER_SESSION, workspace: env.E2E_W1_WORKSPACE_ID },
  w2Owner: { session: env.E2E_W2_OWNER_SESSION, workspace: env.E2E_W2_WORKSPACE_ID },
}

async function signIn(context: BrowserContext, baseURL: string | undefined, who: Principal) {
  const { session, workspace } = SESSIONS[who]

  test.skip(!session, `E2E env is missing the ${who} session (run npm run search:e2e-seed)`)

  const url = baseURL || "http://localhost:3000"

  await context.clearCookies()
  await context.addCookies([
    { name: "meetsum_session", value: session as string, url },
    ...(workspace ? [{ name: "meetsum_workspace", value: workspace, url }] : []),
  ])
}

function searchBox(page: Page) {
  return page.getByRole("searchbox").first()
}

async function search(page: Page, query: string) {
  await searchBox(page).fill(query)
  await searchBox(page).press("Enter")
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(query).replace(/%20/g, "(\\+|%20)")}`))
}

function meetingCards(page: Page) {
  return page.locator("[data-search-meeting]")
}

async function expectModeBadge(page: Page) {
  const badge = page.locator('[data-search-mode="lexical"]')

  if (EXPECT_LEXICAL) await expect(badge).toBeVisible()
  else await expect(badge).toHaveCount(0)
}

/** Seconds from a chip label such as "מקור 1: ישיבה, 1:23". */
function secondsFromLabel(label: string | null): number | undefined {
  const match = /(\d+):(\d{2})(?::(\d{2}))?\s*$/.exec(label ?? "")

  if (!match) return undefined

  return match[3] !== undefined
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : Number(match[1]) * 60 + Number(match[2])
}

async function playerSeconds(page: Page): Promise<number> {
  // The player's scrubber (components/player/scrubber.tsx, an explicit
  // role=slider with aria-valuenow), not the volume <input type=range> that
  // precedes it at the inbox breakpoint and carries no aria-valuenow.
  return Number(await page.locator('[role="slider"][aria-valuenow]').first().getAttribute("aria-valuenow"))
}

/**
 * Selects a meeting tab. Under `next dev` a click before hydration is lost,
 * so it clicks until the tab reports itself selected (M10 A5).
 */
async function openTab(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true })

  await expect(async () => {
    await tab.click()
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

async function ask(panel: Locator, question: string) {
  const box = panel.getByRole("textbox")

  await box.fill(question)
  await box.press("Enter")
}

function lastTurn(panel: Locator) {
  return panel.locator("li[data-ask-status]").last()
}

test.describe.configure({ mode: "serial" })

test.describe("M6 search", () => {
  test("1. Hebrew prefix search highlights the surface word in an RTL result @lexical", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await page.goto("/he/search")
    await search(page, BUDGET_TERM)

    const mark = page.locator("[data-search-snippet] mark", { hasText: BUDGET_SURFACE }).first()

    await expect(mark).toBeVisible()
    await expect(mark).toHaveText(BUDGET_SURFACE)
    await expect(mark.locator("xpath=ancestor::*[@data-search-snippet][1]")).toHaveAttribute("dir", "rtl")
    if (env.E2E_BUDGET_MEETING_ID) {
      await expect(page.locator(`[data-search-meeting="${env.E2E_BUDGET_MEETING_ID}"]`)).toBeVisible()
    }
    await expectModeBadge(page)
  })

  test("2. Room and date filters narrow results and round-trip through the URL @lexical", async ({ page, context, baseURL }) => {
    test.skip(!env.E2E_ROOM_NAME, "E2E_ROOM_NAME not set")
    await signIn(context, baseURL, "w1Owner")
    await page.goto(`/he/search?q=${encodeURIComponent(BUDGET_TERM)}`)
    await expect(meetingCards(page).first()).toBeVisible()

    const before = await meetingCards(page).count()

    await page.locator('[data-filter="חדרים"]').click()
    await page.getByRole("option", { name: env.E2E_ROOM_NAME }).click()
    await page.keyboard.press("Escape")
    await page.locator('[data-filter="date"]').click()
    await page.getByRole("radio", { name: "90 הימים האחרונים" }).click()
    await page.keyboard.press("Escape")

    await expect(page).toHaveURL(/[?&]room=/)
    await expect(page).toHaveURL(/[?&]range=90/)
    await expect(meetingCards(page).first()).toBeVisible()
    expect(await meetingCards(page).count()).toBeLessThanOrEqual(before)

    const url = page.url()

    await page.reload()
    expect(page.url()).toBe(url)
    await expect(searchBox(page)).toHaveValue(BUDGET_TERM)
    await expect(page.locator('[data-filter="חדרים"]')).toContainText("1")
    await expect(page.locator('[data-filter="date"]')).toContainText("90")
  })

  test("3. Clicking a hit opens the meeting at the segment @lexical", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await page.goto(`/he/search?q=${encodeURIComponent(BUDGET_TERM)}`)

    const hit = page.locator("[data-search-hit]", { has: page.locator("mark", { hasText: BUDGET_SURFACE }) }).first()

    await expect(hit).toBeVisible()
    await hit.click()
    await expect(page).toHaveURL(/[?&]meeting=[^&]+&t=\d+/)

    const t = Number(new URL(page.url()).searchParams.get("t"))

    await expect.poll(() => playerSeconds(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(t - 2)
    expect(Math.abs((await playerSeconds(page)) - t)).toBeLessThanOrEqual(2)

    await openTab(page, "תמלול")
    await expect(page.locator('[data-segment-id][aria-current="true"]')).toBeVisible()
  })
})

test.describe("M6 Ask", () => {
  test("4. Meeting Ask streams a cited Hebrew answer whose chip seeks the player", async ({ page, context, baseURL }) => {
    test.skip(!env.E2E_BUDGET_MEETING_ID, "E2E_BUDGET_MEETING_ID not set")
    await signIn(context, baseURL, "w1Owner")
    await page.goto(`/he?meeting=${encodeURIComponent(env.E2E_BUDGET_MEETING_ID)}`)
    await openTab(page, "שאלה")

    const panel = page.getByRole("region", { name: HE_ASK_REGION })

    await expect(panel.locator('[data-ask-scope="meeting"]')).toBeVisible({ timeout: 30_000 }) // the Ask panel is lazy (slow on a cold next dev)
    await ask(panel, "מה הוחלט לגבי התקציב?")

    const turn = lastTurn(panel)

    await expect(turn).toHaveAttribute("data-ask-status", /streaming|complete/)
    await expect(turn).toHaveAttribute("data-ask-status", "complete", { timeout: 30_000 })
    await expect(turn.locator('[dir="rtl"]').first()).toBeVisible()

    const chip = turn.locator("[data-citation]").first()

    await expect(chip).toBeVisible()

    const target = secondsFromLabel(await chip.getAttribute("aria-label"))

    await chip.click()
    expect(target).toBeDefined()
    await expect
      .poll(async () => Math.abs((await playerSeconds(page)) - (target ?? 0)), { timeout: 5_000 })
      .toBeLessThanOrEqual(1.5 + 0.5)
  })

  test("5. An unrelated question is refused with no chips", async ({ page, context, baseURL }) => {
    test.skip(!env.E2E_BUDGET_MEETING_ID, "E2E_BUDGET_MEETING_ID not set")
    await signIn(context, baseURL, "w1Owner")
    await page.goto(`/he?meeting=${encodeURIComponent(env.E2E_BUDGET_MEETING_ID)}`)
    await openTab(page, "שאלה")

    const panel = page.getByRole("region", { name: HE_ASK_REGION })

    await ask(panel, "מה מזג האוויר על מאדים בשנה הבאה?")

    const turn = lastTurn(panel)

    await expect(turn).toHaveAttribute("data-ask-status", "refused", { timeout: 30_000 })
    await expect(turn.locator("[data-citation]")).toHaveCount(0)
    await expect(turn).toContainText("לא מצאתי")
  })

  test("6. Global Ask answers in English and a chip opens another meeting", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await page.goto("/en/search?tab=ask")

    const panel = page.getByRole("region", { name: "Ask MeetSum" })

    await expect(panel.locator('[data-ask-scope="workspace"]')).toBeVisible({ timeout: 30_000 })
    await ask(panel, "What did we decide about the budget?")

    const turn = lastTurn(panel)

    await expect(turn).toHaveAttribute("data-ask-status", "complete", { timeout: 30_000 })
    await expect(turn.locator('[dir="ltr"]').first()).toBeVisible()

    const chip = turn.locator("a[data-citation]").first()

    await expect(chip).toBeVisible()

    const href = await chip.getAttribute("href")

    expect(href).toMatch(/^\/en\?meeting=[^&]+&t=\d+$/)
    await chip.click()
    await expect(page).toHaveURL(/\/en\?meeting=[^&]+&t=\d+/)
  })

  test("7. Threads reload with citations, and Stop saves an aborted message", async ({ page, context, baseURL }) => {
    test.skip(!env.E2E_BUDGET_MEETING_ID, "E2E_BUDGET_MEETING_ID not set")
    await signIn(context, baseURL, "w1Owner")

    // Workspace thread from step 6.
    await page.goto("/he/search?tab=ask")

    let panel = page.getByRole("region", { name: HE_ASK_REGION })

    await panel.getByRole("button", { name: "שיחות", exact: true }).click()
    await expect(panel.getByRole("navigation", { name: "שיחות" }).locator("li")).not.toHaveCount(0)

    // Meeting thread from steps 4–5: reload it and check the chips survive.
    await page.goto(`/he?meeting=${encodeURIComponent(env.E2E_BUDGET_MEETING_ID)}`)
    await openTab(page, "שאלה")
    panel = page.getByRole("region", { name: HE_ASK_REGION })
    await panel.getByRole("button", { name: "שיחות", exact: true }).click()

    // Steps 4 and 5 each open a thread; the newest is step 5's refusal (no
    // chips), so pick step 4's budget thread by its title.
    const threads = panel.getByRole("navigation", { name: "שיחות" }).locator("li > button")

    await threads.filter({ hasText: "התקציב" }).first().click()
    await expect(panel.locator('li[data-ask-status="complete"] [data-citation]').first()).toBeVisible({ timeout: 10_000 })

    // Stop mid-stream on a third question.
    await ask(panel, "מי אחראי על הצעדים הבאים?")
    await panel.getByRole("button", { name: "עצירה" }).click()
    await expect(lastTurn(panel)).toHaveAttribute("data-ask-status", "aborted")
  })
})

test.describe("M6 visibility", () => {
  test("8a. A W1 member never sees the owner's private meeting in search or Ask", async ({ page, context, baseURL }) => {
    test.skip(!env.E2E_PRIVATE_MEETING_ID || !env.E2E_PRIVATE_TERM, "private meeting env not set")
    await signIn(context, baseURL, "w1Member")
    await page.goto("/he/search")
    await search(page, env.E2E_PRIVATE_TERM)
    await expect(page.locator("[data-search-meeting], [role='status']").first()).toBeVisible()
    await expect(page.locator(`[data-search-meeting="${env.E2E_PRIVATE_MEETING_ID}"]`)).toHaveCount(0)

    await page.goto("/he/search?tab=ask")

    const panel = page.getByRole("region", { name: HE_ASK_REGION })

    await ask(panel, `מה נאמר על ${env.E2E_PRIVATE_TERM}?`)
    await expect(lastTurn(panel)).toHaveAttribute("data-ask-status", /complete|refused/, { timeout: 30_000 })
    await expect(panel.locator(`a[data-citation][href*="meeting=${encodeURIComponent(env.E2E_PRIVATE_MEETING_ID)}"]`)).toHaveCount(0)
  })

  test("8b. A W2 owner gets only the W2 meeting for a colliding term", async ({ page, context, baseURL }) => {
    test.skip(!env.E2E_COLLIDING_TERM || !env.E2E_W2_MEETING_ID, "colliding-term env not set")
    await signIn(context, baseURL, "w2Owner")
    await page.goto("/he/search")
    await search(page, env.E2E_COLLIDING_TERM)
    await expect(meetingCards(page).first()).toBeVisible()

    const ids = await meetingCards(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-search-meeting")))

    expect(ids).toEqual([env.E2E_W2_MEETING_ID])
  })
})

test("9. /en/search is LTR with English strings", async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, "w1Owner")
  await page.goto("/en/search")
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr")
  await expect(page.getByRole("heading", { level: 1, name: "Search & Ask" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Search", exact: true })).toBeVisible()
  await expect(searchBox(page)).toHaveAttribute("placeholder", "Search meetings, people, decisions…")
})

test("palette: Ctrl/Cmd+K opens search-as-you-type and jumps to a meeting", async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, "w1Owner")
  await page.goto("/he/search")

  const dialog = page.getByRole("dialog")

  // The shortcut listener attaches on hydration (late under `next dev`): retry the key.
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+k")
    await expect(dialog).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await dialog.getByRole("combobox").fill(BUDGET_TERM)
  await expect(dialog.getByRole("option").first()).toBeVisible()
  await expect(dialog.getByRole("option", { name: /שאלה על/ })).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/[?&](meeting=|tab=ask)/)
})
