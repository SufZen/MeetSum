/**
 * M10 core flow (docs/parity/m10.md, A3), in Hebrew, with no keys:
 * upload → processing → transcript → LLM summary → Ask → search → share →
 * visibility → the Redis-down state → axe.
 *
 * Prerequisites (the `core` job of .github/workflows/e2e.yml does all of it):
 *   Postgres + Redis + an S3 server; scripts/e2e/ci-env.sh core
 *   npm run db:migrate && npm run m10:e2e-seed
 *   npm run integrations:fake           # fake providers + fake ASR (127.0.0.1:4010/asr)
 *   npm run worker; next dev (NODE_ENV=development)
 *   LOCAL_TRANSCRIPTION_URL=http://127.0.0.1:4010/asr, MEETSUM_ASR_CHAIN=local-whisper-chunked,
 *   MEETSUM_LLM_REPLAY_DIR=tests/fixtures/e2e/llm-replay, MEETSUM_EMBEDDING_PROVIDER=hash
 *   npx playwright test --project=core
 *
 * The audio is tests/fixtures/e2e/media/he-en-30s.wav (a tone sequence; the
 * fake ASR supplies the "speech"), and the summary comes from the structured
 * replay: pipeline wiring evidence, not quality evidence. Step 9 stops the
 * Redis container named by E2E_REDIS_CONTAINER and is skipped without it.
 * Screenshots and the axe report go to test-results/m10/ (never committed).
 */
import { spawnSync } from "node:child_process"

import { expect, test, type Page } from "@playwright/test"

import {
  assertLocalBaseUrl,
  clickUntilVisible,
  MEDIA_FILE,
  meetingStatus,
  ORIGIN,
  playerSeconds,
  scanA11y,
  secondsFromLabel,
  shot,
  signIn,
  waitForCompleted,
} from "./m10-env"

/** The he Ask title carries a U+2060 word joiner before "MeetSum" (lib/i18n/m6/ask.ts). */
const HE_ASK_REGION = /שאלות ל-\u2060?MeetSum/
const DECISION = "הוחלט להגדיל את תקציב השיווק"
const ENGLISH_SEGMENT = "Let's start with the marketing budget"

let meetingId = ""
let shareUrl = ""

test.describe.configure({ mode: "serial" })

test.beforeAll(() => {
  assertLocalBaseUrl()
})

async function openMeeting(page: Page, tab?: "transcript" | "ask") {
  await page.goto(`/he?meeting=${encodeURIComponent(meetingId)}${tab ? `&tab=${tab}` : ""}`)
  await expect(page.getByRole("tab", { name: "סיכום", exact: true })).toBeVisible({ timeout: 30_000 })
}

test("1. upload he-en-30s.wav through the upload drawer; the meeting shows as processing", async ({ page, context }) => {
  await signIn(context, "owner")
  // The upload drawer files into the selected meeting, and the shell selects
  // the first inbox row by default (the bot spec's meeting may already be
  // there). A deep link to a meeting that doesn't exist selects nothing, so
  // the upload creates a new meeting (asserted below).
  await page.goto("/he?meeting=e2e_m10_no_such_meeting")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await scanA11y(page, "inbox")

  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/meetings" && response.request().method() === "POST")

  const drawer = page.getByRole("dialog", { name: "העלאת מדיה של פגישה" })

  await clickUntilVisible(page.getByRole("button", { name: "העלאה", exact: true }), drawer)
  await scanA11y(page, "upload-drawer")

  const uploaded = page.waitForResponse((response) => /\/api\/meetings\/[^/]+\/upload$/.test(new URL(response.url()).pathname) && response.request().method() === "POST")

  await drawer.locator("input[type=file]").setInputFiles(MEDIA_FILE)

  const newMeeting = await created

  expect(newMeeting.status()).toBe(201)

  const response = await uploaded

  expect(response.status()).toBe(202)
  meetingId = decodeURIComponent(new URL(response.url()).pathname.split("/")[3] ?? "")
  expect(meetingId).toBe(((await newMeeting.json()) as { meeting: { id: string } }).meeting.id)

  // Processing is fast with the fakes: the pill is checked softly, the API
  // state strictly.
  const { meeting } = await meetingStatus(page.request, meetingId)

  expect(meeting?.status).toBeTruthy()
  await expect.soft(page.getByText("בעיבוד").first()).toBeVisible({ timeout: 10_000 })
  await shot(page, "01-processing")
})

test("2. the worker prepares, transcribes (fake ASR), summarizes (replay) and indexes", async ({ page, context }) => {
  test.skip(!meetingId, "needs step 1")
  await signIn(context, "owner")
  await waitForCompleted(page.request, meetingId, 120_000)

  const detail = await page.request.get(`/api/meetings/${encodeURIComponent(meetingId)}?include=transcript`)
  const body = (await detail.json()) as { meeting: { transcript?: Array<{ text: string }>; intelligence?: { generation?: { provider?: string; model?: string } } } }

  expect(body.meeting.transcript?.length).toBe(6)
})

