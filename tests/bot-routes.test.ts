import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestCtx,
  jsonRequest,
  routeParams,
  setRouteCtx,
  testMeeting,
} from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  dispatchNow: vi.fn(),
  scheduleDispatch: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  enqueueBotJob: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  removeBotJob: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  stopBot: vi.fn<(...args: unknown[]) => Promise<{ status: string; raw: object }>>(async () => ({ status: "stopping", raw: {} })),
  updateBotRules: vi.fn(),
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.recordAuditLog }))
vi.mock("@/lib/bot/dispatch", async (importOriginal) => ({
  sealMeetingSecrets: (await importOriginal<typeof import("@/lib/bot/dispatch")>()).sealMeetingSecrets,
  openMeetingSecrets: (await importOriginal<typeof import("@/lib/bot/dispatch")>()).openMeetingSecrets,
  dispatchNow: mocks.dispatchNow,
  scheduleDispatch: mocks.scheduleDispatch,
  runDispatch: vi.fn(),
}))
vi.mock("@/lib/bot/queue", () => ({
  enqueueBotJob: mocks.enqueueBotJob,
  removeBotJob: mocks.removeBotJob,
}))
vi.mock("@/lib/bot/vexa/client", () => ({
  getBotProvider: () => ({
    stopBot: mocks.stopBot,
    health: async () => ({ ok: true, version: "0.12.28" }),
    getWebhook: async () => ({ url: "https://meetsum.example/api/integrations/vexa/webhook", raw: {} }),
  }),
}))
vi.mock("@/lib/settings/bot-rules", async () => {
  const { DEFAULT_BOT_RULES } = await import("@/lib/bot/types")

  return {
    getBotRules: async () => structuredClone({ ...DEFAULT_BOT_RULES }),
    updateBotRules: mocks.updateBotRules,
  }
})
vi.mock("@/lib/bot/meeting-url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bot/meeting-url")>()
  type Link = import("@/lib/bot/types").ParsedMeetingLink

  function extractMeetingLinks(text: string): Link[] {
    const meet = text.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)

    if (meet) {
      const id = meet[1].toLowerCase()
      const url = `https://meet.google.com/${id}`

      return [{ platform: "google_meet", nativeMeetingId: id, canonicalUrl: url, redactedUrl: url, source: "input" }]
    }

    const zoom = text.match(/zoom\.us\/j\/(\d{9,11})\?pwd=([A-Za-z0-9]+)/)

    if (zoom) {
      return [
        {
          platform: "zoom",
          nativeMeetingId: zoom[1],
          passcode: zoom[2],
          canonicalUrl: `https://zoom.us/j/${zoom[1]}?pwd=${zoom[2]}`,
          redactedUrl: `https://zoom.us/j/${zoom[1]}`,
          source: "input",
        },
      ]
    }

    return []
  }

  return {
    meetingLinkSecrets: actual.meetingLinkSecrets,
    rebuildCanonicalUrl: actual.rebuildCanonicalUrl,
    extractMeetingLinks,
    parseMeetingLink: (text: string) => extractMeetingLinks(text)[0],
    diagnoseMeetingLink: (text: string) => (text.includes("zoom.us/my/") ? "personal_link" : "no_link"),
  }
})

import { GET as listSessions } from "@/app/api/bot/sessions/route"
import { GET as botStatus } from "@/app/api/bot/status/route"
import { DELETE as stopBot, GET as getMeetingBot, POST as sendBot } from "@/app/api/meetings/[id]/bot/route"
import { POST as joinNow } from "@/app/api/meetings/bot/route"
import { GET as getSettings, PUT as putSettings } from "@/app/api/settings/bot/route"
import { setBotMeetingLinkLookup, type BotMeetingLinkLookup } from "@/lib/bot/service"
import { setMemoryBotSessionStore, type BotSessionCreateInput } from "@/lib/bot/store"
import { createMemoryBotSessionStore, type MemoryBotSessionStore } from "@/lib/bot/store-memory"
import { DEFAULT_BOT_RULES, type BotSession } from "@/lib/bot/types"
import {
  createInMemoryMeetingDatabase,
  type InMemoryMeetingDatabase,
} from "@/lib/meetings/repository"
import { processVexaWebhook } from "@/lib/bot/webhook-handler"
import { signVexaWebhook } from "@/lib/bot/webhook-verify"
import type { WorkspaceRole } from "@/lib/workspaces/types"

