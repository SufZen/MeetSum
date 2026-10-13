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

function loadEnvFile(): Record<string, string> {
  const file = process.env.E2E_ENV_FILE || ".secrets/e2e-m8.env"
  const values: Record<string, string> = {}

  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)

      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
    }
  }

  return { ...values, ...(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("E2E_"))) as Record<string, string>) }
}

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

/** Connect / Reconnect is a full-page navigation; the fake authorize page auto-approves. */
async function connect(page: Page, provider: string) {
  await card(page, provider).getByRole("link", { name: new RegExp(he.integrationsConnect) }).click()
  await page.waitForURL(/section=integrations/, { timeout: 30_000 })
  await expect(page.getByTestId("integrations-settings")).toBeVisible()
  await expect(card(page, provider).getByTestId("integration-account").locator("bdi")).toBeVisible()
}

async function openMeeting(page: Page, meetingId: string, locale: "he" | "en" = "he") {
  await page.goto(`/${locale}?meeting=${encodeURIComponent(meetingId)}`)
  await expect(page.getByRole("button", { name: dictionaries[locale].meetingActions })).toBeVisible({ timeout: 30_000 })
}

async function meetingMenu(page: Page) {
  await page.getByRole("button", { name: he.meetingActions }).click()
}

async function sendFromMeeting(page: Page, providerLabel: string) {
  await meetingMenu(page)
  await page.getByRole("menuitem", { name: he.exportSendTo || he.integrationsRuleDestination }).click()
  await page.getByRole("menuitem", { name: new RegExp(providerLabel) }).click()
  await expect(page.getByText(new RegExp(`${providerLabel}: ${he.integrationsStatusSent}`))).toBeVisible({ timeout: 30_000 })
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

  test("4. Notion: send twice creates one page, then updates it", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    await connect(page, "notion")
    // Pick a default database so the manual send has a destination.
    await card(page, "notion").getByText(he.integrationsDefaultDestination).click()
    await card(page, "notion").getByRole("list").getByRole("button").first().click()

    await openMeeting(page, env.E2E_M8_HEBREW_MEETING_ID)
    await sendFromMeeting(page, he.integrationsProviderNotion)
    await sendFromMeeting(page, he.integrationsProviderNotion)

    const created = await fakeRequests("notion", "/v1/pages")

    expect(created.filter((request) => request.method === "POST")).toHaveLength(1)
    const pageId = (created.find((request) => request.method === "PATCH")?.path ?? "").split("/").pop()

    expect(pageId).toBeTruthy()
    for (const request of await fakeRequests("notion")) {
      for (const match of JSON.stringify(request.body ?? {}).matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) {
        expect(JSON.parse(`"${match[1]}"`).length).toBeLessThanOrEqual(2000)
      }
    }
  })

  test("5. HubSpot: engagement and tasks once, re-send patches", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    await connect(page, "hubspot")
    await openMeeting(page, env.E2E_M8_HEBREW_MEETING_ID)
    await sendFromMeeting(page, he.integrationsProviderHubspot)
    expect((await fakeRequests("hubspot", "/crm/v3/objects/meetings")).filter((r) => r.method === "POST")).toHaveLength(1)
    const taskBatches = (await fakeRequests("hubspot", "/crm/v3/objects/tasks/batch/create")).length

    expect(taskBatches).toBeGreaterThan(0)
    await sendFromMeeting(page, he.integrationsProviderHubspot)
    expect((await fakeRequests("hubspot", "/crm/v3/objects/meetings")).filter((r) => r.method === "PATCH").length).toBeGreaterThan(0)
    expect((await fakeRequests("hubspot", "/crm/v3/objects/tasks/batch/create")).length).toBe(taskBatches)
  })

  test("6. Outlook sync as the W1 member creates one meeting per iCalUID", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Member")
    await openIntegrations(page, "he")
    await connect(page, "microsoft")
    await card(page, "microsoft").getByRole("switch", { name: he.integrationsOutlookSync }).click()
    await expect(card(page, "microsoft").getByRole("switch", { name: he.integrationsOutlookSync })).toBeChecked()

    // calendarSync runs every MEETSUM_MS_CALENDAR_SYNC_MINUTES (1 in e2e).
    await expect
      .poll(
        async () => {
          const response = await page.request.get("/api/meetings?limit=200")
          const body = (await response.json()) as { meetings?: { id: string; source: string }[] }

          return (body.meetings ?? []).filter((meeting) => meeting.source === "outlook_calendar").length
        },
        { timeout: 150_000, intervals: [5_000] }
      )
      .toBeGreaterThan(0)

    const response = await page.request.get("/api/meetings?limit=200")
    const body = (await response.json()) as { meetings?: { id: string; title: string }[] }
    const sameEvent = (body.meetings ?? []).filter((meeting) => meeting.title === "פגישה מתוזמנת מהיומן")

    // The seeded Google row owns the iCalUID, so Outlook reuses that meeting.
    expect(sameEvent).toHaveLength(1)
    expect(sameEvent[0].id).toBe(env.E2E_M8_CALENDAR_MEETING_ID)
  })

  test("7. email recap: opt-in meeting, RTL email, unsubscribe", async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, "w1Owner")
    await openIntegrations(page, "he")
    const recap = page.locator("section", { has: page.locator("#integrations-email-recap-title") })

    await recap.getByLabel(he.integrationsEmailRecapOptIn).check()
    await recap.getByRole("button", { name: he.integrationsRuleSave }).click()
    await expect(page.getByText(he.integrationsSaved).first()).toBeVisible()

    await openMeeting(page, env.E2E_M8_HEBREW_MEETING_ID)
    await meetingMenu(page)
    await page.getByRole("menuitemradio", { name: he.integrationsMeetingEmailRecapOn }).click()
    await expect(page.getByText(he.integrationsMeetingSaved)).toBeVisible()
    await page.keyboard.press("Escape")

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

    completeMeeting(env.E2E_M8_HEBREW_MEETING_ID)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
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

    await section.getByLabel(he.integrationsSectionWebhooks).fill(`${FAKE}/__fake/webhook`)
    await section.getByRole("button", { name: he.botInternalDomainsAdd }).click()
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

    await page.getByRole("tab", { name: he.integrationsLogTabWebhooks }).click()
    await expect(page.locator("[data-webhook-delivery-id]").first()).toBeVisible({ timeout: 30_000 })
  })

  test("10. a private meeting is skipped until its owner opts in", async ({ page, context, baseURL }) => {
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
      await expect(card(page, provider).getByRole("link", { name: new RegExp(en.integrationsConnect) })).toHaveCount(0)
      await expect(card(page, provider).getByRole("button", { name: en.integrationsDisconnect })).toHaveCount(0)
    }
  })
})
