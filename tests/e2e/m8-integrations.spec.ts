/**
 * M8 Integrations browser e2e against the fake providers
 * (docs/parity/m8.md, Acceptance 14; Package D5).
 *
 * Prerequisites (no real keys; the orchestrator runs them):
 *   docker compose up postgres redis
 *   npm run db:migrate && npm run integrations:e2e-seed
 *   npm run integrations:fake                         # 127.0.0.1:4010
 *   app + worker with NODE_ENV=development,
 *     MEETSUM_INTEGRATIONS_FAKE_BASE_URL=http://127.0.0.1:4010,
 *     MEETSUM_OAUTH_REDIRECT_BASE=http://localhost:3000,
 *     fake client ids and secrets for every provider (any non-empty value),
 *     MEETSUM_EMAIL_PROVIDER=log, E2E_EMAIL_CAPTURE_FILE=.secrets/e2e-emails.jsonl,
 *     MEETSUM_WEBHOOK_ALLOWED_HOSTS=127.0.0.1 (the fake webhook receiver is loopback),
 *     MEETSUM_MS_CALENDAR_SYNC_MINUTES=1
 *   E2E_BASE_URL=http://localhost:3000 npm run test:e2e -- m8
 *
 * The seed writes test sessions and ids to E2E_ENV_FILE (default
 * `.secrets/e2e-m8.env`): E2E_M8_W1_OWNER_SESSION, E2E_M8_W1_MEMBER_SESSION,
 * E2E_M8_W2_OWNER_SESSION, E2E_M8_W1_WORKSPACE_ID, E2E_M8_W2_WORKSPACE_ID,
 * E2E_M8_HEBREW_MEETING_ID, E2E_M8_PRIVATE_MEETING_ID, E2E_M8_CALENDAR_MEETING_ID,
 * E2E_M8_RECAP_MEETING_ID,
 * E2E_M8_ICAL_UID, E2E_M8_MEMBER_EMAIL.
 *
 * Fake-server inspection contract (Package A, scripts/fake-providers.ts):
 *   GET    {FAKE}/__fake/requests?provider=<id>   → {requests: [{provider, method, path, query, headers, body, rawBody?}]}
 *   DELETE {FAKE}/__fake/requests                 → clears the log
 *   POST   {FAKE}/__fake/webhook                  → webhook receiver (recorded as provider "webhook")
 * Requests are recorded with tokens redacted.
 *
 * If Playwright browsers can't be installed on the host, the orchestrator
 * runs the same steps in the in-app browser and attaches screenshots.
 */
import { spawnSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { inflateRawSync } from "node:zlib"

import { expect, test, type BrowserContext, type Page } from "@playwright/test"

import { dictionaries } from "@/lib/i18n/dictionaries"

import { loadSuiteEnv } from "../../scripts/e2e/env-file"

// E2E_M8_ENV_FILE, then E2E_ENV_FILE, then .secrets/e2e-m8.env (scripts/e2e/env-file.ts).
const loadEnvFile = () => loadSuiteEnv("m8")

const env = loadEnvFile()
const FAKE = env.E2E_FAKE_BASE_URL || "http://127.0.0.1:4010"
const EMAIL_FILE = env.E2E_EMAIL_CAPTURE_FILE || ".secrets/e2e-emails.jsonl"
const he = dictionaries.he
const en = dictionaries.en
const RLM = "‏"

type Principal = "w1Owner" | "w1Member" | "w2Owner"

const SESSIONS: Record<Principal, { session?: string; workspace?: string }> = {
  w1Owner: { session: env.E2E_M8_W1_OWNER_SESSION, workspace: env.E2E_M8_W1_WORKSPACE_ID },
  w1Member: { session: env.E2E_M8_W1_MEMBER_SESSION, workspace: env.E2E_M8_W1_WORKSPACE_ID },
  w2Owner: { session: env.E2E_M8_W2_OWNER_SESSION, workspace: env.E2E_M8_W2_WORKSPACE_ID },
}

async function signIn(context: BrowserContext, baseURL: string | undefined, who: Principal) {
  const { session, workspace } = SESSIONS[who]

  test.skip(!session, `E2E env is missing the ${who} session (run npm run integrations:e2e-seed)`)
  const url = baseURL || "http://localhost:3000"

  await context.clearCookies()
  await context.addCookies([
    { name: "meetsum_session", value: session as string, url },
    ...(workspace ? [{ name: "meetsum_workspace", value: workspace, url }] : []),
  ])
}

type FakeRequest = {
  provider?: string
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
  rawBody?: string
}

async function fakeRequests(provider: string, pathPart?: string): Promise<FakeRequest[]> {
  const response = await fetch(`${FAKE}/__fake/requests?provider=${encodeURIComponent(provider)}`)
  const body = (await response.json()) as { requests?: FakeRequest[] }

  return (body.requests ?? []).filter((request) => !pathPart || request.path.includes(pathPart))
}

/** Seeds' `--complete`: the real dispatch path without ASR. */
function completeMeeting(meetingId: string) {
  const result = spawnSync("npx", ["tsx", "scripts/integrations-e2e-seed.ts", "--complete", meetingId], {
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  })

  expect(result.status, result.stderr).toBe(0)
}

async function openIntegrations(page: Page, locale: "he" | "en") {
  await page.goto(`/${locale}?panel=settings&section=integrations`)
  await expect(page.getByTestId("integrations-settings")).toBeVisible({ timeout: 30_000 })
}

function card(page: Page, provider: string) {
  return page.locator(`article[data-provider="${provider}"]`)
}

const PROVIDER_NAMES: Record<string, string> = {
  slack: he.integrationsProviderSlack,
  notion: he.integrationsProviderNotion,
  hubspot: he.integrationsProviderHubspot,
  microsoft: he.integrationsProviderMicrosoft,
}

/** Connect / Reconnect is a full-page navigation; the fake authorize page auto-approves. */
async function connect(page: Page, provider: string) {
  // The exact accessible name ("חיבור: Slack"): a substring match would also hit "בדיקת החיבור".
  await card(page, provider)
    .getByRole("button", { name: `${he.integrationsConnect}: ${PROVIDER_NAMES[provider]}`, exact: true })
    .click()
  await page.waitForURL(/section=integrations/, { timeout: 30_000 })
  await expect(page.getByTestId("integrations-settings")).toBeVisible()
  await expect(card(page, provider).getByTestId("integration-account").locator("bdi")).toBeVisible()
}

/** Picks the first option as the connection's default destination and waits until it is saved. */
async function setDefaultDestination(page: Page, provider: "slack" | "notion") {
  const providerCard = card(page, provider)
  const saved = page.waitForResponse(
    (response) => /\/api\/integrations\/connections\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === "PATCH"
  )

  await providerCard.getByText(he.integrationsDefaultDestination).click()
  await providerCard.getByRole("list").getByRole("button").first().click()
  expect((await saved).status()).toBe(200)
  // The summary shows the saved name once the card reloads the connection.
  await expect(providerCard.locator("summary bdi")).toBeVisible()
}

const ORIGIN_HEADERS = (baseURL: string | undefined) => ({ origin: baseURL || "http://localhost:3000" })

/** Renames a meeting through the API: a real content change for the next re-send. */
async function renameMeeting(page: Page, baseURL: string | undefined, meetingId: string, title: string) {
  const response = await page.request.patch(`/api/meetings/${encodeURIComponent(meetingId)}`, {
    data: { title },
    headers: ORIGIN_HEADERS(baseURL),
  })

  expect(response.status()).toBe(200)
}

async function meetingTitle(page: Page, meetingId: string): Promise<string> {
  const response = await page.request.get(`/api/meetings/${encodeURIComponent(meetingId)}`)
  const body = (await response.json()) as { meeting?: { title?: string }; title?: string }

  return body.meeting?.title ?? body.title ?? ""
}

async function openMeeting(page: Page, meetingId: string, locale: "he" | "en" = "he") {
  await page.goto(`/${locale}?meeting=${encodeURIComponent(meetingId)}`)
  await expect(page.getByRole("button", { name: dictionaries[locale].meetingActions })).toBeVisible({ timeout: 30_000 })
}

async function meetingMenu(page: Page) {
  await page.getByRole("button", { name: he.meetingActions }).click()
}

/**
 * Sends from the ⋯ menu and waits for *this* send's delivery to be sent. The
 * "<provider>: sent" toast alone is not enough: a toast from the previous
 * send can still be on screen, so the delivery id of this POST is polled.
 */
async function sendFromMeeting(page: Page, providerLabel: string) {
  await meetingMenu(page)
  await page.getByRole("menuitem", { name: he.exportSendTo || he.integrationsRuleDestination }).click()

  const posted = page.waitForResponse(
    (response) => /\/api\/meetings\/[^/]+\/integrations\/send$/.test(new URL(response.url()).pathname) && response.request().method() === "POST"
  )

  await page.getByRole("menuitem", { name: new RegExp(providerLabel) }).click()

  const response = await posted

  expect(response.ok(), `send ${providerLabel}`).toBe(true)
  const { deliveryId } = (await response.json()) as { deliveryId: string }

  await expect
    .poll(
      async () => {
        const delivery = (await (await page.request.get(`/api/integrations/deliveries/${encodeURIComponent(deliveryId)}`)).json()) as {
          delivery?: { status?: string }
          status?: string
        }

        return delivery.delivery?.status ?? delivery.status
      },
      { timeout: 30_000 }
    )
    .toBe("sent")
  await expect(page.getByText(new RegExp(`${providerLabel}: ${he.integrationsStatusSent}`)).last()).toBeVisible({ timeout: 30_000 })
}

async function deliveryRows(page: Page) {
  await openIntegrations(page, "he")

  return page.locator("[data-delivery-id]")
}

function emails(): { to?: string | string[]; subject?: string; html?: string; headers?: Record<string, string>; raw?: string }[] {
  if (!existsSync(EMAIL_FILE)) return []

  return readFileSync(EMAIL_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Reads one entry of a .docx (zip) without a zip dependency. */
function zipEntry(buffer: Buffer, name: string): string | undefined {
  let offset = 0

  while (offset + 30 < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8)
    const compressed = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const entryName = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8")
    const start = offset + 30 + nameLength + extraLength
    const data = buffer.subarray(start, start + compressed)

    if (entryName === name) return (method === 8 ? inflateRawSync(data) : data).toString("utf8")
    offset = start + compressed
  }

  return undefined
}

const state: { slackRuleName: string; deliveryId?: string; ruleId?: string; secret?: string } = {
  slackRuleName: "סיכומים לערוץ המכירות",
}

test.describe.serial("M8 integrations with fake providers", () => {
  test.beforeAll(async () => {
    await fetch(`${FAKE}/__fake/requests`, { method: "DELETE" }).catch(() => undefined)
  })

  test("1. W1 owner sees the test-providers banner and connects Slack", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    await expect(page.locator("[dir=rtl]").getByTestId("integrations-fake-banner")).toBeVisible()
    await connect(page, "slack")
    await expect(card(page, "slack").getByText(he.integrationsStatusNeedsReauth)).toHaveCount(0)
    await expect(card(page, "slack").getByText(he.integrationsStatusError)).toHaveCount(0)
  })

  test("2. a Slack rule posts the Hebrew recap once completed", async ({ page, context, baseURL }) => {
    test.setTimeout(180_000)
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    await page.getByRole("button", { name: he.integrationsRuleNew }).click()
    const drawer = page.getByRole("dialog")

    await drawer.getByLabel(he.integrationsRuleName).fill(state.slackRuleName)
    const channels = drawer.getByRole("list", { name: he.integrationsSlackChannel })

    await expect(channels.getByRole("button").first()).toBeVisible()
    const firstPage = await channels.getByRole("button").count()
    const more = drawer.getByRole("button", { name: he.integrationsPickerLoadMore })

    // The fake workspace has more channels than one page: the picker paginates.
    await expect(more).toBeVisible()
    await more.click()
    await expect.poll(() => channels.getByRole("button").count()).toBeGreaterThan(firstPage)
    await channels.getByRole("button").first().click()
    await drawer.getByRole("button", { name: he.integrationsRuleSave }).click()
    await expect(page.locator("[data-rule-id]").filter({ hasText: state.slackRuleName })).toBeVisible()
    state.ruleId = (await page.locator("[data-rule-id]").filter({ hasText: state.slackRuleName }).getAttribute("data-rule-id")) ?? undefined

    completeMeeting(env.E2E_M8_HEBREW_MEETING_ID)
    await expect
      .poll(async () => (await deliveryRows(page)).and(page.locator('[data-status="sent"]')).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    state.deliveryId = (await page.locator('[data-delivery-id][data-status="sent"]').first().getAttribute("data-delivery-id")) ?? undefined

    const posts = await fakeRequests("slack", "chat.postMessage")

    expect(posts.length).toBeGreaterThan(0)
    const message = posts.at(-1)!.body as { blocks?: { type: string; text?: { text?: string }; elements?: { url?: string }[] }[] }

    expect(message.blocks?.length ?? 0).toBeLessThanOrEqual(50)
    for (const block of message.blocks ?? []) {
      for (const line of (block.text?.text ?? "").split("\n").filter(Boolean)) expect(line.startsWith(RLM), line).toBe(true)
    }
    expect(JSON.stringify(message)).toContain(env.E2E_M8_HEBREW_MEETING_ID)
  })

  test("3. completing again does not post twice", async () => {
    const before = (await fakeRequests("slack", "chat.postMessage")).length

    completeMeeting(env.E2E_M8_HEBREW_MEETING_ID)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect((await fakeRequests("slack", "chat.postMessage")).length).toBe(before)
  })

  test("4. Notion: one page; an unchanged re-send is a no-op, a changed one updates it", async ({ page, context, baseURL }) => {
    test.setTimeout(180_000)
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    await connect(page, "notion")
    // Pick a default database so the manual send has a destination.
    await setDefaultDestination(page, "notion")

    const pagePosts = async () => (await fakeRequests("notion", "/v1/pages")).filter((request) => request.method === "POST")
    const pagePatches = async () => (await fakeRequests("notion", "/v1/pages/")).filter((request) => request.method === "PATCH")

    await openMeeting(page, env.E2E_M8_HEBREW_MEETING_ID)
    await sendFromMeeting(page, he.integrationsProviderNotion)
    expect(await pagePosts()).toHaveLength(1)
    const patchesAfterCreate = (await pagePatches()).length

    // Unchanged content: the content hash matches, so nothing is created or patched.
    await sendFromMeeting(page, he.integrationsProviderNotion)
    expect(await pagePosts()).toHaveLength(1)
    expect(await pagePatches()).toHaveLength(patchesAfterCreate)

    // Changed content: the same page is patched, no second page.
    const title = await meetingTitle(page, env.E2E_M8_HEBREW_MEETING_ID)

    await renameMeeting(page, baseURL, env.E2E_M8_HEBREW_MEETING_ID, `${title} (עודכן)`)
    await sendFromMeeting(page, he.integrationsProviderNotion)
    expect(await pagePosts()).toHaveLength(1)
    const patches = await pagePatches()

    expect(patches.length).toBeGreaterThan(patchesAfterCreate)
    expect(new Set(patches.map((request) => request.path.split("/").pop())).size).toBe(1)
    for (const request of await fakeRequests("notion")) {
      for (const match of JSON.stringify(request.body ?? {}).matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) {
        expect(JSON.parse(`"${match[1]}"`).length).toBeLessThanOrEqual(2000)
      }
    }
  })

  test("5. HubSpot: engagement and tasks once; unchanged re-send is a no-op, a changed one patches", async ({ page, context, baseURL }) => {
    test.setTimeout(180_000)
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    await connect(page, "hubspot")

    const engagements = async (method: string) =>
      (await fakeRequests("hubspot", "/crm/v3/objects/meetings")).filter(
        (request) => request.method === method && !request.path.includes("/search")
      )
    const taskCreates = async () => (await fakeRequests("hubspot", "/crm/v3/objects/tasks/batch/create")).length

    await openMeeting(page, env.E2E_M8_HEBREW_MEETING_ID)
    await sendFromMeeting(page, he.integrationsProviderHubspot)
    expect(await engagements("POST")).toHaveLength(1)
    const taskBatches = await taskCreates()

    expect(taskBatches).toBeGreaterThan(0)
    const patchesAfterCreate = (await engagements("PATCH")).length

    // Unchanged content: no new engagement, no PATCH, no new tasks.
    await sendFromMeeting(page, he.integrationsProviderHubspot)
    expect(await engagements("POST")).toHaveLength(1)
    expect(await engagements("PATCH")).toHaveLength(patchesAfterCreate)
    expect(await taskCreates()).toBe(taskBatches)

    // Changed content: the same engagement is patched; tasks are not duplicated.
    const title = await meetingTitle(page, env.E2E_M8_HEBREW_MEETING_ID)

    await renameMeeting(page, baseURL, env.E2E_M8_HEBREW_MEETING_ID, `${title} (שוב)`)
    await sendFromMeeting(page, he.integrationsProviderHubspot)
    expect(await engagements("POST")).toHaveLength(1)
    const patches = await engagements("PATCH")

    expect(patches.length).toBeGreaterThan(patchesAfterCreate)
    expect(new Set(patches.map((request) => request.path.split("/").pop())).size).toBe(1)
    expect(await taskCreates()).toBe(taskBatches)

    // Restore the seeded title (the remaining tests and later runs read it).
    await renameMeeting(page, baseURL, env.E2E_M8_HEBREW_MEETING_ID, title.replace(/ \(עודכן\)$/, ""))
  })

  test("6. Outlook sync as the W1 member creates one meeting per iCalUID", async ({ page, context, baseURL }) => {
    test.setTimeout(240_000)
    await signIn(context, baseURL, "w1Member")
    await openIntegrations(page, "he")
    await connect(page, "microsoft")
    await card(page, "microsoft").getByRole("switch", { name: he.integrationsOutlookSync }).click()
    await expect(card(page, "microsoft").getByRole("switch", { name: he.integrationsOutlookSync })).toBeChecked()

    // calendarSync runs every MEETSUM_MS_CALENDAR_SYNC_MINUTES (1 in e2e). The fake
    // calendar has only the shared event, so with a working dedupe no Outlook meeting
    // appears: wait for the sync itself (`config.lastSync`) instead.
    await expect
      .poll(
        async () => {
          const response = await page.request.get("/api/integrations/connections")
          const body = (await response.json()) as { connections?: { provider: string; status: string; config?: { lastSync?: { at?: string; events?: number } } }[] }
          const microsoft = (body.connections ?? []).find((item) => item.provider === "microsoft" && item.status !== "revoked")

          return microsoft?.config?.lastSync?.at ? (microsoft.config.lastSync.events ?? 0) : -1
        },
        { timeout: 150_000, intervals: [5_000] }
      )
      .toBeGreaterThan(0)

    const response = await page.request.get("/api/meetings?limit=200")
    const body = (await response.json()) as { meetings?: { id: string; title: string; source: string }[] }
    // ALL meetings for the shared event, whatever their title or source: the
    // seeded Google meeting and (if the dedupe failed) an Outlook copy.
    const sameEvent = (body.meetings ?? []).filter(
      (meeting) => meeting.id === env.E2E_M8_CALENDAR_MEETING_ID || meeting.title === "פגישת לקוח (Outlook)"
    )

    // The seeded Google row owns the iCalUID, so Outlook reuses that meeting: exactly one.
    expect(sameEvent).toHaveLength(1)
    expect(sameEvent[0].id).toBe(env.E2E_M8_CALENDAR_MEETING_ID)
    expect((body.meetings ?? []).filter((meeting) => meeting.source === "outlook_calendar")).toHaveLength(0)
  })

  test("7. email recap: opt-in meeting, RTL email, unsubscribe", async ({ page, context, baseURL }) => {
    test.setTimeout(240_000)
    test.skip(!env.E2E_M8_RECAP_MEETING_ID, "E2E env is missing E2E_M8_RECAP_MEETING_ID (re-run npm run integrations:e2e-seed)")
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    const recap = page.locator("section", { has: page.locator("#integrations-email-recap-title") })

    await recap.getByLabel(he.integrationsEmailRecapOptIn).check()
    await recap.getByRole("button", { name: he.integrationsRuleSave }).click()
    await expect(page.getByText(he.integrationsSaved).first()).toBeVisible()

    // Opt both meetings in: the second one is completed after the unsubscribe.
    for (const meetingId of [env.E2E_M8_HEBREW_MEETING_ID, env.E2E_M8_RECAP_MEETING_ID]) {
      await openMeeting(page, meetingId)
      await meetingMenu(page)
      await page.getByRole("menuitemradio", { name: he.integrationsMeetingEmailRecapOn }).click()
      await expect(page.getByText(he.integrationsMeetingSaved).first()).toBeVisible()
      await page.keyboard.press("Escape")
    }

    const before = emails().length

    completeMeeting(env.E2E_M8_HEBREW_MEETING_ID)
    await expect.poll(() => emails().length, { timeout: 60_000 }).toBeGreaterThan(before)
    const email = emails().at(-1)!
    const headers = Object.fromEntries(Object.entries(email.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))

    expect(email.html ?? "").toContain('dir="rtl"')
    if (email.raw) expect(email.raw).toMatch(/^Subject: =\?UTF-8\?/im)
    else expect(email.subject ?? "").toMatch(/^סיכום פגישה: /)
    expect(headers["list-unsubscribe"]).toMatch(/^<https?:\/\/.+\/api\/email\/unsubscribe\?t=.+>$/)
    expect(headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click")

    const unsubscribe = headers["list-unsubscribe"].slice(1, -1)
    const recipient = String(Array.isArray(email.to) ? email.to[0] : email.to)

    await page.goto(unsubscribe)
    await expect(page).toHaveURL(/\/unsubscribe\?t=/)
    await page.getByRole("button").first().click()
    await expect(page.getByRole("status").or(page.getByRole("alert"))).toBeVisible()

    const afterUnsubscribe = emails().length

    // A NEW meeting completion (a new rule key; re-completing the first meeting
    // would be a no-op whatever the unsubscribe did). Wait until its email
    // delivery settles, then check nothing went to the unsubscribed address.
    completeMeeting(env.E2E_M8_RECAP_MEETING_ID)
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/integrations/deliveries?provider=email&meetingId=${encodeURIComponent(env.E2E_M8_RECAP_MEETING_ID)}&limit=10`
          )
          const body = (await response.json()) as { deliveries?: { status: string }[] }

          return (body.deliveries ?? []).filter((delivery) => ["sent", "partial", "skipped", "failed", "cancelled"].includes(delivery.status)).length
        },
        { timeout: 60_000, intervals: [2_000] }
      )
      .toBeGreaterThan(0)
    const later = emails().slice(afterUnsubscribe)

    expect(later.some((item) => String(Array.isArray(item.to) ? item.to[0] : item.to) === recipient)).toBe(false)
  })

  test("8. DOCX download keeps the Hebrew filename and is bidi", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openMeeting(page, env.E2E_M8_HEBREW_MEETING_ID)
    await page.getByRole("button", { name: he.exportMenuLabel }).click()
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: he.exportDownloadDocx }).click(),
    ])

    expect(download.suggestedFilename()).toMatch(/[֐-׿]/)
    const file = await download.path()
    const xml = zipEntry(readFileSync(file), "word/document.xml") ?? ""

    expect(xml).toContain("<w:bidi/>")
  })

  test("9. webhooks: v2 subscription, signed test-fire, delivery log", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    const section = page.locator("section", { has: page.locator("#integrations-webhooks-title") })

    await section.getByLabel(he.integrationsWebhookUrlLabel).fill(`${FAKE}/__fake/webhook`)
    await section.getByRole("button", { name: he.integrationsWebhookAdd }).click()
    const secret = await section.locator("code").first().textContent()

    expect(secret).toBeTruthy()
    state.secret = secret ?? undefined
    const row = section.locator("[data-webhook-id]").first()

    await expect(row.getByText(/v2/)).toBeVisible()
    await row.getByLabel(he.integrationsWebhooksTestEvent).selectOption("clip.created")
    await row.getByRole("button", { name: he.integrationsWebhooksTestFire }).click()

    await expect.poll(async () => (await fakeRequests("webhook")).length, { timeout: 30_000 }).toBeGreaterThan(0)
    const received = (await fakeRequests("webhook")).at(-1)!
    const headers = Object.fromEntries(Object.entries(received.headers).map(([key, value]) => [key.toLowerCase(), value]))
    const signature = headers["x-meetsum-signature-v2"] ?? ""
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signature) ?? []
    const raw = received.rawBody ?? JSON.stringify(received.body)

    expect(t).toBeTruthy()
    expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(300)
    expect(createHmac("sha256", state.secret!).update(`${t}.${raw}`).digest("hex")).toBe(v1)

    // A test-fire is sent inline and never written to webhook_deliveries
    // (lib/webhooks/management.ts sendWebhookTest), so on a fresh database the
    // log is empty here; it only passed locally on leftover rows. A real event
    // (the completion events of the Hebrew meeting) gives the new
    // subscription its delivery row.
    completeMeeting(env.E2E_M8_HEBREW_MEETING_ID)
    await expect
      .poll(
        async () => {
          await openIntegrations(page, "he")
          await page.getByRole("tab", { name: he.integrationsLogTabWebhooks }).click()

          return page.locator("[data-webhook-delivery-id]").count()
        },
        { timeout: 60_000, intervals: [1_000, 3_000] }
      )
      .toBeGreaterThan(0)
  })

  test("10. a private meeting is skipped until its owner opts in", async ({ page, context, baseURL }) => {
    test.setTimeout(180_000)
    const posts = (await fakeRequests("slack", "chat.postMessage")).length

    completeMeeting(env.E2E_M8_PRIVATE_MEETING_ID)
    await signIn(context, baseURL, "w1Owner")
    await expect
      .poll(
        async () =>
          (await deliveryRows(page))
            .and(page.locator('[data-status="skipped"]'))
            .filter({ hasText: he.integrationsSkipPrivateMeeting })
            .count(),
        { timeout: 60_000 }
      )
      .toBeGreaterThan(0)
    // The private title never appears in the admin's log.
    await expect(page.getByText(he.integrationsLogPrivateMeeting).first()).toBeVisible()
    expect((await fakeRequests("slack", "chat.postMessage")).length).toBe(posts)

    // "Send to…" needs a default channel (otherwise the item is disabled).
    await openIntegrations(page, "he")
    await setDefaultDestination(page, "slack")

    await signIn(context, baseURL, "w1Member")
    await openMeeting(page, env.E2E_M8_PRIVATE_MEETING_ID)
    await meetingMenu(page)
    await page.getByRole("menuitemcheckbox", { name: new RegExp(he.integrationsMeetingAllowPrivate) }).click()
    await expect(page.getByText(he.integrationsMeetingSaved)).toBeVisible()
    await page.keyboard.press("Escape")
    await sendFromMeeting(page, he.integrationsProviderSlack)
    expect((await fakeRequests("slack", "chat.postMessage")).length).toBe(posts + 1)
  })

  test("11. W2 sees nothing from W1 and W1 ids are 404", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w2Owner")
    await openIntegrations(page, "he")
    await expect(card(page, "slack").getByTestId("integration-account")).toHaveCount(0)
    await expect(page.locator("[data-rule-id]")).toHaveCount(0)
    await expect(page.locator("[data-delivery-id]")).toHaveCount(0)

    const connections = await page.request.get("/api/integrations/connections")

    expect(JSON.stringify(await connections.json())).not.toContain(env.E2E_M8_W1_WORKSPACE_ID)
    if (state.deliveryId) expect((await page.request.get(`/api/integrations/deliveries/${state.deliveryId}`)).status()).toBe(404)
    if (state.ruleId) {
      const response = await page.request.patch(`/api/integrations/rules/${state.ruleId}`, {
        data: { enabled: false },
        headers: { origin: baseURL || "http://localhost:3000" },
      })

      expect(response.status()).toBe(404)
    }
  })

  test("12. disconnecting Slack disables its rule and revokes the token", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    await card(page, "slack").getByRole("button", { name: he.integrationsDisconnect }).click()
    const dialog = page.getByRole("alertdialog")

    await expect(dialog.getByText(state.slackRuleName)).toBeVisible()
    await dialog.getByRole("button", { name: he.integrationsDisconnectConfirm }).click()
    await expect(page.locator("[data-rule-id]").filter({ hasText: state.slackRuleName }).getByTestId("rule-disabled-reason")).toHaveText(
      he.integrationsRuleDisabledConnectionRevoked
    )
    expect((await fakeRequests("slack", "auth.revoke")).length).toBeGreaterThan(0)
  })

  test("13. /en is LTR and English; a member sees status but no Connect", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "en")
    await expect(page.getByTestId("integrations-settings")).toHaveAttribute("dir", "ltr")
    await expect(page.getByRole("heading", { name: en.integrationsTitle, exact: true })).toBeVisible()

    await signIn(context, baseURL, "w1Member")
    await openIntegrations(page, "en")
    await expect(page.getByText(en.integrationsMembersSeeStatusOnly)).toBeVisible()
    for (const provider of ["slack", "notion", "hubspot"]) {
      await expect(card(page, provider).getByRole("button", { name: new RegExp(en.integrationsConnect) })).toHaveCount(0)
      await expect(card(page, provider).getByRole("button", { name: en.integrationsDisconnect })).toHaveCount(0)
    }
  })
})