import { testBotConfig } from "./fixtures/vexa/api/harness"

/**
 * M7 B7 routes: Join now (201 Meet / Hebrew text, 400, 429 memory+DB,
 * capacity, reused, attach), meeting bot GET/POST/DELETE, visibility (403
 * viewer, 404 invisible), sessions scoped to visible meetings, settings
 * consent gate, the feature gate, and no passcode in any response.
 */

const BASE = "http://localhost/api"
const WS = "ws_a"
let store: MemoryBotSessionStore
let database: InMemoryMeetingDatabase
let userCounter = 0

function inFuture(hours: number) {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

async function ctxFor(role: WorkspaceRole = "member", userId?: string) {
  userCounter += 1
  const ctx = await createTestCtx({
    role,
    workspaceId: WS,
    userId: userId ?? `user_${userCounter}`,
    email: `user${userCounter}@example.com`,
    database,
  })

  setRouteCtx(ctx)
  return ctx
}

async function seedSession(overrides: Partial<BotSessionCreateInput> & { workspaceId?: string } = {}) {
  return store.create({
    workspaceId: WS,
    meetingId: "m_visible",
    origin: "manual",
    platform: "google_meet",
    nativeMeetingId: "abc-defg-hij",
    botName: "MeetSum Notetaker",
    ...overrides,
  })
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

const lookup: BotMeetingLinkLookup = {
  meetingLink: vi.fn(async (_ws: string, meetingId: string) =>
    meetingId === "m_calendar"
      ? {
          link: {
            platform: "google_meet" as const,
            nativeMeetingId: "cal-endr-xyz",
            canonicalUrl: "https://meet.google.com/cal-endr-xyz",
            redactedUrl: "https://meet.google.com/cal-endr-xyz",
            source: "hangout_link" as const,
          },
          calendarEventId: "gcal_1",
        }
      : undefined
  ),
  attachCandidates: vi.fn(async (_ws: string, link: { nativeMeetingId: string }) =>
    link.nativeMeetingId === "cal-endr-xyz" ? ["m_calendar"] : []
  ),
}

beforeEach(() => {
  vi.stubEnv("MEETSUM_STORAGE", "memory")
  vi.stubEnv("MEETSUM_BOT_ENABLED", "true")
  vi.stubEnv("MEETSUM_SESSION_SECRET", "test-session-secret-0123456789abcdef")
  vi.stubEnv("MEETSUM_RATE_LIMIT", "true")
  store = createMemoryBotSessionStore()
  setMemoryBotSessionStore(store)
  setBotMeetingLinkLookup(lookup)
  database = createInMemoryMeetingDatabase([
    testMeeting({ id: "m_visible", workspaceId: WS, status: "scheduled", startedAt: inFuture(0) }),
    testMeeting({ id: "m_future", workspaceId: WS, status: "scheduled", startedAt: inFuture(3) }),
    testMeeting({ id: "m_calendar", workspaceId: WS, status: "scheduled", startedAt: inFuture(0.5) }),
    testMeeting({ id: "m_private", workspaceId: WS, visibility: "private", ownerUserId: "someone_else" }),
    testMeeting({ id: "m_other_ws", workspaceId: "ws_b" }),
  ])
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.dispatchNow.mockImplementation(async (target: { id: string; workspaceId: string }) => {
    // The store is workspace-scoped: the service must pass the session itself.
    expect(typeof target).toBe("object")
    expect(target.workspaceId).toBeTruthy()
    const sessionId = target.id
    const session = store.sessions.get(sessionId)!

    store.sessions.set(sessionId, { ...session, status: "requested", statusRank: 1 })
    return { ...session, status: "requested" } as BotSession
  })
  mocks.stopBot.mockResolvedValue({ status: "stopping", raw: {} })
})

afterEach(() => {
  setMemoryBotSessionStore(undefined)
  setBotMeetingLinkLookup(undefined)
  setRouteCtx(undefined)
  vi.unstubAllEnvs()
})

const WEBHOOK_SECRET = "whsec_0123456789abcdef0123456789abcdef"

/** A signed Vexa webhook through the real handler and the test store. */
function vexaWebhook(payload: unknown, enqueue: (...args: unknown[]) => Promise<undefined>) {
  const rawBody = JSON.stringify(payload)
  const now = new Date()
  const ts = String(Math.floor(now.getTime() / 1000))

  return processVexaWebhook(
    {
      headers: new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": signVexaWebhook(WEBHOOK_SECRET, ts, rawBody) }),
      rawBody,
    },
    {
      store,
      config: testBotConfig({ VEXA_WEBHOOK_SECRET: WEBHOOK_SECRET }),
      enqueue: enqueue as never,
      now: () => now,
    }
  )
}

function join(payload: unknown) {
  return joinNow(jsonRequest(`${BASE}/meetings/bot`, "POST", payload), routeParams({}))
}

describe("POST /api/meetings/bot (Join now)", () => {
  it("creates a meeting and a session for a Meet URL (201)", async () => {
    const ctx = await ctxFor()
    const response = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij", title: "Weekly" })
    const json = await body(response)

    expect(response.status).toBe(201)
    expect(json.meeting).toMatchObject({ title: "Weekly" })
    expect(json.session).toMatchObject({ status: "requested", platform: "google_meet", botName: DEFAULT_BOT_RULES.botName })
    expect(mocks.dispatchNow).toHaveBeenCalledTimes(1)

    const meeting = await ctx.meetings.getMeeting((json.meeting as { id: string }).id)

    expect(meeting).toMatchObject({ source: "meeting_bot", ownerUserId: ctx.user?.id })
    expect([...store.sessions.values()][0]).toMatchObject({ origin: "manual", workspaceId: WS })
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bot.join_requested", workspaceId: WS })
    )
  })

  it("accepts Hebrew invite text with a Zoom passcode and never returns the passcode", async () => {
    await ctxFor()
    const response = await join({ text: "להצטרפות (https://zoom.us/j/81234567890?pwd=AbC123) תודה", language: "he" })
    const raw = await response.text()

    expect(response.status).toBe(201)
    expect(raw).not.toMatch(/AbC123|pwd|passcode|canonicalUrl/i)

    const stored = [...store.sessions.values()][0]

    expect(stored.passcodeEnc).toMatch(/^v1:/)
    expect(stored.passcodeEnc).not.toContain("AbC123")
    expect(stored.meetingUrlRedacted).toBe("https://zoom.us/j/81234567890")
    expect(stored.language).toBe("he")
  })

  it("returns 400 invalid_meeting_link with a reason", async () => {
    await ctxFor()

    const response = await join({ meetingUrl: "https://zoom.us/my/dana" })

    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({ error: "invalid_meeting_link", reason: "personal_link" })
    expect(await body(await join({}))).toEqual({ error: "invalid_meeting_link", reason: "no_link" })
  })

  it("rate-limits per user in memory (5/min)", async () => {
    await ctxFor("member", `user_rate_${Date.now()}`)

    for (let index = 0; index < 5; index += 1) {
      expect((await join({ meetingUrl: "nothing here" })).status).toBe(400)
    }

    const limited = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })

    expect(limited.status).toBe(429)
    expect(await body(limited)).toEqual({ error: "bot_rate_limited" })
    expect(limited.headers.get("retry-after")).toBeTruthy()
  })

  it("rate-limits per workspace in the DB", async () => {
    vi.stubEnv("MEETSUM_BOT_JOIN_RATE_PER_HOUR", "2")
    await seedSession({ status: "completed", nativeMeetingId: "aaa-aaaa-aaa" })
    await seedSession({ status: "completed", nativeMeetingId: "bbb-bbbb-bbb" })
    await ctxFor()

    const response = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })

    expect(response.status).toBe(429)
    expect(await body(response)).toEqual({ error: "bot_rate_limited" })
  })

  it("returns 429 bot_capacity when the instance is full", async () => {
    vi.stubEnv("MEETSUM_BOT_MAX_CONCURRENT", "1")
    await seedSession({ workspaceId: "ws_b", meetingId: null, status: "active", nativeMeetingId: "zzz-zzzz-zzz" })
    await ctxFor()

    const response = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })

    expect(response.status).toBe(429)
    expect(await body(response)).toEqual({ error: "bot_capacity" })
  })

  it("reuses the workspace's open session for the same target", async () => {
    const existing = await seedSession({ status: "active" })

    await ctxFor()

    const response = await join({ meetingUrl: "https://meet.google.com/ABC-DEFG-HIJ" })
    const json = await body(response)

    expect(response.status).toBe(200)
    expect(json).toMatchObject({ reused: true, session: { id: existing.id }, meeting: { id: "m_visible" } })
    expect(store.sessions.size).toBe(1)
  })

  it("does not reuse or block on another workspace's live bot for the same link", async () => {
    await seedSession({ workspaceId: "ws_b", meetingId: null, status: "active" })
    await ctxFor()

    const response = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })

    expect(response.status).toBe(201)
    expect(store.sessions.size).toBe(2)
  })

  it("attaches to a visible scheduled calendar meeting with the same link", async () => {
    await ctxFor()

    const response = await join({ meetingUrl: "https://meet.google.com/cal-endr-xyz" })
    const json = await body(response)

    expect(response.status).toBe(201)
    expect(json.meeting).toMatchObject({ id: "m_calendar" })
    expect([...store.sessions.values()][0].meetingId).toBe("m_calendar")
  })

  it("forbids viewers (403)", async () => {
    await ctxFor("viewer")

    expect((await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })).status).toBe(403)
  })

  it("is 404 bot_disabled when the feature is off", async () => {
    vi.stubEnv("MEETSUM_BOT_ENABLED", "false")
    await ctxFor()

    const response = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })

    expect(response.status).toBe(404)
    expect(await body(response)).toEqual({ error: "bot_disabled" })
  })
})

