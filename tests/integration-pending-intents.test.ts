import { describe, expect, it, vi } from "vitest"

import type { EmailMessage, EmailSender } from "@/lib/email/types"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import type { DeliverInput, DeliveryProgress, LinkStore, ProviderFetch, RuleDestination } from "@/lib/integrations/core/types"
import { createEmailRecapProvider } from "@/lib/integrations/email-recap/provider"
import { configureHubspotProvider, deliverToHubspot, resetHubspotProviderForTests } from "@/lib/integrations/hubspot/provider"
import { deliverNotionPage } from "@/lib/integrations/notion/deliver"
import { buildMeetingRecap, DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import { slackScopes } from "@/lib/integrations/slack/oauth"
import { slackProvider } from "@/lib/integrations/slack/provider"
import { testMeetingRecord } from "@/lib/integrations/testing/harness"
import type { MeetingRecord } from "@/lib/meetings/repository"

import { memoryLinkStore } from "./helpers/integration-doubles"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 review fix #4: a DB write failing right after a successful provider
 * call must not duplicate the external side effect on retry. Every provider
 * persists a pending intent before the external call and the result right
 * after it (on its own); a retry that finds a pending intent looks for our
 * marker at the provider (Notion database query, adopting only our own
 * page; HubSpot search) or, for email, treats it as already sent. Slack
 * persists the posted ts in its own write (no history scope).
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

type Persistence = {
  save(progress: DeliveryProgress): Promise<void>
  readonly progress: DeliveryProgress
  heal(): void
}

/** The delivery row's `progress`: writes matching `failWhen` throw until healed. */
function flakyProgress(failWhen: (progress: DeliveryProgress) => boolean): Persistence {
  let persisted: DeliveryProgress = {}
  let failing = true

  return {
    async save(progress) {
      if (failing && failWhen(progress)) throw new Error("database unavailable")
      persisted = structuredClone(progress)
    },
    get progress() {
      return structuredClone(persisted)
    },
    heal() {
      failing = false
    },
  }
}

/** Link upserts fail while `failing()` (the original Slack/HubSpot/Notion bug). */
function flakyLinks(failing: () => boolean): LinkStore {
  const inner = memoryLinkStore([], "intc_1", "m_a")

  return {
    ...inner,
    async upsert(key) {
      if (failing()) throw new Error("database unavailable")
      return inner.upsert(key)
    },
  }
}

const meeting = (overrides: Partial<MeetingRecord> = {}) =>
  testMeetingRecord({
    id: "m_a",
    title: "Weekly sync",
    language: "en",
    participantDetails: [
      { id: "p1", meetingId: "m_a", name: "Owner", email: "owner@acme.test", role: "organizer", source: "calendar", attendanceStatus: "accepted", createdAt: "", updatedAt: "" },
      { id: "p2", meetingId: "m_a", name: "Client", email: "ceo@client.example", role: "attendee", source: "calendar", attendanceStatus: "accepted", createdAt: "", updatedAt: "" },
    ] as MeetingRecord["participantDetails"],
    ...overrides,
  })

function input(options: {
  provider: DeliverInput["delivery"]["provider"]
  destination: RuleDestination
  fetch: ProviderFetch
  persistence: Persistence
  links: LinkStore
  record?: MeetingRecord
}): DeliverInput {
  const record = options.record ?? meeting()

  return {
    workspaceId: "ws_a",
    delivery: {
      id: "intd_1",
      provider: options.provider,
      origin: "rule",
      eventName: "meeting.completed",
      meetingId: record.id,
      status: "running",
      attempts: 1,
      maxAttempts: 5,
      externalRef: {},
      createdAt: "",
      updatedAt: "",
    },
    getAccessToken: async () => "fixture-access-token",
    destination: options.destination,
    content: DEFAULT_RULE_CONTENT,
    recap: buildMeetingRecap(record, { content: DEFAULT_RULE_CONTENT, links: { meeting: "https://app.test/en?meeting=m_a" } }),
    meeting: record,
    progress: options.persistence.progress,
    saveProgress: (progress) => options.persistence.save(progress),
    links: options.links,
    fetch: options.fetch,
  }
}

/**
 * Attempt 1 runs with the failing writes (it may throw, or finish while the
 * delivery row's final write is lost: either way only what was persisted
 * survives); attempt 2 resumes from the persisted progress.
 */
async function attemptTwice(run: () => Promise<unknown>, persistence: Persistence) {
  await run().catch(() => undefined)
  persistence.heal()
  return run()
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("email recap: a pending intent is treated as sent", () => {
  it("never re-sends after the post-send progress write failed", async () => {
    const store = createMemoryIntegrationStore()
    const sent: EmailMessage[] = []
    const sender: EmailSender = {
      provider: "log",
      isConfigured: () => true,
      send: async (message) => {
        sent.push(message)
        return { provider: "log" }
      },
    }
    const provider = createEmailRecapProvider({
      store: async () => store,
      sender: () => sender,
      listMembers: async () => [{ userId: "user_owner", email: "owner@acme.test" }],
      workspaceName: async () => "Acme",
      sleep: async () => undefined,
      env: { NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "https://app.test", MEETSUM_SESSION_SECRET: process.env.MEETSUM_SESSION_SECRET } as NodeJS.ProcessEnv,
    })
    // The intent write succeeds, the "sent" write after the SMTP call fails.
    const persistence = flakyProgress((progress) => Array.isArray(progress.sent) && progress.sent.length > 0)
    const links = memoryLinkStore()
    const run = () =>
      provider.deliver!(
        input({
          provider: "email",
          destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "en" },
          fetch: async () => new Response(null, { status: 599 }),
          persistence,
          links,
        })
      )

    await expect(attemptTwice(run, persistence)).resolves.toMatchObject({ status: "sent" })
    expect(sent.map((message) => message.to)).toEqual(["owner@acme.test"])
  })
})

describe("HubSpot: a pending engagement or task is found by its marker", () => {
  function hubspotApi(options: { forgeCopy?: boolean } = {}) {
    const objects = { meetings: [] as Array<{ id: string; properties: Record<string, string> }>, tasks: [] as Array<{ id: string; properties: Record<string, string> }> }
    let next = 88000
    const fetch: ProviderFetch = async (_provider, url, init = {}) => {
      const path = url.replace("https://api.hubapi.com", "")
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      const method = (init.method ?? "GET").toUpperCase()

      if (method === "POST" && path === "/crm/v3/objects/contacts/search") {
        return jsonResponse({ results: [{ id: "501", properties: { email: "ceo@client.example" } }] })
      }
      if (method === "POST" && /^\/crm\/v3\/objects\/(meetings|notes|tasks)\/search$/.test(path)) {
        const kind = path.split("/")[4] as "meetings" | "tasks"

        return jsonResponse({ results: (objects[kind] ?? []).map((object) => ({ id: object.id, properties: object.properties })) })
      }
      if (method === "POST" && path === "/crm/v3/objects/meetings") {
        const id = String((next += 1))

        objects.meetings.push({ id, properties: body.properties })
        // A CRM user copies the marker into another meeting (forged / ambiguous).
        if (options.forgeCopy) objects.meetings.push({ id: "forged", properties: { ...body.properties } })
        return jsonResponse({ id }, 201)
      }
      if (method === "POST" && path === "/crm/v3/objects/tasks/batch/create") {
        const results = (body.inputs as Array<{ objectWriteTraceId: string; properties: Record<string, string> }>).map((entry) => {
          const id = String((next += 1))

          objects.tasks.push({ id, properties: entry.properties })
          return { id, objectWriteTraceId: entry.objectWriteTraceId }
        })

        return jsonResponse({ status: "COMPLETE", results }, 201)
      }
      if (method === "GET" && path.startsWith("/crm/v3/owners")) return jsonResponse({ results: [] })
      return jsonResponse({ status: "error", category: "NOT_ROUTED" }, 404)
    }

    return { fetch, objects }
  }

  const destination: RuleDestination = {
    provider: "hubspot",
    dealId: "9001",
    dealName: "Renewal",
    logAs: "meeting",
    createTasks: true,
    createMissingContacts: false,
    matchInternal: false,
  }
  const record = () =>
    meeting({
      summary: {
        overview: "Agreed on the timeline",
        actionItems: [{ id: "ai_1", title: "Send the quote", status: "open" }],
        decisions: [],
      },
    } as unknown as Partial<MeetingRecord>)

  it("does not log the meeting twice when the write after the create failed", async () => {
    configureHubspotProvider({ internalDomains: async () => ["acme.test"], memberEmails: async () => new Map(), privacyGate: () => true })
    const api = hubspotApi()
    const persistence = flakyProgress((progress) => Boolean(progress.engagementId))
    let failing = true
    const links = flakyLinks(() => failing)
    const run = async () => {
      try {
        return await deliverToHubspot(input({ provider: "hubspot", destination, fetch: api.fetch, persistence, links, record: record() }))
      } finally {
        failing = false
      }
    }

    await expect(attemptTwice(run, persistence)).resolves.toMatchObject({ status: "sent" })
    expect(api.objects.meetings).toHaveLength(1)
    expect(api.objects.tasks).toHaveLength(1)
    resetHubspotProviderForTests()
  })

  it("never adopts an ambiguous marker match (creates anew, never overwrites)", async () => {
    configureHubspotProvider({ internalDomains: async () => ["acme.test"], memberEmails: async () => new Map(), privacyGate: () => true })
    const api = hubspotApi({ forgeCopy: true })
    const persistence = flakyProgress((progress) => Boolean(progress.engagementId))
    const links = memoryLinkStore()
    const run = () => deliverToHubspot(input({ provider: "hubspot", destination, fetch: api.fetch, persistence, links, record: record() }))

    const result = await attemptTwice(run, persistence)

    expect((result as { externalRef: { engagementId: string } }).externalRef.engagementId).not.toBe("forged")
    expect(api.objects.meetings.filter((object) => object.id !== "forged")).toHaveLength(2)
    resetHubspotProviderForTests()
  })

  it("does not create a task twice when the write after the batch create failed", async () => {
    configureHubspotProvider({ internalDomains: async () => ["acme.test"], memberEmails: async () => new Map(), privacyGate: () => true })
    const api = hubspotApi()
    const persistence = flakyProgress((progress) => Object.keys((progress.taskIdsByActionItem as Record<string, string>) ?? {}).length > 0)
    const links = memoryLinkStore()
    const run = () => deliverToHubspot(input({ provider: "hubspot", destination, fetch: api.fetch, persistence, links, record: record() }))

    await expect(attemptTwice(run, persistence)).resolves.toMatchObject({ status: "sent" })
    expect(api.objects.tasks).toHaveLength(1)
    expect(api.objects.meetings).toHaveLength(1)
    resetHubspotProviderForTests()
  })
})

describe("Slack: the posted ts is persisted on its own right after chat.postMessage", () => {
  function slackApi() {
    const messages: Array<{ ts: string; channel: string }> = []
    const calls: string[] = []
    const fetch: ProviderFetch = async (_provider, url, init = {}) => {
      const method = url.replace("https://slack.com/api/", "")
      const raw = String(init.body ?? "")
      const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))

      calls.push(method)
      if (method === "chat.postMessage") {
        const ts = `1760000000.00000${messages.length + 1}`

        messages.push({ ts, channel: body.channel })
        return jsonResponse({ ok: true, ts, channel: body.channel })
      }
      if (method === "chat.getPermalink") return jsonResponse({ ok: true, permalink: `https://acme.slack.com/archives/C1/p${body.message_ts}` })
      return jsonResponse({ ok: false, error: "unknown_method" })
    }

    return { fetch, messages, calls }
  }

  it("does not post twice when the link write after chat.postMessage failed", async () => {
    const api = slackApi()
    const persistence = flakyProgress(() => false)
    let failing = true
    const links = flakyLinks(() => failing)
    const run = async () => {
      try {
        return await slackProvider.deliver!(
          input({ provider: "slack", destination: { provider: "slack", channelId: "C1", channelName: "general" }, fetch: api.fetch, persistence, links })
        )
      } finally {
        failing = false
      }
    }

    const result = await attemptTwice(run, persistence)

    expect(api.messages).toHaveLength(1)
    expect(result).toMatchObject({ status: "sent", externalRef: { ts: api.messages[0].ts } })
    expect(persistence.progress.slackPosted).toMatchObject({ destinationKey: "C1", ts: api.messages[0].ts })
    expect(await links.get({ objectKind: "slack_message", destinationKey: "C1" })).toMatchObject({ externalId: api.messages[0].ts })
    // No channel history is ever read.
    expect(api.calls).not.toContain("conversations.history")
  })

  it("requests exactly the spec's scopes (no history scope)", () => {
    expect(slackScopes({} as NodeJS.ProcessEnv).join(",")).toBe("chat:write,chat:write.public,channels:read")
    expect(slackScopes({ SLACK_PRIVATE_CHANNELS: "true" } as unknown as NodeJS.ProcessEnv).join(",")).toBe(
      "chat:write,chat:write.public,channels:read,groups:read"
    )
  })
})

