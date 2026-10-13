import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const enqueueBotJob = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@/lib/bot/queue", () => ({ enqueueBotJob, removeBotJob: vi.fn(async () => undefined) }))

import { POST } from "@/app/api/integrations/vexa/webhook/route"
import { setMemoryBotSessionStore } from "@/lib/bot/store"
import { createMemoryBotSessionStore, type MemoryBotSessionStore } from "@/lib/bot/store-memory"
import { signVexaWebhook } from "@/lib/bot/webhook-verify"

/**
 * M7 B3 route: signature, gate, size cap, dedupe, unknown sessions,
 * finalize-once, never-admitted, cross-workspace isolation, payload redaction.
 */

const SECRET = "whsec_0123456789abcdef0123456789abcdef"
const URL_ = "http://localhost/api/integrations/vexa/webhook"
const route = { params: Promise.resolve({}) }

function fixture(name: string): string {
  return readFileSync(`tests/fixtures/vexa/webhooks/${name}.json`, "utf8")
}

function signed(body: string, options: { secret?: string; headers?: Record<string, string> } = {}) {
  const ts = String(Math.floor(Date.now() / 1000))

  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": ts,
      "x-webhook-signature": signVexaWebhook(options.secret ?? SECRET, ts, body),
      ...options.headers,
    },
    body,
  })
}

let store: MemoryBotSessionStore

async function seed(workspaceId: string, overrides: { vexaMeetingId?: string | null; status?: "requested" | "active" } = {}) {
  const session = await store.create({
    workspaceId,
    meetingId: `meet_${workspaceId}`,
    origin: "manual",
    platform: "google_meet",
    nativeMeetingId: "abc-defg-hij",
    botName: "MeetSum Notetaker",
    status: overrides.status ?? "requested",
  })

  if (overrides.vexaMeetingId !== null) {
    await store.update(session.id, { vexaMeetingId: overrides.vexaMeetingId ?? "4242" }, { workspaceId })
  }

  return session
}