const meetingBotUrl = (id: string) => `${BASE}/meetings/${id}/bot`

describe("/api/meetings/[id]/bot", () => {
  it("GET returns the current session and history without secrets", async () => {
    const session = await seedSession({ status: "active", passcodeEnc: "v1:secret" })

    await ctxFor()

    const response = await getMeetingBot(new Request(meetingBotUrl("m_visible")), routeParams({ id: "m_visible" }))
    const raw = await response.text()
    const json = JSON.parse(raw) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(json).toMatchObject({ session: { id: session.id, status: "active" }, canSend: false })
    expect(raw).not.toMatch(/passcode|v1:secret|nativeMeetingId/)
  })

  it("is 404 for invisible meetings (private, other workspace) on every method", async () => {
    await seedSession({ meetingId: "m_private", status: "active" })
    await ctxFor()

    for (const id of ["m_private", "m_other_ws", "missing"]) {
      const params = routeParams({ id })

      expect((await getMeetingBot(new Request(meetingBotUrl(id)), params)).status).toBe(404)
      expect((await sendBot(jsonRequest(meetingBotUrl(id), "POST", {}), params)).status).toBe(404)
      expect((await stopBot(new Request(meetingBotUrl(id), { method: "DELETE" }), params)).status).toBe(404)
    }
    expect(mocks.stopBot).not.toHaveBeenCalled()
  })

  it("forbids viewers from sending or stopping (403)", async () => {
    await ctxFor("viewer")

    const params = routeParams({ id: "m_visible" })

    expect((await getMeetingBot(new Request(meetingBotUrl("m_visible")), params)).status).toBe(200)
    expect((await sendBot(jsonRequest(meetingBotUrl("m_visible"), "POST", {}), params)).status).toBe(403)
    expect((await stopBot(new Request(meetingBotUrl("m_visible"), { method: "DELETE" }), params)).status).toBe(403)
  })

  it("POST schedules a future meeting and dispatches a current one", async () => {
    await ctxFor()

    const future = await sendBot(
      jsonRequest(meetingBotUrl("m_future"), "POST", { meetingUrl: "https://meet.google.com/fut-urer-mtg" }),
      routeParams({ id: "m_future" })
    )

    expect(future.status).toBe(201)
    expect(await body(future)).toMatchObject({ session: { status: "scheduled" } })
    expect(mocks.scheduleDispatch).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchNow).not.toHaveBeenCalled()

    const now = await sendBot(
      jsonRequest(meetingBotUrl("m_visible"), "POST", { meetingUrl: "https://meet.google.com/abc-defg-hij" }),
      routeParams({ id: "m_visible" })
    )

    expect(now.status).toBe(201)
    expect(mocks.dispatchNow).toHaveBeenCalledTimes(1)
    expect([...store.sessions.values()].map((session) => session.origin)).toEqual([
      "meeting_request",
      "meeting_request",
    ])
  })

  it("POST without any link is 400 bot_no_link", async () => {
    await ctxFor()

    const response = await sendBot(jsonRequest(meetingBotUrl("m_visible"), "POST", {}), routeParams({ id: "m_visible" }))

    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({ error: "bot_no_link" })
  })

  it("POST reopens a calendar opt-out with a bumped rev", async () => {
    const optedOut = await seedSession({
      meetingId: "m_calendar",
      origin: "calendar_rule",
      calendarEventId: "gcal_1",
      nativeMeetingId: "cal-endr-xyz",
      status: "cancelled",
      statusReason: "user_opt_out",
    })

    await ctxFor()

    const response = await sendBot(jsonRequest(meetingBotUrl("m_calendar"), "POST", {}), routeParams({ id: "m_calendar" }))

    expect(response.status).toBe(201)
    // Starts in 30 min (beyond the 60 s lead): scheduled again, not dispatched.
    expect(store.sessions.get(optedOut.id)).toMatchObject({
      status: "scheduled",
      dispatchRev: 1,
      statusReason: null,
    })
    expect(mocks.scheduleDispatch).toHaveBeenCalledWith(expect.objectContaining({ id: optedOut.id, dispatchRev: 1 }))
    expect(store.sessions.size).toBe(1)
  })

  it("DELETE opts out of a scheduled bot and removes its job", async () => {
    const session = await seedSession({ meetingId: "m_future", status: "scheduled" })

    await ctxFor()

    const response = await stopBot(new Request(meetingBotUrl("m_future"), { method: "DELETE" }), routeParams({ id: "m_future" }))

    expect(response.status).toBe(200)
    expect(store.sessions.get(session.id)).toMatchObject({ status: "cancelled", statusReason: "user_opt_out" })
    expect(mocks.removeBotJob).toHaveBeenCalledWith(`bot.dispatch:${session.id}:0`)
    expect(mocks.stopBot).not.toHaveBeenCalled()
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "bot.cancelled" }))
  })

  it("DELETE stops a live bot through the provider", async () => {
    const session = await seedSession({ status: "active" })

    await ctxFor()

    const response = await stopBot(new Request(meetingBotUrl("m_visible"), { method: "DELETE" }), routeParams({ id: "m_visible" }))

    expect(response.status).toBe(200)
    expect(mocks.stopBot).toHaveBeenCalledWith("google_meet", "abc-defg-hij")
    expect(store.sessions.get(session.id)).toMatchObject({ status: "stopping", statusReason: "user_stopped" })
  })

  it("a stop while awaiting admission ends cancelled/user_stopped after Vexa completes, with no finalize", async () => {
    const session = await seedSession({ status: "awaiting_admission" })

    await store.update(session.id, { vexaMeetingId: "4242" }, { workspaceId: WS })
    await ctxFor()

    const stopped = await stopBot(new Request(meetingBotUrl("m_visible"), { method: "DELETE" }), routeParams({ id: "m_visible" }))

    expect(stopped.status).toBe(200)
    expect(store.sessions.get(session.id)).toMatchObject({ status: "stopping", statusReason: "user_stopped" })

    const enqueue = vi.fn(async () => undefined)
    const result = await vexaWebhook({ event_type: "meeting.completed", data: { meeting: { id: 4242, status: "completed" } } }, enqueue)

    expect(result).toMatchObject({ status: 200, body: { applied: true } })
    expect(store.sessions.get(session.id)).toMatchObject({ status: "cancelled", statusReason: "user_stopped", joinedAt: null })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("DELETE on a terminal session is 409", async () => {
    await seedSession({ status: "completed" })
    await ctxFor()

    const response = await stopBot(new Request(meetingBotUrl("m_visible"), { method: "DELETE" }), routeParams({ id: "m_visible" }))

    expect(response.status).toBe(409)
    expect(await body(response)).toEqual({ error: "bot_session_terminal" })
  })
})