describe("Notion: a pending page create is adopted only when it is provably ours", () => {
  const DATABASE_ID = "8a1f0c2e-1d6b-4b8e-9b37-1f2d3c4b5a60"
  const BOT_ID = "bot-user-ours"
  const schema = { Name: { type: "title" }, "MeetSum ID": { type: "rich_text" } }

  type Page = {
    id: string
    properties: Record<string, unknown>
    created_time: string
    created_by: { id: string }
    parent: { type: string; database_id: string }
  }

  function notionApi(options: { schema?: Record<string, { type: string }>; forge?: (marker: string, pages: Page[]) => void } = {}) {
    const pages: Page[] = []
    const queries: unknown[] = []
    const fetch: ProviderFetch = async (_provider, url, init = {}) => {
      const path = url.replace("https://api.notion.com", "")
      const method = (init.method ?? "GET").toUpperCase()
      const body = init.body ? JSON.parse(String(init.body)) : undefined

      if (method === "GET" && path === `/v1/databases/${DATABASE_ID}`) {
        return jsonResponse({ object: "database", id: DATABASE_ID, properties: options.schema ?? schema })
      }
      if (method === "GET" && path === "/v1/users/me") return jsonResponse({ object: "user", id: BOT_ID, type: "bot" })
      if (method === "POST" && path === "/v1/pages") {
        const page: Page = {
          id: `page-${pages.length + 1}`,
          properties: body.properties,
          created_time: new Date().toISOString(),
          created_by: { id: BOT_ID },
          parent: { type: "database_id", database_id: DATABASE_ID },
        }
        const marker = (body.properties["MeetSum ID"]?.rich_text?.[0]?.text?.content as string | undefined) ?? ""

        pages.push(page)
        if (marker) options.forge?.(marker, pages)
        return jsonResponse({ object: "page", id: page.id, url: `https://www.notion.so/${page.id}` })
      }
      if (method === "POST" && path === `/v1/databases/${DATABASE_ID}/query`) {
        queries.push(body)
        const wanted = body.filter?.and?.[0]?.rich_text?.equals

        return jsonResponse({
          object: "list",
          results: pages
            .filter((page) => {
              const value = page.properties["MeetSum ID"] as { rich_text?: Array<{ text?: { content?: string } }> } | undefined

              return value?.rich_text?.[0]?.text?.content === wanted
            })
            .map((page) => ({
              object: "page",
              id: page.id,
              created_by: page.created_by,
              parent: page.parent,
              properties: {
                "MeetSum ID": { type: "rich_text", rich_text: [{ plain_text: wanted }] },
              },
            })),
          has_more: false,
        })
      }
      if (method === "PATCH" && /^\/v1\/blocks\/[^/]+\/children$/.test(path)) return jsonResponse({ object: "list", results: [] })
      return jsonResponse({ object: "error", status: 404, code: "object_not_found" }, 404)
    }

    return { fetch, pages, queries }
  }

  function runner(api: ReturnType<typeof notionApi>, persistence: Persistence) {
    const links = memoryLinkStore()

    return () =>
      deliverNotionPage(
        input({
          provider: "notion",
          destination: { provider: "notion", databaseId: DATABASE_ID, databaseTitle: "Notes" },
          fetch: api.fetch,
          persistence,
          links,
        }),
        { sleep: async () => undefined }
      )
  }

  it("adopts its own page (random marker in MeetSum ID, our bot, this database) instead of creating a second one", async () => {
    const api = notionApi()
    const persistence = flakyProgress((progress) => typeof progress.pageId === "string")

    await expect(attemptTwice(runner(api, persistence), persistence)).resolves.toMatchObject({ status: "sent", externalRef: { pageId: "page-1" } })
    expect(api.pages).toHaveLength(1)
    expect(api.queries).toHaveLength(1)

    const marker = (api.pages[0].properties["MeetSum ID"] as { rich_text: Array<{ text: { content: string } }> }).rich_text[0].text.content

    // An unguessable per-create nonce, never the meeting id.
    expect(marker).toMatch(/^meetsum:[0-9a-f]{32}$/)
    expect(marker).not.toContain("m_a")
  })

  it("never adopts a forged page carrying our marker but created by someone else", async () => {
    const api = notionApi({
      // A database editor copies the marker onto their own page.
      forge: (marker, pages) => {
        if (pages.length === 1) {
          pages[0].created_by = { id: "user-attacker" }
          void marker
        }
      },
    })
    const persistence = flakyProgress((progress) => typeof progress.pageId === "string")

    await expect(attemptTwice(runner(api, persistence), persistence)).resolves.toMatchObject({ status: "sent", externalRef: { pageId: "page-2" } })
    expect(api.pages).toHaveLength(2)
  })

  it("never adopts when the match is ambiguous", async () => {
    const api = notionApi({
      forge: (marker, pages) => {
        if (pages.length === 1) {
          pages.push({ ...pages[0], id: "page-forged" })
          void marker
        }
      },
    })
    const persistence = flakyProgress((progress) => typeof progress.pageId === "string")

    const result = await attemptTwice(runner(api, persistence), persistence)

    expect(result).toMatchObject({ status: "sent" })
    expect((result as { externalRef: { pageId: string } }).externalRef.pageId).not.toBe("page-forged")
    expect((result as { externalRef: { pageId: string } }).externalRef.pageId).not.toBe("page-1")
  })

  it("does not search (and may duplicate) when the database has no MeetSum ID property", async () => {
    const api = notionApi({ schema: { Name: { type: "title" } } })
    const persistence = flakyProgress((progress) => typeof progress.pageId === "string")

    await attemptTwice(runner(api, persistence), persistence)
    expect(api.queries).toHaveLength(0)
  })
})