test("3. the transcript tab: per-segment dir, bdi, click-to-seek", async ({ page, context }) => {
  test.skip(!meetingId, "needs step 1")
  await signIn(context, "owner")
  await openMeeting(page, "transcript")

  const segments = page.locator("article[data-segment-id]")

  await expect(segments).toHaveCount(6, { timeout: 30_000 })

  const hebrew = segments.filter({ hasText: DECISION }).first()
  const english = segments.filter({ hasText: ENGLISH_SEGMENT }).first()

  await expect(hebrew.locator("p[dir]").first()).toHaveAttribute("dir", "rtl")
  await expect(english.locator("p[dir]").first()).toHaveAttribute("dir", "ltr")
  expect(await segments.first().locator("bdi").count()).toBeGreaterThan(0)
  await scanA11y(page, "transcript")

  // Segment 4 starts at 0:16.
  const fourth = segments.nth(3)
  const timecode = fourth.getByRole("button", { name: /^ניגון מ/ }).first()
  const target = secondsFromLabel(await timecode.getAttribute("aria-label")) ?? 16

  await timecode.click()
  await expect.poll(() => playerSeconds(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(target - 1)
  expect(Math.abs((await playerSeconds(page)) - target)).toBeLessThanOrEqual(2)
  await shot(page, "03-transcript")
})

test("4. the summary tab shows the LLM summary with Hebrew sections and seeking citations", async ({ page, context }) => {
  test.skip(!meetingId, "needs step 1")
  await signIn(context, "owner")
  await openMeeting(page)

  await expect(page.getByText(DECISION).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("סיכום אוטומטי (ללא AI)")).toHaveCount(0)
  await expect(page.getByText(/סיכום AI/).first()).toBeVisible()
  await expect(page.getByText("החלטות").first()).toBeVisible()
  await scanA11y(page, "summary")

  const chip = page.getByRole("tabpanel").getByRole("button", { name: /^ניגון מ/ }).first()

  await expect(chip).toBeVisible()

  const target = secondsFromLabel(await chip.getAttribute("aria-label"))

  expect(target).toBeDefined()
  await chip.click()
  await expect.poll(async () => Math.abs((await playerSeconds(page)) - (target ?? 0)), { timeout: 10_000 }).toBeLessThanOrEqual(2)
  await shot(page, "04-summary")
})

test("5. Ask streams a replayed answer whose citation chip seeks", async ({ page, context }) => {
  test.skip(!meetingId, "needs step 1")
  await signIn(context, "owner")
  await openMeeting(page, "ask")

  const panel = page.getByRole("region", { name: HE_ASK_REGION })
  const box = panel.getByRole("textbox")

  await box.fill("מה הוחלט לגבי התקציב?")
  await box.press("Enter")

  const turn = panel.locator("li[data-ask-status]").last()

  await expect(turn).toHaveAttribute("data-ask-status", "complete", { timeout: 60_000 })

  const chip = turn.locator("[data-citation]").first()

  await expect(chip).toBeVisible()

  const target = secondsFromLabel(await chip.getAttribute("aria-label"))

  await chip.click()
  await expect.poll(async () => Math.abs((await playerSeconds(page)) - (target ?? 0)), { timeout: 10_000 }).toBeLessThanOrEqual(2)
  await scanA11y(page, "ask")
  await shot(page, "05-ask")
})

test("6. ⌘K search for תקציב finds the meeting", async ({ page, context }) => {
  test.skip(!meetingId, "needs step 1")
  await signIn(context, "owner")

  const { meeting } = await meetingStatus(page.request, meetingId)
  const title = meeting?.title ?? "he-en-30s"

  await page.goto("/he")
  await expect(page.getByRole("button", { name: "העלאה", exact: true })).toBeVisible({ timeout: 30_000 })

  // Indexing is a debounced job: retry the search until the meeting shows up.
  await expect
    .poll(
      async () => {
        await page.keyboard.press("Escape")
        await page.keyboard.press("ControlOrMeta+k")

        const input = page.getByRole("combobox", { name: "חיפוש ושאלות" })

        // A shortcut pressed before hydration is lost: a palette that did not
        // open is another poll round, not a thrown error that ends the poll.
        // (isVisible() does not wait, so the results are awaited explicitly.)
        if (!(await input.waitFor({ timeout: 5_000 }).then(() => true, () => false))) return false
        await input.fill("תקציב")
        return page.getByRole("option").filter({ hasText: title }).first().waitFor({ timeout: 5_000 }).then(() => true, () => false)
      },
      { timeout: 90_000, intervals: [2_000, 5_000] }
    )
    .toBe(true)
  await scanA11y(page, "palette")
  await shot(page, "06-search")
})

test("7. a share link opens in a fresh context: RTL, transcript, media range requests", async ({ browser, page, context }) => {
  test.skip(!meetingId, "needs step 1")
  await signIn(context, "owner")
  await openMeeting(page)
  const dialog = page.getByRole("dialog", { name: "שיתוף הפגישה" })

  await clickUntilVisible(page.getByRole("button", { name: "שיתוף", exact: true }), dialog)

  const link = dialog.getByLabel("קישור לשיתוף")

  await expect(link).toHaveValue(/\/share\//, { timeout: 30_000 })

  const recording = dialog.getByRole("checkbox", { name: "כולל ההקלטה" })

  if (!(await recording.isChecked())) {
    const patched = page.waitForResponse((response) => response.url().includes("/share") && response.request().method() === "PATCH")

    await recording.click()
    await patched
  }
  await scanA11y(page, "share-dialog")
  shareUrl = await link.inputValue()
  await page.keyboard.press("Escape")

  const visitor = await browser.newContext({ locale: "he-IL", extraHTTPHeaders: { "accept-language": "he-IL" } })
  const share = await visitor.newPage()
  const token = new URL(shareUrl).pathname.split("/").pop() ?? ""

  await share.goto(`/share/${token}`)
  await expect(share.locator("html")).toHaveAttribute("dir", "rtl")
  await expect(share.getByText(DECISION).first()).toBeVisible({ timeout: 30_000 })
  await scanA11y(share, "share-page")
  await shot(share, "07-share")

  const ranged = await visitor.request.get(`/api/share/${token}/media?variant=audio`, { headers: { range: "bytes=0-99" } })

  expect(ranged.status()).toBe(206)
  expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-99\//)
  await visitor.close()
})

test("8. visibility: the member sees it, then not once private; W2 never does", async ({ browser, page, context }) => {
  test.skip(!meetingId, "needs step 1")

  const member = await browser.newContext()
  const w2 = await browser.newContext()

  await signIn(member, "member")
  await signIn(w2, "w2")
  expect((await meetingStatus(member.request, meetingId)).http).toBe(200)
  expect((await meetingStatus(w2.request, meetingId)).http).toBe(404)

  await signIn(context, "owner")
  await openMeeting(page)
  const privateItem = page.getByRole("menuitemradio", { name: "פרטית" })

  await clickUntilVisible(page.getByRole("button", { name: /^נראות:/ }), privateItem)
  await privateItem.click()

  const confirm = page.getByRole("button", { name: "שינוי נראות" })

  const updated = page.getByText("הנראות עודכנה").first()

  // Step 7's share link makes this a confirm ("revoke the public link?").
  // isVisible() does not wait, so it missed the dialog that opens a beat
  // later: wait for the dialog or the toast, whichever comes.
  await expect(confirm.or(updated).first()).toBeVisible({ timeout: 15_000 })
  if (await confirm.isVisible()) await confirm.click()
  await expect(updated).toBeVisible({ timeout: 15_000 })

  await expect.poll(async () => (await meetingStatus(member.request, meetingId)).http, { timeout: 10_000 }).toBe(404)
  expect((await meetingStatus(w2.request, meetingId)).http).toBe(404)

  const memberPage = await member.newPage()

  await memberPage.goto(`/he?meeting=${encodeURIComponent(meetingId)}`)
  await expect(memberPage.getByText("הפגישה אינה זמינה.")).toBeVisible({ timeout: 30_000 })
  await scanA11y(memberPage, "meeting-unavailable")
  await shot(memberPage, "08-member-404")

  const w2Page = await w2.newPage()

  await w2Page.goto(`/he?meeting=${encodeURIComponent(meetingId)}`)
  await expect(w2Page.getByText("הפגישה אינה זמינה.")).toBeVisible({ timeout: 30_000 })
  await member.close()
  await w2.close()
})

test("9. with Redis stopped, regenerate shows the non-blocking queue state (no hang)", async ({ page, context }) => {
  const container = process.env.E2E_REDIS_CONTAINER

  test.skip(!meetingId || !container, "needs step 1 and E2E_REDIS_CONTAINER")
  await signIn(context, "owner")
  await openMeeting(page)

  const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 })

  expect(docker("stop", container!).status).toBe(0)
  try {
    const started = Date.now()

    await page.getByRole("button", { name: "יצירה מחדש" }).first().click()
    await expect(page.getByRole("status").filter({ hasText: "לא הצלחנו להוסיף לתור" })).toBeVisible({ timeout: 20_000 })
    // Bounded by MEETSUM_QUEUE_ENQUEUE_TIMEOUT_MS (3 s in CI), not a hang.
    expect(Date.now() - started).toBeLessThan(20_000)
    await shot(page, "09-redis-down")
  } finally {
    expect(docker("start", container!).status).toBe(0)
    await expect.poll(() => docker("exec", container!, "redis-cli", "ping").stdout.trim(), { timeout: 30_000 }).toBe("PONG")
  }

  // The app recovers once Redis is back.
  const recovered = await page.request.post(`/api/meetings/${encodeURIComponent(meetingId)}/intelligence/run`, { data: {}, headers: ORIGIN })

  expect([200, 202]).toContain(recovered.status())
})

// Step 10 (axe) runs inside steps 1–8: `scanA11y` fails the step on any
// serious/critical finding outside scripts/axe-allowlist.json and writes
// test-results/m10/a11y-report.json.