describe("GET /api/bot/sessions", () => {
  it("returns the newest session per meeting, only for visible meetings", async () => {
    await seedSession({ meetingId: "m_visible", status: "completed", nativeMeetingId: "old-oldd-old" })
    const newest = await seedSession({ meetingId: "m_visible", status: "active" })
    await seedSession({ meetingId: "m_private", status: "active", nativeMeetingId: "prv-prvv-prv" })
    await seedSession({ workspaceId: "ws_b", meetingId: "m_other_ws", status: "active" })
    await ctxFor()

    const response = await listSessions(new Request(`${BASE}/bot/sessions?active=1`), routeParams({}))
    const json = await body(response)

    expect(Object.keys(json.byMeetingId as object)).toEqual(["m_visible"])
    expect((json.byMeetingId as Record<string, { id: string }>).m_visible.id).toBe(newest.id)
  })
})

describe("GET /api/bot/status", () => {
  it("requires ops:read and reports capacity", async () => {
    await ctxFor("member")
    expect((await botStatus(new Request(`${BASE}/bot/status`), routeParams({}))).status).toBe(403)

    await ctxFor("admin")

    const response = await botStatus(new Request(`${BASE}/bot/status`), routeParams({}))

    expect(await body(response)).toMatchObject({
      enabled: true,
      healthy: true,
      vexaVersion: "0.12.28",
      capacity: { max: 2, perWorkspace: 2 },
    })
  })
})

