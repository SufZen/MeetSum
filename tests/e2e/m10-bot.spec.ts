/**
 * M10 bot webhook flow (docs/parity/m10.md, A4), in the `core` job:
 * "Join now" with a Meet link → signed Vexa webhooks walk the status pill
 * joining → awaiting admission → recording → processing → finalize ingests
 * the fake recording, the fake ASR transcribes it and the transcript appears;
 * a replayed event is not applied twice and a bad signature gets 401.
 *
 * Prerequisites (besides the core-flow ones): MEETSUM_BOT_ENABLED=true,
 * VEXA_API_URL=http://127.0.0.1:18056, a per-run VEXA_WEBHOOK_SECRET and
 * VEXA_API_KEY, and the fake Vexa serving the fixture recording:
 *   npx tsx scripts/bot-simulate.ts --serve-only --wav tests/fixtures/e2e/media/he-en-30s.wav --port 18056
 * The webhooks are posted here with the simulator's own helpers.
 */
import { expect, test, type Page } from "@playwright/test"

import { postSimulatedWebhook, simulationArgs, simulationBody } from "../../scripts/bot-simulate"

import { assertLocalBaseUrl, BASE_URL, clickUntilVisible, scanA11y, shot, signIn, waitForCompleted } from "./m10-env"

const FAKE_VEXA = `http://127.0.0.1:${process.env.E2E_FAKE_VEXA_PORT || "18056"}`
const NATIVE_ID = "abc-defg-hij"
const SECRET = process.env.VEXA_WEBHOOK_SECRET ?? ""
const args = simulationArgs({ url: BASE_URL, nativeId: NATIVE_ID })
const runId = `e2e${Date.now().toString(36)}`

test.describe.configure({ mode: "serial" })

test.beforeAll(() => {
  assertLocalBaseUrl()
})

async function fakeVexaStats(page: Page): Promise<{ botsRequested: number; recordingFetches: number }> {
  const response = await page.request.get(`${FAKE_VEXA}/__fake/stats`)

  return response.ok() ? response.json() : { botsRequested: 0, recordingFetches: 0 }
}

function stepLabel(page: Page) {
  return page.getByRole("region", { name: "התקדמות בוט הפגישות" }).locator("b[aria-live]")
}

let meetingId = ""

test("bot: join now, status walk, finalize into a transcript, replay and signature checks", async ({ page, context }) => {
  test.skip(!SECRET, "VEXA_WEBHOOK_SECRET is not set (scripts/e2e/ci-env.sh core)")
  test.setTimeout(300_000)
  await signIn(context, "owner")

  const before = (await fakeVexaStats(page)).botsRequested

  // 1. Join now with a Meet link.
  await page.goto("/he")

  const menuItem = page.getByRole("menuitem", { name: "שליחת בוט לפגישה" })
  const dialog = page.getByRole("dialog", { name: "שליחת הבוט לפגישה" })

  await clickUntilVisible(page.getByRole("button", { name: "שליחת בוט לפגישה" }).first(), menuItem.or(dialog))
  if (await menuItem.isVisible()) await menuItem.click()
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("קישור לפגישה או טקסט ההזמנה").fill(`https://meet.google.com/${NATIVE_ID}`)
  await scanA11y(page, "bot-join-dialog")

  const joined = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/meetings/bot" && response.request().method() === "POST")

  await dialog.getByRole("button", { name: "שליחת בוט", exact: true }).click()

  const response = await joined

  expect(response.ok()).toBe(true)
  meetingId = ((await response.json()) as { meeting: { id: string } }).meeting.id
  expect(meetingId).toBeTruthy()

  // The bot worker dispatched to the fake Vexa (which answers with meeting id 4242).
  await expect.poll(async () => (await fakeVexaStats(page)).botsRequested, { timeout: 60_000 }).toBeGreaterThan(before)

  // 2. The status walk, one signed webhook per step.
  await page.goto(`/he?meeting=${encodeURIComponent(meetingId)}`)

  // `null`: done. A completed session is not open, so the strip drops its
  // step list and the meeting's own processing pill takes over (docs/parity/
  // m7.md, bot-status-strip; tests/bot-ui-state.test.ts).
  const walk: Array<[string, RegExp | null | undefined]> = [
    ["status-requested", undefined],
    ["status-joining", /מצטרף/],
    ["status-awaiting_admission", /ממתין לאישור/],
    ["status-active", /מקליט/],
    ["completed", null],
  ]

  for (const [step, label] of walk) {
    const posted = await postSimulatedWebhook(BASE_URL, SECRET, simulationBody(step, args, runId))

    expect(posted.status, `${step} webhook`).toBe(200)
    if (label) await expect(stepLabel(page)).toHaveText(label, { timeout: 30_000 })
    if (label === null) await expect(stepLabel(page)).toHaveCount(0, { timeout: 30_000 })
    if (step === "status-active") await shot(page, "bot-recording")
  }

  // 3. Finalize fetched the fake recording; fake ASR + replay complete the meeting.
  await expect.poll(async () => (await fakeVexaStats(page)).recordingFetches, { timeout: 120_000 }).toBeGreaterThan(0)
  await waitForCompleted(page.request, meetingId, 180_000)
  await page.goto(`/he?meeting=${encodeURIComponent(meetingId)}&tab=transcript`)
  await expect(page.locator("article[data-segment-id]")).toHaveCount(6, { timeout: 30_000 })
  await shot(page, "bot-transcript")

  // 4. A replayed event (same event id) is not applied twice; a bad signature is refused.
  const replayed = await postSimulatedWebhook(BASE_URL, SECRET, simulationBody("status-active", args, runId))

  expect(replayed.status).toBe(200)
  expect(await replayed.json()).toMatchObject({ duplicate: true })

  const forged = await postSimulatedWebhook(BASE_URL, `${SECRET}-wrong`, simulationBody("status-joining", args, `${runId}x`))

  expect(forged.status).toBe(401)

  // The meeting is still completed: the replay did not move it back to recording.
  const detail = await page.request.get(`/api/meetings/${encodeURIComponent(meetingId)}`)

  expect(((await detail.json()) as { meeting: { status: string } }).meeting.status).toBe("completed")
})