async function send(name: string, options?: Parameters<typeof signed>[1]) {
  const response = await POST(signed(fixture(name), options), route)

  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

beforeEach(() => {
  store = createMemoryBotSessionStore()
  setMemoryBotSessionStore(store)
  enqueueBotJob.mockClear()
  vi.stubEnv("MEETSUM_STORAGE", "memory")
  vi.stubEnv("MEETSUM_BOT_ENABLED", "true")
  vi.stubEnv("VEXA_WEBHOOK_SECRET", SECRET)
  vi.stubEnv("VEXA_WEBHOOK_ALLOW_BEARER", "false")
})

afterEach(() => {
  setMemoryBotSessionStore(undefined)
  vi.unstubAllEnvs()
})

describe("POST /api/integrations/vexa/webhook", () => {
  it("returns 401 without detail for a bad signature", async () => {
    await seed("ws_1")
    const result = await send("status-joining", { secret: "wrong-secret-wrong-secret-wrong!" })

    expect(result).toEqual({ status: 401, body: { error: "unauthorized" } })
    expect(store.events).toHaveLength(0)
  })

  it("returns 401 for a Bearer token unless explicitly allowed", async () => {
    await seed("ws_1")
    const bearer = () =>
      new Request(URL_, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
        body: fixture("status-joining"),
      })

    expect((await POST(bearer(), route)).status).toBe(401)
    vi.stubEnv("VEXA_WEBHOOK_ALLOW_BEARER", "true")
    expect((await POST(bearer(), route)).status).toBe(200)
  })

  it("returns 503 when the bot is disabled or the secret is missing", async () => {
    vi.stubEnv("MEETSUM_BOT_ENABLED", "false")
    expect((await send("status-joining")).status).toBe(503)
    vi.stubEnv("MEETSUM_BOT_ENABLED", "true")
    vi.stubEnv("VEXA_WEBHOOK_SECRET", "")
    expect((await send("status-joining")).status).toBe(503)
  })

  it("returns 413 above 256 KB", async () => {
    const big = JSON.stringify({ event_type: "x", pad: "a".repeat(300 * 1024) })

    expect((await POST(signed(big), route)).status).toBe(413)
    expect(
      (await POST(signed("{}", { headers: { "content-length": String(400 * 1024) } }), route)).status
    ).toBe(413)
  })

  it("answers an unknown meeting with a 200 no-op and records nothing", async () => {
    const result = await send("status-joining")

    expect(result).toEqual({ status: 200, body: { ignored: true } })
    expect(store.events).toHaveLength(0)
  })

  it("applies a delivery once and answers duplicates with 200", async () => {
    const session = await seed("ws_1")
    const first = await send("status-joining")
    const again = await send("status-joining")

    expect(first).toEqual({ status: 200, body: { ok: true, applied: true } })
    expect(again).toEqual({ status: 200, body: { duplicate: true } })
    expect((await store.get(session.id, { workspaceId: "ws_1" }))?.status).toBe("joining")
    expect(store.events.filter((event) => event.applied)).toHaveLength(1)
  })

  it("enqueues finalize exactly once for the completed fixture", async () => {
    const session = await seed("ws_1")

    for (const name of ["status-joining", "status-awaiting_admission", "status-active", "completed", "completed"]) {
      await send(name)
    }

    // A re-delivery with a fresh event id is still the same (meeting, status) event.
    const replay = fixture("completed").replace("evt_completed", "evt_completed_again")
    const replayResponse = await POST(signed(replay), route)

    expect(await replayResponse.json()).toEqual({ duplicate: true })

    const finalizeCalls = enqueueBotJob.mock.calls.filter((call) => (call as unknown[])[0] === "bot.finalize")

    expect(finalizeCalls).toEqual([
      ["bot.finalize", { sessionId: session.id, workspaceId: "ws_1" }, { jobId: `bot.finalize:${session.id}`, attempts: 8 }],
    ])
    expect(enqueueBotJob.mock.calls.filter((call) => (call as unknown[])[0] === "bot.consent")).toHaveLength(1)

    const completed = await store.get(session.id, { workspaceId: "ws_1" })

    expect(completed).toMatchObject({ status: "completed", statusReason: null })
    const stored = store.events.find((event) => event.eventType === "meeting.completed")

    expect(JSON.stringify(stored?.payload)).not.toContain("must-not-be-stored")
    expect((stored?.payload.data as Record<string, unknown>).meeting).toMatchObject({
      data: { service_provenance: { bot_outcome: "served" } },
    })
  })

  it("blocks a never-admitted bot without finalize", async () => {
    const session = await seed("ws_1")

    await send("status-awaiting_admission")
    await send("completed-never-admitted")

    expect(await store.get(session.id, { workspaceId: "ws_1" })).toMatchObject({
      status: "blocked",
      statusReason: "not_admitted",
    })
    expect(enqueueBotJob).not.toHaveBeenCalledWith("bot.finalize", expect.anything(), expect.anything())
  })

  it("strips URL queries from stored payloads", async () => {
    await seed("ws_1")
    await send("status-joining")

    expect(JSON.stringify(store.events[0].payload)).not.toContain("token=leak")
    expect(JSON.stringify(store.events[0].payload)).toContain("https://meet.google.com/abc-defg-hij")
  })

  it("never lets a payload address another workspace's session", async () => {
    const w1 = await seed("ws_1")
    const w2 = await seed("ws_2", { vexaMeetingId: "9999" })
    const before = structuredClone(store.sessions.get(w2.id))
    const body = JSON.stringify({
      event_type: "meeting.status_change",
      event_id: "evt_cross",
      workspace_id: "ws_2",
      bot_session_id: w2.id,
      data: { meeting: { id: 4242, platform: "google_meet", native_meeting_id: "abc-defg-hij", status: "active" } },
    })

    expect((await POST(signed(body), route)).status).toBe(200)
    expect((await store.get(w1.id, { workspaceId: "ws_1" }))?.status).toBe("active")
    expect(store.sessions.get(w2.id)).toEqual(before)

    // Target-only payload while both workspaces have open sessions: ignored.
    const targetOnly = JSON.stringify({
      event_type: "meeting.status_change",
      data: { meeting: { platform: "google_meet", native_meeting_id: "abc-defg-hij", status: "stopping" } },
    })
    const response = await POST(signed(targetOnly), route)

    expect(await response.json()).toEqual({ ignored: true })
    expect(store.sessions.get(w2.id)).toEqual(before)
  })

  it("maps bot.failed zoom_requires_rtms to blocked/platform_blocked", async () => {
    const session = await store.create({
      workspaceId: "ws_1",
      origin: "manual",
      platform: "zoom",
      nativeMeetingId: "81234567890",
      botName: "MeetSum Notetaker",
      status: "requested",
    })

    await store.update(session.id, { vexaMeetingId: "4343" }, { workspaceId: "ws_1" })
    await send("bot-failed-rtms")

    expect(await store.get(session.id, { workspaceId: "ws_1" })).toMatchObject({
      status: "blocked",
      statusReason: "platform_blocked",
    })
  })
})