describe("/api/settings/bot", () => {
  it("GET reports enabled:false when the feature is off", async () => {
    vi.stubEnv("MEETSUM_BOT_ENABLED", "false")
    await ctxFor("viewer")

    expect(await body(await getSettings(new Request(`${BASE}/settings/bot`), routeParams({})))).toEqual({
      enabled: false,
    })
  })

  it("GET returns rules with editable by role", async () => {
    await ctxFor("member")

    expect(await body(await getSettings(new Request(`${BASE}/settings/bot`), routeParams({})))).toMatchObject({
      enabled: true,
      editable: false,
      rules: { autoJoin: "off" },
    })
  })

  it("PUT enforces the consent acknowledgment gate", async () => {
    mocks.updateBotRules.mockRejectedValueOnce(
      Object.assign(new Error("consent required"), { code: "consent_ack_required" })
    )
    await ctxFor("admin")

    const response = await putSettings(
      jsonRequest(`${BASE}/settings/bot`, "PUT", { autoJoin: "all" }),
      routeParams({})
    )

    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({ error: "consent_ack_required" })
    expect(mocks.enqueueBotJob).not.toHaveBeenCalled()
  })

  it("PUT returns per-field validation errors", async () => {
    mocks.updateBotRules.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), { fields: { botName: "too_long" } })
    )
    await ctxFor("admin")

    const response = await putSettings(jsonRequest(`${BASE}/settings/bot`, "PUT", { botName: "x".repeat(99) }), routeParams({}))

    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({ error: "validation_failed", fields: { botName: "too_long" } })
  })

  it("PUT saves, enqueues a rules resync and audits the acknowledgment", async () => {
    mocks.updateBotRules.mockResolvedValueOnce({
      ...DEFAULT_BOT_RULES,
      autoJoin: "all",
      consentAcknowledgedAt: "2026-10-13T10:00:00.000Z",
      consentAcknowledgedByUserId: "user_admin",
    })
    await ctxFor("admin")

    const response = await putSettings(
      jsonRequest(`${BASE}/settings/bot`, "PUT", { autoJoin: "all", acknowledgeConsent: true }),
      routeParams({})
    )

    expect(response.status).toBe(200)
    expect(mocks.enqueueBotJob).toHaveBeenCalledWith(
      "bot.reconcile",
      { workspaceId: WS, resyncRules: true },
      expect.objectContaining({ jobId: expect.stringContaining(`bot.reconcile:rules:${WS}`) })
    )
    expect(mocks.recordAuditLog.mock.calls.map((call) => (call[0] as { action: string }).action)).toEqual([
      "bot.rules.updated",
      "bot.consent.acknowledged",
    ])
  })

  it("PUT requires settings:write", async () => {
    await ctxFor("member")

    expect((await putSettings(jsonRequest(`${BASE}/settings/bot`, "PUT", {}), routeParams({}))).status).toBe(403)
  })
})

describe("cross-tenant authorization (W1/W2)", () => {
  // W2 sessions deliberately reuse W1's meeting id and link: only the
  // caller's workspace (and meeting visibility) may decide what is seen.
  async function seedW2(status: "scheduled" | "active") {
    return seedSession({ workspaceId: "ws_b", meetingId: "m_visible", status })
  }

  it("list never returns another workspace's session, even for the same meeting id", async () => {
    await seedW2("active")
    await ctxFor()

    const json = await body(await listSessions(new Request(`${BASE}/bot/sessions?active=1`), routeParams({})))

    expect(json.byMeetingId).toEqual({})
  })

  it("get shows neither the session nor the history of another workspace", async () => {
    await seedW2("active")
    await ctxFor()

    const json = await body(
      await getMeetingBot(new Request(meetingBotUrl("m_visible")), routeParams({ id: "m_visible" }))
    )

    expect(json.session).toBeUndefined()
    expect(json.history).toEqual([])
    expect(json.canSend).toBe(true)
  })

  it("stop (cancel) cannot reach another workspace's live bot: 404, provider untouched", async () => {
    const w2 = await seedW2("active")
    const before = structuredClone(store.sessions.get(w2.id))
    await ctxFor()

    const response = await stopBot(
      new Request(meetingBotUrl("m_visible"), { method: "DELETE" }),
      routeParams({ id: "m_visible" })
    )

    expect(response.status).toBe(404)
    expect(mocks.stopBot).not.toHaveBeenCalled()
    expect(store.sessions.get(w2.id)).toEqual(before)
  })

  it("opt-out cannot cancel another workspace's scheduled bot", async () => {
    const w2 = await seedW2("scheduled")
    const before = structuredClone(store.sessions.get(w2.id))
    await ctxFor()

    const response = await stopBot(
      new Request(meetingBotUrl("m_visible"), { method: "DELETE" }),
      routeParams({ id: "m_visible" })
    )

    expect(response.status).toBe(404)
    expect(mocks.removeBotJob).not.toHaveBeenCalled()
    expect(store.sessions.get(w2.id)).toEqual(before)
  })

  it("opt-out and stop on a private meeting of the caller's own workspace are 404", async () => {
    const scheduled = await seedSession({ meetingId: "m_private", status: "scheduled" })
    const before = structuredClone(store.sessions.get(scheduled.id))
    await ctxFor("admin")

    const response = await stopBot(
      new Request(meetingBotUrl("m_private"), { method: "DELETE" }),
      routeParams({ id: "m_private" })
    )

    expect(response.status).toBe(404)
    expect(store.sessions.get(scheduled.id)).toEqual(before)
  })

  it("join now never reuses, returns or dispatches another workspace's session", async () => {
    const w2 = await seedW2("active")
    await ctxFor()

    const response = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })
    const json = await body(response)

    expect(response.status).toBe(201)
    expect((json.session as { id: string }).id).not.toBe(w2.id)
    expect(json.reused).toBeUndefined()
    expect(mocks.dispatchNow).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchNow.mock.calls[0][0]).toMatchObject({ workspaceId: WS })
    expect(store.sessions.get(w2.id)?.status).toBe("active")
  })
})
